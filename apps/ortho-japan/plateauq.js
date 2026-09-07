// PLATEAU 焼き済みバッチの量子化形式（PLQ1・2026-09-07）＝「Cloudflare（R2）に GPU 直行形式を置く」の器。
// plateauworker（ブラウザ）と scripts/bake-plateau.mjs（Node）が同じ pack/unpack を共有＝経路差ゼロ。
// 対象は decodeBatch の出力 { pos:f32×3(origin相対), nrm:i8×4, idx:u32, origin, bbox, lodH, lodCounts, twoSided, maskCells }
// ＝接地・dedup・LOD 並べ替え・RTE まで済んだ「GPU に上げるだけ」のメッシュ。復元側は unpack → 従来の finishBatch へ。
//
// レイアウト（リトルエンディアン）: [u32 MAGIC][u32 jsonLen][json utf8][pad→4B][pos varint 列][nrm i8×3×nv][idx varint 列(explicit時)]
// ・pos: 頂点ごとにバッチ bbox で u16 量子化（qmin+q·scale）＝1バッチ（32タイル≈1〜2km）で 2〜3cm 刻み。
//   前頂点との差分を zigzag varint で書く＝同一建物の頂点は近接＝1〜2B/成分。gzip（配信の Content-Encoding）がさらに効く。
// ・idx: 既定は溶接（weldMesh＝位置+法線一致の頂点を束ねる・頂点 4〜5 割減）→ 共有頂点＝idx を差分 varint で持つ（explicit）。
//   溶接の効かないメッシュ（頂点が三角形ごとに非共有のまま・PLATEAU の Draco 出力は本来 nv≈3·nt）は三角形順に並べ直して
//   idx=0,1,2,…（iota＝index を持たない）。復元側は両レイアウトを読む。
// ・nrm: i8×3（pad 無し）。復元時に 4B ストライドへ戻す（renderer の入力形は不変）。
// ・lodCounts は index 数＝三角形の並びを変えないので iota 化しても不変。maskCells は json 同乗。
// 形式版 PLQ_VER＝レイアウトを変えたら上げる（マニフェストと突合＝旧焼きは黙って無視→生経路）。
// デコードパイプライン（接地・dedup 等）の版は IDB_FMT_VER（plateauworker）＝焼きの置き場 v{n}/ に刻む。
export const PLQ_VER = 1;
const MAGIC = 0x31514c50;   // "PLQ1"

// 焼きの置き場（R2 キー）＝base URL から機械的に導く＝索引ファイル不要（1往復節約）。
//   https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13103-bldg-lod2-notexture-latest/
//   → api.plateauview.mlit.go.jp_datacatalog_3dtiles_13103-bldg-lod2-notexture-latest
export function bakeSlug(base) {
	return base.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_");
}
// 球（既定）と楕円体（?ell=1）は座標が違う＝別焼き・別置き場（…/ell/）。fmtVer＝plateaudecode.DECODE_VER
export const bakeDir = (base, fmtVer, ell = false) => `v${fmtVer}/${bakeSlug(base)}/${ell ? "ell/" : ""}`;

const zig = v => (v << 1) ^ (v >> 31);            // zigzag（|v| < 2^30 前提＝u16 差分・index 差分とも収まる）
const unzig = u => (u >>> 1) ^ -(u & 1);

// varint 書き手＝伸びる Uint8Array（サイズ未知のストリーム用）
class Out {
	constructor(cap) { this.b = new Uint8Array(cap); this.n = 0; }
	grow() { const nb = new Uint8Array(this.b.length * 2); nb.set(this.b); this.b = nb; }
	varint(u) {   // u: 非負 32bit
		while (u >= 0x80) { if (this.n >= this.b.length) this.grow(); this.b[this.n++] = (u & 0x7f) | 0x80; u >>>= 7; }
		if (this.n >= this.b.length) this.grow();
		this.b[this.n++] = u;
	}
	bytes() { return this.b.subarray(0, this.n); }
}

// ── 頂点溶接（2026-09-07・本人号令「頂点を減らすのは変換にも描画にも効く」）──
// 位置（格子量子化）と法線（i8×3）が完全に一致する頂点を 1 つに束ねる＝描画結果は同一（フラットシェーディングの法線は
// 頂点に載っているので、面ごとの法線が違う角はそのまま別頂点＝箱 1 棟 36→24 頂点、屋根付きは実測 48% 減）。
// 効き：GPU の pos/nrm バイト・PLQ サイズ（gzip 後 3 割減）・頂点シェーダ回数。焼き（packPLQ）と生経路（decodeBatch 末尾）で共用。
// 探索は Int32Array の開番地ハッシュ（Map の百万エントリはヒープを数百MB食う＝iOS/lowMem の轍）＝一時 ~30B/頂点。
// 三角形順に初出頂点を採番＝局所性が良く index の差分 varint が小さい。未参照頂点（dedup で消えた三角形の分）はここで落ちる。
// grid＝格子刻み（単位球座標）。null＝bbox/65535（PLQ の量子化と同じ＝焼きでは保存精度そのもの）。効きが 15% 未満なら元を返す。
export function weldMesh(mesh, grid = null) {
	const { pos, nrm, idx } = mesh;
	const nv = pos.length / 3;
	if (!nv || !idx.length) return mesh;
	const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { const p = pos[i + a]; if (p < mn[a]) mn[a] = p; if (p > mx[a]) mx[a] = p; }
	const inv = grid ? [1 / grid, 1 / grid, 1 / grid] : [0, 1, 2].map(a => 65535 / ((mx[a] - mn[a]) || 1e-12));
	const q = new Int32Array(nv * 3);
	for (let i = 0; i < nv; i++) for (let a = 0; a < 3; a++) q[i * 3 + a] = Math.round((pos[i * 3 + a] - mn[a]) * inv[a]);
	let cap = 1; while (cap < nv * 2) cap <<= 1;
	const table = new Int32Array(cap).fill(-1), hm = cap - 1;
	const remap = new Int32Array(nv).fill(-1), first = new Int32Array(nv);   // first[j]＝出力頂点 j の元頂点
	let out = 0;
	const nidx = new Uint32Array(idx.length);
	for (let k = 0; k < idx.length; k++) {
		const v = idx[k];
		let j = remap[v];
		if (j < 0) {
			const x = q[v * 3], y = q[v * 3 + 1], z = q[v * 3 + 2], n = ((nrm[v * 4] & 255) << 16) | ((nrm[v * 4 + 1] & 255) << 8) | (nrm[v * 4 + 2] & 255);
			let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(n, 0x9e3779b1)) & hm;
			for (;;) {
				const c = table[h];
				if (c < 0) { table[h] = out; first[out] = v; j = out++; break; }
				const s = first[c];
				if (q[s * 3] === x && q[s * 3 + 1] === y && q[s * 3 + 2] === z && nrm[s * 4] === nrm[v * 4] && nrm[s * 4 + 1] === nrm[v * 4 + 1] && nrm[s * 4 + 2] === nrm[v * 4 + 2]) { j = c; break; }
				h = (h + 1) & hm;
			}
			remap[v] = j;
		}
		nidx[k] = j;
	}
	if (out > nv * 0.85) return mesh;   // 効きが薄い＝コピーもしない（既に溶接済み・共有頂点メッシュ等）
	const npos = new Float32Array(out * 3), nnrm = new Int8Array(out * 4);
	for (let j = 0; j < out; j++) { const v = first[j]; npos[j * 3] = pos[v * 3]; npos[j * 3 + 1] = pos[v * 3 + 1]; npos[j * 3 + 2] = pos[v * 3 + 2]; nnrm[j * 4] = nrm[v * 4]; nnrm[j * 4 + 1] = nrm[v * 4 + 1]; nnrm[j * 4 + 2] = nrm[v * 4 + 2]; }
	return { ...mesh, pos: npos, nrm: nnrm, idx: nidx };
}

// 三角形順に頂点を並べ直せるか＝参照頂点の重複が少ないか（並べ直しは共有頂点を複製する＝増える分が 20% 超なら explicit）
function planLayout(idx, nv) {
	const seen = new Uint8Array(nv);
	let distinct = 0;
	for (let k = 0; k < idx.length; k++) { const v = idx[k]; if (!seen[v]) { seen[v] = 1; distinct++; } }
	return { iota: idx.length <= distinct * 1.2, distinct, seen };
}

export function packPLQ(mesh, opts = {}) {
	if (opts.weld !== false) mesh = weldMesh(mesh);   // 既定＝溶接（保存精度の格子で束ねる＝最大の効き）
	const { pos, nrm, idx } = mesh;
	const nvSrc = pos.length / 3, nt = idx.length / 3;
	const plan = planLayout(idx, nvSrc);
	// 出力頂点の並び：iota＝idx 順（複製込み）／explicit＝元順の参照頂点だけ（未参照は落とし idx を詰め直す）
	let order;   // 出力頂点 j → 元頂点番号
	let idxOut = null;
	if (plan.iota) { order = idx; }
	else {
		const remap = new Int32Array(nvSrc).fill(-1);
		order = new Uint32Array(plan.distinct);
		let j = 0;
		for (let v = 0; v < nvSrc; v++) if (plan.seen[v]) { remap[v] = j; order[j++] = v; }
		idxOut = new Uint32Array(idx.length);
		for (let k = 0; k < idx.length; k++) idxOut[k] = remap[idx[k]];
	}
	const nv = order.length;
	// 量子化範囲＝出力頂点の bbox
	const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
	for (let j = 0; j < nv; j++) { const v = order[j] * 3; for (let a = 0; a < 3; a++) { const p = pos[v + a]; if (p < mn[a]) mn[a] = p; if (p > mx[a]) mx[a] = p; } }
	const scale = [0, 1, 2].map(a => (mx[a] - mn[a]) / 65535 || 1e-12);
	const inv = scale.map(s => 1 / s);
	// pos＝前頂点との差分 zigzag varint（成分ごと）
	const out = new Out(Math.max(64, nv * 4));
	let px = 0, py = 0, pz = 0;
	for (let j = 0; j < nv; j++) {
		const v = order[j] * 3;
		const qx = Math.round((pos[v] - mn[0]) * inv[0]), qy = Math.round((pos[v + 1] - mn[1]) * inv[1]), qz = Math.round((pos[v + 2] - mn[2]) * inv[2]);
		out.varint(zig(qx - px)); out.varint(zig(qy - py)); out.varint(zig(qz - pz));
		px = qx; py = qy; pz = qz;
	}
	const posBytes = out.bytes();
	// nrm＝i8×3（pad 落とし）
	const nrmBytes = new Int8Array(nv * 3);
	for (let j = 0; j < nv; j++) { const s = order[j] * 4, d = j * 3; nrmBytes[d] = nrm[s]; nrmBytes[d + 1] = nrm[s + 1]; nrmBytes[d + 2] = nrm[s + 2]; }
	// idx（explicit のみ）＝差分 zigzag varint
	let idxBytes = null;
	if (idxOut) {
		const o = new Out(Math.max(64, idxOut.length * 2));
		let prev = 0;
		for (let k = 0; k < idxOut.length; k++) { o.varint(zig(idxOut[k] - prev)); prev = idxOut[k]; }
		idxBytes = o.bytes();
	}
	const head = {
		origin: mesh.origin, bbox: mesh.bbox, lodH: mesh.lodH, lodCounts: mesh.lodCounts, twoSided: mesh.twoSided || 0,
		cells: mesh.maskCells ? Array.from(mesh.maskCells) : null,
		nv, nt, qmin: mn, qscale: scale, idx: idxOut ? "explicit" : "iota",
	};
	const json = new TextEncoder().encode(JSON.stringify(head));
	const start = dataStart(json.length);
	const total = start + posBytes.length + nrmBytes.length + (idxBytes ? idxBytes.length : 0);
	const u8 = new Uint8Array(total);
	const dv = new DataView(u8.buffer);
	dv.setUint32(0, MAGIC, true); dv.setUint32(4, json.length, true);
	u8.set(json, 8);
	let o = start;
	u8.set(posBytes, o); o += posBytes.length;
	u8.set(new Uint8Array(nrmBytes.buffer), o); o += nrmBytes.length;
	if (idxBytes) u8.set(idxBytes, o);
	return u8;
}
const dataStart = jsonLen => { const h = 8 + jsonLen; return h + ((4 - h % 4) % 4); };

// 復元＝decodeBatch と同じ形のメッシュ（pos f32・nrm i8×4・idx u32）。壊れ/形式違いは null（呼び出し側が生経路へ）。
export function unpackPLQ(u8) {
	if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
	if (u8.length < 8) return null;
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (dv.getUint32(0, true) !== MAGIC) return null;
	const jl = dv.getUint32(4, true);
	let h;
	try { h = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + jl))); } catch { return null; }
	const nv = h.nv | 0, nt = h.nt | 0;
	if (!(nv > 0) || !(nt > 0) || !h.qmin || !h.qscale) return null;
	let p = dataStart(jl);
	const readVarint = () => {   // 1〜5B（呼び出し側のループで inline 化されない分は許容＝2M 回で数ms）
		let u = 0, shift = 0, b;
		do { if (p >= u8.length) throw new RangeError("plq truncated"); b = u8[p++]; u |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
		return u >>> 0;
	};
	const pos = new Float32Array(nv * 3);
	const [m0, m1, m2] = h.qmin, [s0, s1, s2] = h.qscale;
	try {
		let qx = 0, qy = 0, qz = 0;
		for (let j = 0; j < nv; j++) {
			qx += unzig(readVarint()); qy += unzig(readVarint()); qz += unzig(readVarint());
			const d = j * 3;
			pos[d] = m0 + qx * s0; pos[d + 1] = m1 + qy * s1; pos[d + 2] = m2 + qz * s2;
		}
		if (p + nv * 3 > u8.length) return null;
		const nrm = new Int8Array(nv * 4);
		const src = new Int8Array(u8.buffer, u8.byteOffset + p, nv * 3);
		for (let j = 0; j < nv; j++) { const s = j * 3, d = j * 4; nrm[d] = src[s]; nrm[d + 1] = src[s + 1]; nrm[d + 2] = src[s + 2]; }
		p += nv * 3;
		const idx = new Uint32Array(nt * 3);
		if (h.idx === "explicit") { let prev = 0; for (let k = 0; k < idx.length; k++) { prev += unzig(readVarint()); idx[k] = prev; } }
		else for (let k = 0; k < idx.length; k++) idx[k] = k;
		return {
			pos, nrm, idx, origin: h.origin, bbox: h.bbox, lodH: h.lodH, lodCounts: h.lodCounts, twoSided: h.twoSided || 0,
			maskCells: h.cells ? Uint32Array.from(h.cells) : null,
		};
	} catch { return null; }
}
