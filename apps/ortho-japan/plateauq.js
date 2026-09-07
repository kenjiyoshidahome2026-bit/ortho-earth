// PLATEAU 焼き済みバッチの量子化形式（PLQ・2026-09-07）＝「Cloudflare（R2）に GPU 直行形式を置く」の器。
// plateauworker（ブラウザ）と scripts/bake-plateau.mjs（Node）が同じ pack/unpack を共有＝経路差ゼロ。
// 対象は decodeBatch の出力 { pos:f32×3(origin相対), nrm:i8×4, idx:u32, origin, bbox, lodH, lodCounts, twoSided, maskCells }
// ＝接地・dedup・LOD 並べ替え・RTE まで済んだ「GPU に上げるだけ」のメッシュ。復元側は unpack → 従来の finishBatch へ。
//
// PLQ2 レイアウト（リトルエンディアン）: [u32 MAGIC][u32 jsonLen][json utf8][pad→4B][メッシュ部: pos varint 列][nrm i8×3×nv][idx varint 列]
//                                       [角柱部（json.prisms が示す本数）]
// ・メッシュ部（角柱にならなかった建物＝勾配屋根・複雑形状）:
//   pos は頂点ごとにバッチ bbox で u16 量子化（qmin+q·scale）＝1バッチ（32タイル≈1〜2km）で 2〜3cm 刻み、前頂点との差分を
//   zigzag varint。nrm は i8×3（pad 無し・復元時に 4B ストライドへ）。idx は既定で溶接（weldMesh＝位置+法線一致の頂点を束ねる・
//   4〜5 割減）済みの共有頂点＝差分 varint（explicit）。溶接の効かないメッシュは三角形順に並べて idx=0,1,2,…（iota）。
// ・角柱部（本人号令 2026-09-07「底面＋高さ」）: LOD2 と名乗る 188 セット中 162 は勾配屋根ゼロ＝箱。箱 1 棟はメッシュだと
//   溶接後でも 24 頂点+36 index ≈ 250B だが、底面リング（1cm 量子化 ENU・差分 varint）＋底面高さ＋高さ＋天面の三角形分割
//   （リング頂点の添字）なら 30B 級。リング頂点は [e, n, du]（du＝天の参照高さからの差・DSM 由来の 1〜2% 勾配の屋根も厳密）。復元側が押し出して面ごとの法線付き溶接済みメッシュ（箱 24 頂点）を作る＝描画側は無改修。
//   判定は成分（位置共有の連結）単位：全頂点が 2 高度（底/天）に乗る・側面三角形の射影が退化（鉛直）・底面辺が閉路・
//   三角形数が 2Σm+天面（+底面）に一致。外れたら従来メッシュ＝失敗は常に「元のまま」側。
// ・LOD: lodCounts（index 数・高さ降順の先頭打ち切り）は、メッシュ側＝残った三角形の段ごと累積、角柱側＝段ごとの本数
//   （json.prisms.tiers）で持ち、復元時に段（LOD_H 上位から）ごとに「メッシュ→角柱」の順で合流して再計算する。
// 形式版 PLQ_VER＝レイアウトを変えたら上げる（マニフェストと突合＝旧焼きは黙って無視→生経路）。v2＝角柱部。v1 も読める。
// デコードパイプライン（接地・dedup 等）の版は IDB_FMT_VER（plateauworker）＝焼きの置き場 v{n}/ に刻む。
export const PLQ_VER = 2;
const MAGIC1 = 0x31514c50;   // "PLQ1"
const MAGIC2 = 0x32514c50;   // "PLQ2"
export const PRISM_Q = 0.01 / 6371000;   // 角柱の量子化＝1cm（単位球座標。楕円体でも 1.001cm＝どうでもよい差）
const PRISM_TOL = 0.06 / 6371000;   // 平面/鉛直の許容＝6cm（PLQ1 から詰め直す時：軸ごと ±1.5cm の量子化誤差が u に √3 倍で乗る＝天面の hi−lo が 5cm に届く実測）
const UP_FLAT = 0.98, UP_WALL = 0.08;   // 幾何法線の U 成分：|up|>0.98（11°以内）＝水平、|up|<0.08（4.6°以内）＝鉛直。量子化ジッタで 3m の壁が 0.01 傾く＝0.003 では壁の大半が「他」に落ちた（大田区 b5 実測 37%）
const PRISM_MIN_H = 0.3 / 6371000;  // 底/天の最小差＝30cm（それ未満は板＝メッシュのまま）

// 焼きの置き場（R2 キー）＝base URL から機械的に導く＝索引ファイル不要（1往復節約）。
//   https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13103-bldg-lod2-notexture-latest/
//   → api.plateauview.mlit.go.jp_datacatalog_3dtiles_13103-bldg-lod2-notexture-latest
export function bakeSlug(base) {
	return base.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/[^A-Za-z0-9._-]+/g, "_");
}
// 球（既定）と楕円体（?ell=1）は座標が違う＝別焼き・別置き場（…/ell/）。fmtVer＝plateaudecode.DECODE_VER
export const bakeDir = (base, fmtVer, ell = false) => `v${fmtVer}/${bakeSlug(base)}/${ell ? "ell/" : ""}`;

const zig = v => (v << 1) ^ (v >> 31);            // zigzag（|v| < 2^30 前提＝u16 差分・index 差分・1cm 格子（±2km=2e5）とも収まる）
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
	zig(v) { this.varint(zig(v)); }
	bytes() { return this.b.subarray(0, this.n); }
}
// varint 読み手（切り詰めは RangeError＝呼び出し側で null へ）
class In {
	constructor(u8, p) { this.u8 = u8; this.p = p; }
	varint() { let u = 0, shift = 0, b; do { if (this.p >= this.u8.length) throw new RangeError("plq truncated"); b = this.u8[this.p++]; u |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80); return u >>> 0; }
	zig() { return unzig(this.varint()); }
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
	const q = quantizeGrid(pos, grid);
	const { first, out, nidx } = uniqueVerts(q, nrm, idx);
	if (out > nv * 0.85) return mesh;   // 効きが薄い＝コピーもしない（既に溶接済み・共有頂点メッシュ等）
	const npos = new Float32Array(out * 3), nnrm = new Int8Array(out * 4);
	for (let j = 0; j < out; j++) { const v = first[j]; npos[j * 3] = pos[v * 3]; npos[j * 3 + 1] = pos[v * 3 + 1]; npos[j * 3 + 2] = pos[v * 3 + 2]; nnrm[j * 4] = nrm[v * 4]; nnrm[j * 4 + 1] = nrm[v * 4 + 1]; nnrm[j * 4 + 2] = nrm[v * 4 + 2]; }
	return { ...mesh, pos: npos, nrm: nnrm, idx: nidx };
}
function quantizeGrid(pos, grid) {
	const nv = pos.length / 3;
	const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { const p = pos[i + a]; if (p < mn[a]) mn[a] = p; if (p > mx[a]) mx[a] = p; }
	const inv = grid ? [1 / grid, 1 / grid, 1 / grid] : [0, 1, 2].map(a => 65535 / ((mx[a] - mn[a]) || 1e-12));
	const q = new Int32Array(nv * 3);
	for (let i = 0; i < nv; i++) for (let a = 0; a < 3; a++) q[i * 3 + a] = Math.round((pos[i * 3 + a] - mn[a]) * inv[a]);
	return q;
}
// 量子化位置（＋nrm があれば法線も）が一致する頂点を束ねる開番地ハッシュ。三角形順に初出採番。nrm=null＝位置だけ（連結判定用）
function uniqueVerts(q, nrm, idx) {
	const nv = q.length / 3;
	let cap = 1; while (cap < nv * 2) cap <<= 1;
	const table = new Int32Array(cap).fill(-1), hm = cap - 1;
	const remap = new Int32Array(nv).fill(-1), first = new Int32Array(nv);
	let out = 0;
	const nidx = new Uint32Array(idx.length);
	for (let k = 0; k < idx.length; k++) {
		const v = idx[k];
		let j = remap[v];
		if (j < 0) {
			const x = q[v * 3], y = q[v * 3 + 1], z = q[v * 3 + 2];
			const n = nrm ? (((nrm[v * 4] & 255) << 16) | ((nrm[v * 4 + 1] & 255) << 8) | (nrm[v * 4 + 2] & 255)) : 0;
			let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(n, 0x9e3779b1)) & hm;
			for (;;) {
				const c = table[h];
				if (c < 0) { table[h] = out; first[out] = v; j = out++; break; }
				const s = first[c];
				if (q[s * 3] === x && q[s * 3 + 1] === y && q[s * 3 + 2] === z && (!nrm || (nrm[s * 4] === nrm[v * 4] && nrm[s * 4 + 1] === nrm[v * 4 + 1] && nrm[s * 4 + 2] === nrm[v * 4 + 2]))) { j = c; break; }
				h = (h + 1) & hm;
			}
			remap[v] = j;
		}
		nidx[k] = j;
	}
	return { remap, first, out, nidx };
}

// ── 角柱（底面＋高さ）の抽出 ──
// ENU 基底＝origin（バッチ重心・絶対単位球座標）から：U=origin/|origin|、E=normalize(ŷ×U)、N=U×E（world 軸＝lat=asin(y) 規約）。
// origin 相対の pos p は e=p·E, n=p·N, u=p·U（origin 自身は (0,0,0)）＝厳密な直交分解＝復元 p=eE+nN+uU も厳密。
// 建物 1 棟（50m）内の球面の矢高 0.2mm＝量子化以下＝平面扱いでよい。
export function enuBasis(origin) {
	const L = Math.hypot(origin[0], origin[1], origin[2]) || 1;
	const U = [origin[0] / L, origin[1] / L, origin[2] / L];
	let E = [U[2], 0, -U[0]];   // ŷ×U
	const le = Math.hypot(E[0], E[2]) || 1; E = [E[0] / le, 0, E[2] / le];
	const N = [U[1] * E[2] - U[2] * E[1], U[2] * E[0] - U[0] * E[2], U[0] * E[1] - U[1] * E[0]];
	return { E, N, U };
}
// tier（LOD 段）: 三角形 t（index 位置 3t）が属する最上位段＝lodCounts[k] > 3t を満たす最大 k（lodCounts は段ごとの累積 index 数・降順に入れ子）
function tierOf(t3, lodCounts) { let k = 0; for (let i = 1; i < lodCounts.length; i++) if (t3 < lodCounts[i]) k = i; return k; }

// mesh（溶接済みでも未溶接でも可）→ { prisms:[{tier, base, h, rings:[[[e,n],…]], top:[i,j,k,…], bottom:false}], keep:Uint32Array(残す三角形番号) }
// 判定は「天面パッチ」単位（2026-09-07 二代目）：初代の「連結成分＝1 棟・2 高度」は、都心で隣接建物が壁を共有して 1 成分に
// 融合する／段状建物が 3 高度以上になる、で大田区の箱の街を 0〜26% しか拾えなかった（実測）。二代目は
//   ①三角形を幾何法線で 天（上向き水平）/底（下向き水平）/壁（鉛直）/他 に分類
//   ②天を辺共有で束ねたパッチ（同一高度）ごとに、境界辺→閉路（リング）を取り、各リング辺から下りる壁 2 三角形（同じ底高度 b）を探す
//   ③全辺が同じ b に落ちれば角柱 {rings, t, b}。天面三角形分割はリング頂点の添字（内部頂点があれば不採用）
//   ④底（下向き水平）は、成分が丸ごと角柱＋壁＋底で説明できた時だけ落とす（上空からは決して見えない面＝片面描画の裏面）
// 段状建物は上段だけが角柱（下段の天の辺は上段の壁と接し自分の壁を持たない）＝下段はメッシュのまま。失敗は常に「元のまま」側。
export const prismDebug = { on: false, counts: {} };
const fail = why => { if (prismDebug.on) prismDebug.counts[why] = (prismDebug.counts[why] || 0) + 1; return null; };
export function extractPrisms(mesh) {
	const { pos, nrm, idx, origin } = mesh;
	const nt = idx.length / 3, nv = pos.length / 3;
	const lodCounts = mesh.lodCounts || [idx.length];
	const empty = { prisms: [], keep: Uint32Array.from({ length: nt }, (_, t) => t) };
	if (!nt || !origin) return empty;
	const { E, N, U } = enuBasis(origin);
	const en = new Float64Array(nv * 2), uu = new Float64Array(nv);
	for (let i = 0; i < nv; i++) { const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]; en[i * 2] = x * E[0] + y * E[1] + z * E[2]; en[i * 2 + 1] = x * N[0] + y * N[1] + z * N[2]; uu[i] = x * U[0] + y * U[1] + z * U[2]; }
	const tol = PRISM_TOL;
	// 位置 id（2cm 格子・法線無視）＝辺共有と連結の単位
	const { remap: pid, out: np } = uniqueVerts(quantizeGrid(pos, PRISM_Q * 2), null, idx);
	// 三角形分類（幾何法線の U 成分。天/底の向きは頂点法線属性の符号で）
	const TOP = 1, BOT = 2, WALL = 3, OTHER = 0, DEGEN = 4;
	const cls = new Uint8Array(nt);
	const parT = new Int32Array(nt); for (let t = 0; t < nt; t++) parT[t] = t;
	const findT = i => { while (parT[i] !== i) { parT[i] = parT[parT[i]]; i = parT[i]; } return i; };
	const pidTris = new Map();   // pid → [t…]（壁探索用・全三角形）
	for (let t = 0; t < nt; t++) {
		const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
		const ux = en[b * 2] - en[a * 2], uy = en[b * 2 + 1] - en[a * 2 + 1], uz = uu[b] - uu[a], vx = en[c * 2] - en[a * 2], vy = en[c * 2 + 1] - en[a * 2 + 1], vz = uu[c] - uu[a];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, L = Math.hypot(nx, ny, nz);
		if (L < 1e-24) { cls[t] = DEGEN; }
		else {
			const up = nz / L;
			if (Math.abs(up) > UP_FLAT) { const s = nrm[a * 4] * U[0] + nrm[a * 4 + 1] * U[1] + nrm[a * 4 + 2] * U[2]; cls[t] = s >= 0 ? TOP : BOT; }
			else if (Math.abs(up) < UP_WALL) cls[t] = WALL;
			else cls[t] = OTHER;
		}
		for (const v of [a, b, c]) { const p = pid[v]; let l = pidTris.get(p); if (!l) pidTris.set(p, l = []); l.push(t); }
		// 成分（位置共有）
		const ra = findT(t); void ra;
	}
	// 成分＝頂点位置共有で三角形を union（底の落とし判定用）
	const firstTriOfPid = new Int32Array(np).fill(-1);
	for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) { const p = pid[idx[t * 3 + k]]; if (firstTriOfPid[p] < 0) firstTriOfPid[p] = t; else { const ra = findT(firstTriOfPid[p]), rb = findT(t); if (ra !== rb) parT[rb] = ra; } }
	// 天パッチ＝天三角形を辺共有で union
	const parP = new Int32Array(nt); for (let t = 0; t < nt; t++) parP[t] = t;
	const findP = i => { while (parP[i] !== i) { parP[i] = parP[parP[i]]; i = parP[i]; } return i; };
	{
		const edgeOwner = new Map();   // "p,q" → 天三角形
		for (let t = 0; t < nt; t++) {
			if (cls[t] !== TOP) continue;
			for (let k = 0; k < 3; k++) {
				const p = pid[idx[t * 3 + k]], q = pid[idx[t * 3 + (k + 1) % 3]];
				const key = p < q ? p * 4294967296 + q : q * 4294967296 + p;
				const o = edgeOwner.get(key);
				if (o === undefined) edgeOwner.set(key, t); else { const ra = findP(o), rb = findP(t); if (ra !== rb) parP[rb] = ra; }
			}
		}
	}
	const patches = new Map();   // root → [t…]
	for (let t = 0; t < nt; t++) if (cls[t] === TOP) { const r = findP(t); let a = patches.get(r); if (!a) patches.set(r, a = []); a.push(t); }
	const consumed = new Uint8Array(nt);
	const prisms = [];
	const near2 = (a, b) => Math.abs(en[a * 2] - en[b * 2]) <= tol && Math.abs(en[a * 2 + 1] - en[b * 2 + 1]) <= tol;
	for (const tris of patches.values()) {
		const p = tryPatch(tris);
		if (!p) continue;
		prisms.push(p.prism);
		for (const t of tris) consumed[t] = 1;
		for (const t of p.walls) consumed[t] = 1;
	}
	// ── 第二段：壁ループ（本人号令 9/8）＝壁から始める。同じ天 t・底 b の壁四角形を 2D の端点でつないで閉路にできれば、
	// 屋根が真上に無くても（軒の出＝屋根が壁より張り出す・屋根に壁の角と対応しない頂点がある）胴体は角柱になる（天面なし＝notop）。
	// 壁の向きは元の法線で決める（CCW 押し出しの外向きと元の壁法線が逆なら反転）＝中庭の内壁ループも自然に内向きになる。
	{
		// 2D 点 id（tol セル＋近傍 3×3・代表頂点）
		const cellMap = new Map(), rep2 = [];
		const p2cache = new Int32Array(nv).fill(-1);
		const id2 = v => {
			if (p2cache[v] >= 0) return p2cache[v];
			const cx = Math.round(en[v * 2] / tol), cy = Math.round(en[v * 2 + 1] / tol);
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const l = cellMap.get(`${cx + dx},${cy + dy}`); if (!l) continue;
				for (const j of l) { const r = rep2[j]; if (Math.abs(en[r * 2] - en[v * 2]) <= tol && Math.abs(en[r * 2 + 1] - en[v * 2 + 1]) <= tol) { p2cache[v] = j; return j; } }
			}
			const j = rep2.length; rep2.push(v); const k = `${cx},${cy}`; let l = cellMap.get(k); if (!l) cellMap.set(k, l = []); l.push(j); p2cache[v] = j; return j;
		};
		// 壁三角形 → セグメント（2D 端点 2 つ・天 t・底 b）
		const segs = new Map();   // "P,Q" → [{t, b, tri}]
		for (let t = 0; t < nt; t++) {
			if (cls[t] !== WALL || consumed[t]) continue;
			const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
			const ia = id2(a), ib = id2(b), ic = id2(c);
			const set = new Set([ia, ib, ic]); if (set.size !== 2) continue;
			const [P, Q] = [...set].sort((x, y) => x - y);
			const mx = Math.max(uu[a], uu[b], uu[c]), mn = Math.min(uu[a], uu[b], uu[c]);
			if (mx - mn < PRISM_MIN_H) continue;
			const key = P * 4294967296 + Q; let l = segs.get(key); if (!l) segs.set(key, l = []); l.push({ t: mx, b: mn, tri: t, P, Q });
		}
		// 同じ (P,Q) で天と底が tol 内の 2 枚＝四角形
		const quads = [];
		for (const l of segs.values()) {
			l.sort((x, y) => x.t - y.t || x.b - y.b);
			for (let i = 0; i + 1 < l.length; i++) { if (Math.abs(l[i].t - l[i + 1].t) <= tol && Math.abs(l[i].b - l[i + 1].b) <= tol) { quads.push({ P: l[i].P, Q: l[i].Q, t: (l[i].t + l[i + 1].t) / 2, b: (l[i].b + l[i + 1].b) / 2, tris: [l[i].tri, l[i + 1].tri] }); i++; } }
		}
		// 端点を共有し天・底が一致する四角形を union → 成分ごとに隣接（deg 2）→ 閉路
		const byPt = new Map();   // 2D 点 → [quad index]
		quads.forEach((q, i) => { for (const p of [q.P, q.Q]) { let l = byPt.get(p); if (!l) byPt.set(p, l = []); l.push(i); } });
		const parQ = new Int32Array(quads.length); for (let i = 0; i < quads.length; i++) parQ[i] = i;
		const findQ = i => { while (parQ[i] !== i) { parQ[i] = parQ[parQ[i]]; i = parQ[i]; } return i; };
		for (const l of byPt.values()) for (let i = 1; i < l.length; i++) for (let j = 0; j < i; j++) { const a = quads[l[i]], b = quads[l[j]]; if (Math.abs(a.t - b.t) <= tol && Math.abs(a.b - b.b) <= tol) { const ra = findQ(l[i]), rb = findQ(l[j]); if (ra !== rb) parQ[rb] = ra; } }
		const comps = new Map();
		quads.forEach((q, i) => { const r = findQ(i); let l = comps.get(r); if (!l) comps.set(r, l = []); l.push(i); });
		for (const qi of comps.values()) {
			const adj = new Map(), edgeQuad = new Map();
			let ok = true;
			for (const i of qi) { const q = quads[i]; for (const [x, y] of [[q.P, q.Q], [q.Q, q.P]]) { let s2 = adj.get(x); if (!s2) adj.set(x, s2 = new Set()); if (s2.has(y)) { ok = false; break; } s2.add(y); } if (!ok) break; edgeQuad.set(q.P * 4294967296 + q.Q, i); }
			if (!ok) { fail("loop-dup-edge"); continue; }
			let deg2 = true; for (const s2 of adj.values()) if (s2.size !== 2) { deg2 = false; break; }
			if (!deg2) { fail("loop-deg"); continue; }
			const seen = new Set(); const cycles = [];
			for (const start of adj.keys()) {
				if (seen.has(start)) continue;
				const ring = [start]; seen.add(start); let prev = -1, cur = start, bad = false;
				for (;;) { const [x, y] = [...adj.get(cur)]; const nxt = x !== prev ? x : y; if (nxt === start) break; if (seen.has(nxt) || ring.length > adj.size) { bad = true; break; } ring.push(nxt); seen.add(nxt); prev = cur; cur = nxt; }
				if (bad || ring.length < 3) { ok = false; break; }
				cycles.push(ring);
			}
			if (!ok) { fail("loop-walk"); continue; }
			const t0 = quads[qi[0]].t, b0 = quads[qi[0]].b;
			for (const ring of cycles) {
				// 向き＝元の壁法線に合わせる：先頭辺の CCW 外向き (dn, -de) と、その壁の法線の水平成分の内積
				const q0 = quads[edgeQuad.get(Math.min(ring[0], ring[1]) * 4294967296 + Math.max(ring[0], ring[1]))];
				const va = rep2[ring[0]], vb = rep2[ring[1]];
				const de = en[vb * 2] - en[va * 2], dn = en[vb * 2 + 1] - en[va * 2 + 1];
				const wt = idx[q0.tris[0] * 3] * 4, nx = nrm[wt], ny = nrm[wt + 1], nz = nrm[wt + 2];
				const ne = nx * E[0] + ny * E[1] + nz * E[2], nn = nx * N[0] + ny * N[1] + nz * N[2];
				if (dn * ne - de * nn < 0) ring.reverse();
				const ringQ = ring.map(p => { const v = rep2[p]; return [Math.round(en[v * 2] / PRISM_Q), Math.round(en[v * 2 + 1] / PRISM_Q), 0]; });
				const hQ = Math.round((t0 - b0) / PRISM_Q); if (hQ <= 0) continue;
				prisms.push({ tier: tierOf(q0.tris[0] * 3, lodCounts), base: Math.round(b0 / PRISM_Q), h: hQ, rings: [ringQ], top: [], bottom: false, notop: true });
				for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; const q = quads[edgeQuad.get(Math.min(a, b) * 4294967296 + Math.max(a, b))]; consumed[q.tris[0]] = 1; consumed[q.tris[1]] = 1; }
			}
		}
	}
	if (!prisms.length) return empty;
	// 底の落とし：成分の未消費が底（と退化）だけなら落とす。それ以外の成分の底は残す（部分変換＝メッシュ側に底が要る訳ではないが安全側）
	const compRest = new Map();   // root → 未消費に底以外があるか
	for (let t = 0; t < nt; t++) { if (consumed[t]) continue; const r = findT(t); if (cls[t] !== BOT && cls[t] !== DEGEN) compRest.set(r, true); else if (!compRest.has(r)) compRest.set(r, false); }
	const compHasPrism = new Set();
	for (let t = 0; t < nt; t++) if (consumed[t]) compHasPrism.add(findT(t));
	const keep = [];
	for (let t = 0; t < nt; t++) {
		if (consumed[t]) continue;
		const r = findT(t);
		if ((cls[t] === BOT || cls[t] === DEGEN) && compHasPrism.has(r) && compRest.get(r) === false) continue;   // 丸ごと角柱で説明できた成分の底＝落とす
		keep.push(t);
	}
	return { prisms, keep: Uint32Array.from(keep) };

	function tryPatch(tris) {
		// 天面＝ほぼ水平（分類済み）だが完全な平面とは限らない（DSM 由来の 1〜2% 勾配＝10m で 10cm）＝頂点ごとの高さを持つ
		let hi = -Infinity;
		for (const t of tris) for (let k = 0; k < 3; k++) { const u = uu[idx[t * 3 + k]]; if (u > hi) hi = u; }
		const tLevel = hi;   // 参照＝最高点（du ≤ 0）
		// 境界辺（パッチ内で 1 回だけ現れる辺）→ 隣接（deg 2）→ 閉路
		const cnt = new Map(), adj = new Map(), rep = new Map();   // rep: pid → 代表頂点
		for (const t of tris) for (let k = 0; k < 3; k++) {
			const v = idx[t * 3 + k], w = idx[t * 3 + (k + 1) % 3], p = pid[v], q = pid[w];
			if (!rep.has(p)) rep.set(p, v); if (!rep.has(q)) rep.set(q, w);
			if (p === q) return fail("degenerate-edge");
			const key = p < q ? `${p},${q}` : `${q},${p}`;
			cnt.set(key, (cnt.get(key) || 0) + 1);
		}
		for (const [key, c] of cnt) { if (c !== 1) continue; const [p, q] = key.split(",").map(Number); let s = adj.get(p); if (!s) adj.set(p, s = new Set()); s.add(q); s = adj.get(q); if (!s) adj.set(q, s = new Set()); s.add(p); }
		if (!adj.size) return fail("no-boundary");
		for (const s of adj.values()) if (s.size !== 2) return fail("boundary-deg");
		if (adj.size !== rep.size) return fail("interior-vertex");   // 境界に乗らない頂点（内部の Steiner 点）＝リング添字で表せない
		const seen = new Set(), rings = [];
		for (const start of adj.keys()) {
			if (seen.has(start)) continue;
			const ring = [start]; seen.add(start);
			let prev = -1, cur = start;
			for (;;) {
				const [x, y] = [...adj.get(cur)];
				const nxt = x !== prev ? x : y;
				if (nxt === start) break;
				if (seen.has(nxt) || ring.length > adj.size) return fail("ring-walk");
				ring.push(nxt); seen.add(nxt); prev = cur; cur = nxt;
			}
			if (ring.length < 3) return fail("ring-short");
			rings.push(ring);
		}
		// 各リング辺の壁 2 三角形（頂点の 2D 位置が辺の両端のどちらかに一致・最高が tLevel・最低が共通の b）
		const walls = [];
		let bLevel = null;
		for (const ring of rings) for (let i = 0; i < ring.length; i++) {
			const P = ring[i], Q = ring[(i + 1) % ring.length], vp = rep.get(P), vq = rep.get(Q);
			const cand = new Set();
			for (const t of (pidTris.get(P) || [])) if (cls[t] === WALL && !consumed[t]) cand.add(t);
			for (const t of (pidTris.get(Q) || [])) if (cls[t] === WALL && !consumed[t]) cand.add(t);
			const found = [], uP = uu[vp], uQ = uu[vq];
			for (const t of cand) {
				// 壁三角形の各頂点＝P か Q の真上/真下、かつ高さは「その柱の天（uP/uQ）」か「底 b」のどちらか
				let ok = true, mn = Infinity;
				for (let k = 0; k < 3 && ok; k++) { const v = idx[t * 3 + k], u = uu[v]; const atP = near2(v, vp), atQ = near2(v, vq); if (!atP && !atQ) { ok = false; break; } const ut = atP ? uP : uQ; if (Math.abs(u - ut) > tol) { if (u > ut - tol) { ok = false; break; } if (u < mn) mn = u; } }
				if (!ok || mn === Infinity) continue;
				found.push([t, mn]);
			}
			if (found.length < 2 || found.length % 2) return fail(found.length === 0 ? "wall-none" : found.length === 1 ? "wall-one" : "wall-odd");
			found.sort((x, y) => x[1] - y[1]);   // 同じ辺に別建物の壁が重なる（共有壁）＝底が同じ 2 枚が組。底の近い順に並べて先頭 2 枚
			if (Math.abs(found[0][1] - found[1][1]) > tol) return fail("wall-base-mismatch");
			const b = (found[0][1] + found[1][1]) / 2;
			if (bLevel === null) bLevel = b; else if (Math.abs(b - bLevel) > tol) return fail("base-varies");
			walls.push(found[0][0], found[1][0]);
		}
		if (bLevel === null || tLevel - bLevel < PRISM_MIN_H) return fail("too-flat");
		// 向き：外周 CCW・穴 CW
		const area = ring => { let s = 0; for (let i = 0; i < ring.length; i++) { const a = rep.get(ring[i]), b = rep.get(ring[(i + 1) % ring.length]); s += en[a * 2] * en[b * 2 + 1] - en[b * 2] * en[a * 2 + 1]; } return s / 2; };
		let outer = 0, best = -Infinity;
		rings.forEach((r, i) => { const A = Math.abs(area(r)); if (A > best) { best = A; outer = i; } });
		rings.forEach((r, i) => { const A = area(r); if ((i === outer && A < 0) || (i !== outer && A > 0)) r.reverse(); });
		const local = new Map(); let li = 0;
		const ringQ = rings.map(r => r.map(p => { local.set(p, li++); const v = rep.get(p); return [Math.round(en[v * 2] / PRISM_Q), Math.round(en[v * 2 + 1] / PRISM_Q), Math.min(0, Math.round((uu[v] - tLevel) / PRISM_Q))]; }));   // [e, n, du]（du＝天の参照からの差・≤0）
		const top = [];
		for (const t of tris) for (let k = 0; k < 3; k++) top.push(local.get(pid[idx[t * 3 + k]]));
		const baseQ = Math.round(bLevel / PRISM_Q), hQ = Math.round((tLevel - bLevel) / PRISM_Q);
		if (hQ <= 0) return fail("h0");
		return { prism: { tier: tierOf(tris[0] * 3, lodCounts), base: baseQ, h: hQ, rings: ringQ, top, bottom: false }, walls };
	}
}

// 角柱 → メッシュ（押し出し）。壁＝辺ごとに 4 頂点（外向き法線）・天＝リング頂点（U）・底＝同（−U・bottom 時）。
// 出力は溶接済み相当（面ごとに頂点）。戻り値 { pos, nrm, idx }（origin 相対 f32）。角柱 p の index 数＝6Σm＋天(+底)。
export function extrudePrisms(prisms, origin) {
	const { E, N, U } = enuBasis(origin);
	let nvT = 0, niT = 0;
	for (const p of prisms) { let m = 0; for (const r of p.rings) m += r.length; nvT += 4 * m + (p.notop ? 0 : m) + (p.bottom ? m : 0); niT += 6 * m + (p.notop ? 0 : p.top.length * (p.bottom ? 2 : 1)); }
	const pos = new Float32Array(nvT * 3), nrm = new Int8Array(nvT * 4), idx = new Uint32Array(niT);
	let vo = 0, io = 0;
	const put = (e, n, u, nx, ny, nz) => {   // ENU（PRISM_Q 単位）→ world（origin 相対）
		const ee = e * PRISM_Q, nn = n * PRISM_Q, uw = u * PRISM_Q;
		pos[vo * 3] = ee * E[0] + nn * N[0] + uw * U[0]; pos[vo * 3 + 1] = ee * E[1] + nn * N[1] + uw * U[1]; pos[vo * 3 + 2] = ee * E[2] + nn * N[2] + uw * U[2];
		nrm[vo * 4] = nx; nrm[vo * 4 + 1] = ny; nrm[vo * 4 + 2] = nz;
		return vo++;
	};
	const q8 = v => Math.max(-127, Math.min(127, Math.round(v * 127)));
	const upN = [q8(U[0]), q8(U[1]), q8(U[2])], dnN = [q8(-U[0]), q8(-U[1]), q8(-U[2])];
	for (const p of prisms) {
		const b = p.base, t = p.base + p.h;
		for (const ring of p.rings) {   // 壁
			const m = ring.length;
			for (let i = 0; i < m; i++) {
				const [e0, n0, d0 = 0] = ring[i], [e1, n1, d1 = 0] = ring[(i + 1) % m];
				const de = e1 - e0, dn = n1 - n0, L = Math.hypot(de, dn) || 1;
				const wx = dn / L, wy = -de / L;   // CCW 外周の外向き（穴は CW＝穴側から見て外向き）
				const nx = q8(wx * E[0] + wy * N[0]), ny = q8(wx * E[1] + wy * N[1]), nz = q8(wx * E[2] + wy * N[2]);
				const a = put(e0, n0, b, nx, ny, nz), c = put(e1, n1, b, nx, ny, nz), d = put(e1, n1, t + d1, nx, ny, nz), f = put(e0, n0, t + d0, nx, ny, nz);
				idx[io++] = a; idx[io++] = c; idx[io++] = d; idx[io++] = a; idx[io++] = d; idx[io++] = f;
			}
		}
		if (p.notop) continue;   // 天なし（壁ループ由来）
		const topBase = vo;   // 天
		for (const ring of p.rings) for (const [e, n, du = 0] of ring) put(e, n, t + du, upN[0], upN[1], upN[2]);   // 天＝頂点ごとの高さ（法線は U＝勾配 11° 以内の陰影差は 2% 未満）
		for (let k = 0; k < p.top.length; k++) idx[io++] = topBase + p.top[k];
		if (p.bottom) {   // 底（天の鏡像＝同じ三角形分割・巻きを反転）
			const botBase = vo;
			for (const ring of p.rings) for (const [e, n] of ring) put(e, n, b, dnN[0], dnN[1], dnN[2]);   // 底（抽出は出さない・押し出し API の互換）
			for (let k = 0; k < p.top.length; k += 3) { idx[io++] = botBase + p.top[k]; idx[io++] = botBase + p.top[k + 2]; idx[io++] = botBase + p.top[k + 1]; }
		}
	}
	return { pos, nrm, idx };
}

// 三角形順に頂点を並べ直せるか＝参照頂点の重複が少ないか（並べ直しは共有頂点を複製する＝増える分が 20% 超なら explicit）
function planLayout(idx, nv) {
	const seen = new Uint8Array(nv);
	let distinct = 0;
	for (let k = 0; k < idx.length; k++) { const v = idx[k]; if (!seen[v]) { seen[v] = 1; distinct++; } }
	return { iota: idx.length <= distinct * 1.2, distinct, seen };
}

// opts.weld=false＝溶接しない・opts.prism=false＝角柱抽出しない（検定/比較用）。opts.stats＝{ prisms, prismTris, meshTris } を書き戻す
export function packPLQ(mesh, opts = {}) {
	if (opts.weld !== false) mesh = weldMesh(mesh);   // 既定＝溶接（保存精度の格子で束ねる＝最大の効き）
	const lodH = mesh.lodH || null;
	const ntAll = mesh.idx.length / 3;
	const lodCountsAll = mesh.lodCounts || [mesh.idx.length];
	// 角柱抽出 → 残りメッシュ（三角形順・LOD 順を保つ）＋段ごとの累積 lodCounts
	let prisms = [], keep = null;
	if (opts.prism !== false) ({ prisms, keep } = extractPrisms(mesh));
	let idx = mesh.idx, lodCounts = lodCountsAll;
	if (keep && keep.length !== ntAll) {
		idx = new Uint32Array(keep.length * 3);
		const tierN = new Int32Array(lodCountsAll.length);
		for (let i = 0; i < keep.length; i++) { const t = keep[i]; idx[i * 3] = mesh.idx[t * 3]; idx[i * 3 + 1] = mesh.idx[t * 3 + 1]; idx[i * 3 + 2] = mesh.idx[t * 3 + 2]; tierN[tierOf(t * 3, lodCountsAll)] += 3; }
		lodCounts = lodCountsAll.map((_, k) => { let s = 0; for (let j = k; j < tierN.length; j++) s += tierN[j]; return s; });   // 段 k 以上の累積 index 数
	}
	if (opts.stats) { opts.stats.prisms = prisms.length; opts.stats.meshTris = idx.length / 3; opts.stats.prismTris = ntAll - idx.length / 3; }
	const { pos, nrm } = mesh;
	const nvSrc = pos.length / 3, nt = idx.length / 3;
	// ── メッシュ部 ──
	let order = new Uint32Array(0), idxOut = null, nv = 0;
	const mn = [0, 0, 0], scale = [1, 1, 1];
	let posBytes = new Uint8Array(0), nrmBytes = new Int8Array(0), idxBytes = null;
	if (nt) {
		const plan = planLayout(idx, nvSrc);
		if (plan.iota) { order = idx; }
		else {
			const remap = new Int32Array(nvSrc).fill(-1);
			order = new Uint32Array(plan.distinct);
			let j = 0;
			for (let v = 0; v < nvSrc; v++) if (plan.seen[v]) { remap[v] = j; order[j++] = v; }
			idxOut = new Uint32Array(idx.length);
			for (let k = 0; k < idx.length; k++) idxOut[k] = remap[idx[k]];
		}
		nv = order.length;
		mn.fill(Infinity); const mx = [-Infinity, -Infinity, -Infinity];
		for (let j = 0; j < nv; j++) { const v = order[j] * 3; for (let a = 0; a < 3; a++) { const p = pos[v + a]; if (p < mn[a]) mn[a] = p; if (p > mx[a]) mx[a] = p; } }
		for (let a = 0; a < 3; a++) scale[a] = (mx[a] - mn[a]) / 65535 || 1e-12;
		const inv = scale.map(s => 1 / s);
		const out = new Out(Math.max(64, nv * 4));
		let px = 0, py = 0, pz = 0;
		for (let j = 0; j < nv; j++) {
			const v = order[j] * 3;
			const qx = Math.round((pos[v] - mn[0]) * inv[0]), qy = Math.round((pos[v + 1] - mn[1]) * inv[1]), qz = Math.round((pos[v + 2] - mn[2]) * inv[2]);
			out.zig(qx - px); out.zig(qy - py); out.zig(qz - pz);
			px = qx; py = qy; pz = qz;
		}
		posBytes = out.bytes();
		nrmBytes = new Int8Array(nv * 3);
		for (let j = 0; j < nv; j++) { const s = order[j] * 4, d = j * 3; nrmBytes[d] = nrm[s]; nrmBytes[d + 1] = nrm[s + 1]; nrmBytes[d + 2] = nrm[s + 2]; }
		if (idxOut) {
			const o = new Out(Math.max(64, idxOut.length * 2));
			let prev = 0;
			for (let k = 0; k < idxOut.length; k++) { o.zig(idxOut[k] - prev); prev = idxOut[k]; }
			idxBytes = o.bytes();
		}
	}
	// ── 角柱部（段ごと＝高い段から。段内の順は抽出順）──
	const nTier = lodCountsAll.length, tiers = new Array(nTier).fill(0);
	const byTier = Array.from({ length: nTier }, () => []);
	for (const p of prisms) byTier[p.tier].push(p);
	const po = new Out(Math.max(64, prisms.length * 40));
	for (let k = nTier - 1; k >= 0; k--) for (const p of byTier[k]) {
		tiers[k]++;
		po.varint((p.bottom ? 1 : 0) | (p.notop ? 2 : 0)); po.zig(p.base); po.varint(p.h);   // bit0=底あり・bit1=天なし（壁ループ由来＝天は屋根の板の下に隠れる）
		po.varint(p.rings.length);
		let pe = 0, pn = 0;
		for (const r of p.rings) { po.varint(r.length); for (const [e, n, du] of r) { po.zig(e - pe); po.zig(n - pn); po.zig(du || 0); pe = e; pn = n; } }
		po.varint(p.top.length / 3);
		for (const i of p.top) po.varint(i);
	}
	const prismBytes = po.bytes();
	const head = {
		origin: mesh.origin, bbox: mesh.bbox, lodH, lodCounts, twoSided: mesh.twoSided || 0,
		cells: mesh.maskCells ? Array.from(mesh.maskCells) : null,
		nv, nt, qmin: mn, qscale: scale, idx: idxOut ? "explicit" : "iota",
		prisms: prisms.length ? { n: prisms.length, tiers, bytes: prismBytes.length } : null,
	};
	const json = new TextEncoder().encode(JSON.stringify(head));
	const start = dataStart(json.length);
	const total = start + posBytes.length + nrmBytes.length + (idxBytes ? idxBytes.length : 0) + prismBytes.length;
	const u8 = new Uint8Array(total);
	const dv = new DataView(u8.buffer);
	dv.setUint32(0, MAGIC2, true); dv.setUint32(4, json.length, true);
	u8.set(json, 8);
	let o = start;
	u8.set(posBytes, o); o += posBytes.length;
	u8.set(new Uint8Array(nrmBytes.buffer, nrmBytes.byteOffset, nrmBytes.byteLength), o); o += nrmBytes.length;
	if (idxBytes) { u8.set(idxBytes, o); o += idxBytes.length; }
	u8.set(prismBytes, o);
	return u8;
}
const dataStart = jsonLen => { const h = 8 + jsonLen; return h + ((4 - h % 4) % 4); };

// ヘッダだけ読む（統計・検分用）
export function headPLQ(u8) {
	if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
	if (u8.length < 8) return null;
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const magic = dv.getUint32(0, true);
	if (magic !== MAGIC1 && magic !== MAGIC2) return null;
	try { return JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + dv.getUint32(4, true)))); } catch { return null; }
}

// 復元＝decodeBatch と同じ形のメッシュ（pos f32・nrm i8×4・idx u32・lodCounts）。壊れ/形式違いは null（呼び出し側が生経路へ）。
// PLQ1（角柱部なし）も読む。
export function unpackPLQ(u8, opts = {}) {
	if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
	if (u8.length < 8) return null;
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const magic = dv.getUint32(0, true);
	if (magic !== MAGIC1 && magic !== MAGIC2) return null;
	const jl = dv.getUint32(4, true);
	let h;
	try { h = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + jl))); } catch { return null; }
	const nv = h.nv | 0, nt = h.nt | 0;
	if (nt > 0 && (!(nv > 0) || !h.qmin || !h.qscale)) return null;
	if (!nt && !h.prisms) return null;
	const rd = new In(u8, dataStart(jl));
	try {
		// ── メッシュ部 ──
		const pos = new Float32Array(nv * 3), nrm = new Int8Array(nv * 4), idx = new Uint32Array(nt * 3);
		if (nt) {
			const [m0, m1, m2] = h.qmin, [s0, s1, s2] = h.qscale;
			let qx = 0, qy = 0, qz = 0;
			for (let j = 0; j < nv; j++) {
				qx += rd.zig(); qy += rd.zig(); qz += rd.zig();
				const d = j * 3;
				pos[d] = m0 + qx * s0; pos[d + 1] = m1 + qy * s1; pos[d + 2] = m2 + qz * s2;
			}
			if (rd.p + nv * 3 > u8.length) return null;
			const src = new Int8Array(u8.buffer, u8.byteOffset + rd.p, nv * 3);
			for (let j = 0; j < nv; j++) { const s = j * 3, d = j * 4; nrm[d] = src[s]; nrm[d + 1] = src[s + 1]; nrm[d + 2] = src[s + 2]; }
			rd.p += nv * 3;
			if (h.idx === "explicit") { let prev = 0; for (let k = 0; k < idx.length; k++) { prev += rd.zig(); idx[k] = prev; } }
			else for (let k = 0; k < idx.length; k++) idx[k] = k;
		}
		const base = { origin: h.origin, bbox: h.bbox, lodH: h.lodH, twoSided: h.twoSided || 0, maskCells: h.cells ? Uint32Array.from(h.cells) : null };
		if (!h.prisms) return { pos, nrm, idx, lodCounts: h.lodCounts, ...base };
		// ── 角柱部 → 押し出し → 段ごとに合流（高い段から：メッシュ→角柱）→ lodCounts 再計算 ──
		const tiers = h.prisms.tiers, nTier = tiers.length;
		const prisms = [];
		for (let k = nTier - 1; k >= 0; k--) for (let i = 0; i < tiers[k]; i++) {
			const flags = rd.varint(), b = rd.zig(), hh = rd.varint();
			const nr = rd.varint(), rings = [];
			let pe = 0, pn = 0;
			for (let r = 0; r < nr; r++) { const m = rd.varint(), ring = new Array(m); for (let j = 0; j < m; j++) { pe += rd.zig(); pn += rd.zig(); const du = rd.zig(); ring[j] = [pe, pn, du]; } rings.push(ring); }
			const ntp = rd.varint(), top = new Array(ntp * 3);
			for (let j = 0; j < ntp * 3; j++) top[j] = rd.varint();
			prisms.push({ tier: k, base: b, h: hh, rings, top, bottom: !!(flags & 1), notop: !!(flags & 2) });
		}
		const ex = extrudePrisms(prisms, h.origin);
		const perPrism = prisms.map(p => { let m = 0; for (const r of p.rings) m += r.length; return 6 * m + (p.notop ? 0 : p.top.length * (p.bottom ? 2 : 1)); });
		const meshLod = h.lodCounts || [idx.length];
		const totalI = idx.length + ex.idx.length, totalV = nv + ex.pos.length / 3;
		const opos = new Float32Array(totalV * 3), onrm = new Int8Array(totalV * 4), oidx = new Uint32Array(totalI);
		opos.set(pos, 0); opos.set(ex.pos, nv * 3); onrm.set(nrm, 0); onrm.set(ex.nrm, nv * 4);
		const lodCounts = new Array(nTier).fill(0);
		let io = 0, pi = 0, pIdx = 0;   // pi＝角柱通し番号・pIdx＝ex.idx の読み位置
		for (let k = nTier - 1; k >= 0; k--) {
			const from = k + 1 < nTier ? meshLod[k + 1] : 0, to = meshLod[k];   // メッシュ：段 k の三角形＝index 範囲 [meshLod[k+1], meshLod[k])
			for (let j = from; j < to; j++) oidx[io++] = idx[j];
			for (let i = 0; i < tiers[k]; i++, pi++) { const n = perPrism[pi]; for (let j = 0; j < n; j++) oidx[io++] = ex.idx[pIdx++] + nv; }
			lodCounts[k] = io;
		}
		return { pos: opos, nrm: onrm, idx: oidx, lodCounts, ...base };
	} catch (e) { if (opts.throw) throw e; return null; }   // opts.throw＝診断用（既定は null＝呼び出し側が生経路へ）
}
