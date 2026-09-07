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
//   （リング頂点の添字）なら 30B 級。復元側が押し出して面ごとの法線付き溶接済みメッシュ（箱 24 頂点）を作る＝描画側は無改修。
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
const PRISM_TOL = 0.04 / 6371000;   // 平面/鉛直の許容＝4cm（PLQ 量子化誤差 ≤1.5cm＋f32）
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

// mesh（溶接済みでも未溶接でも可）→ { prisms:[{tier, base, h, rings:[[[e,n],…]], top:[i,j,k,…], bottom}], keep:Uint32Array(残す三角形番号) }
// 座標は PRISM_Q 単位の整数（e,n）・base/h も同じ単位。失敗は常に「その成分をメッシュのまま残す」側。
export function extractPrisms(mesh) {
	const { pos, idx, origin } = mesh;
	const nt = idx.length / 3, nv = pos.length / 3;
	const lodCounts = mesh.lodCounts || [idx.length];
	const empty = { prisms: [], keep: Uint32Array.from({ length: nt }, (_, t) => t) };
	if (!nt || !origin) return empty;
	const { E, N, U } = enuBasis(origin);
	// ENU（f64）
	const en = new Float64Array(nv * 2), uu = new Float64Array(nv);
	for (let i = 0; i < nv; i++) { const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]; en[i * 2] = x * E[0] + y * E[1] + z * E[2]; en[i * 2 + 1] = x * N[0] + y * N[1] + z * N[2]; uu[i] = x * U[0] + y * U[1] + z * U[2]; }
	// 連結成分＝位置共有（2cm 格子・法線無視）で頂点を束ね、三角形を union-find
	const pq = quantizeGrid(pos, PRISM_Q * 2);
	const { remap: pid, out: np } = uniqueVerts(pq, null, idx);
	const par = new Int32Array(np); for (let i = 0; i < np; i++) par[i] = i;
	const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
	for (let t = 0; t < nt; t++) { const a = pid[idx[t * 3]], b = pid[idx[t * 3 + 1]], c = pid[idx[t * 3 + 2]]; const ra = find(a); const rb = find(b); if (rb !== ra) par[rb] = ra; const rc = find(c); if (rc !== find(a)) par[rc] = find(a); }
	const compTris = new Map();   // root → [t…]（三角形順＝LOD 順を保つ）
	for (let t = 0; t < nt; t++) { const r = find(pid[idx[t * 3]]); let a = compTris.get(r); if (!a) compTris.set(r, a = []); a.push(t); }
	const prisms = [], keepFlag = new Uint8Array(nt).fill(1);
	const tol = PRISM_TOL, cell = PRISM_TOL * 2;
	for (const tris of compTris.values()) {
		const p = tryPrism(tris);
		if (p) { prisms.push(p); for (const t of tris) keepFlag[t] = 0; }
	}
	const keep = []; for (let t = 0; t < nt; t++) if (keepFlag[t]) keep.push(t);
	return { prisms, keep: Uint32Array.from(keep) };

	function tryPrism(tris) {
		// 成分の頂点と高度
		const vids = new Set(); for (const t of tris) { vids.add(idx[t * 3]); vids.add(idx[t * 3 + 1]); vids.add(idx[t * 3 + 2]); }
		let lo = Infinity, hi = -Infinity;
		for (const v of vids) { const u = uu[v]; if (u < lo) lo = u; if (u > hi) hi = u; }
		if (hi - lo < PRISM_MIN_H) return null;
		const mid = (lo + hi) / 2;
		const level = new Map();   // 頂点 → 0(底)/1(天)。どちらの面からも tol 超＝失敗
		let baseSum = 0, baseN = 0, topSum = 0, topN = 0;
		for (const v of vids) {
			const u = uu[v];
			if (u < mid) { if (u - lo > tol) return null; level.set(v, 0); baseSum += u; baseN++; }
			else { if (hi - u > tol) return null; level.set(v, 1); topSum += u; topN++; }
		}
		if (!baseN || !topN) return null;
		// 2D で底/天の対応（tol セル＋近傍 3×3）。底面点＝「底頂点の代表」（同じ 2D 位置の底頂点は 1 つに）
		const baseBy = new Map();   // key → 代表底頂点
		const canon = new Map();    // 頂点 → 代表底頂点（天頂点は真下の底頂点へ）
		const nearBase = v => {
			const cx = Math.round(en[v * 2] / cell), cy = Math.round(en[v * 2 + 1] / cell);
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const b = baseBy.get(`${cx + dx},${cy + dy}`);
				if (b !== undefined && Math.abs(en[b * 2] - en[v * 2]) <= tol && Math.abs(en[b * 2 + 1] - en[v * 2 + 1]) <= tol) return b;
			}
			return undefined;
		};
		for (const v of vids) if (level.get(v) === 0) { const b = nearBase(v); if (b === undefined) { baseBy.set(`${Math.round(en[v * 2] / cell)},${Math.round(en[v * 2 + 1] / cell)}`, v); canon.set(v, v); } else canon.set(v, b); }
		for (const v of vids) if (level.get(v) === 1) { const b = nearBase(v); if (b === undefined) return null; canon.set(v, b); }   // 天に真下の無い点＝勾配/張り出し
		const topOver = new Set(); for (const v of vids) if (level.get(v) === 1) topOver.add(canon.get(v));
		for (const b of baseBy.values()) if (!topOver.has(b)) return null;   // 底だけの張り出し
		// 三角形の分類：壁（2:1・退化射影）／天（3 天）／底（3 底）
		const edgeCnt = new Map(), adj = new Map();
		const topTris = []; let bottomTris = 0;
		const addEdge = (a, b) => { if (a === b) return false; const k = a < b ? `${a},${b}` : `${b},${a}`; edgeCnt.set(k, (edgeCnt.get(k) || 0) + 1); let s = adj.get(a); if (!s) adj.set(a, s = new Set()); s.add(b); s = adj.get(b); if (!s) adj.set(b, s = new Set()); s.add(a); return true; };
		for (const t of tris) {
			const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
			const la = level.get(a), lb = level.get(b), lc = level.get(c), s = la + lb + lc;
			const ca = canon.get(a), cb = canon.get(b), cc = canon.get(c);
			if (s === 3) { if (ca === cb || cb === cc || ca === cc) return null; topTris.push(ca, cb, cc); continue; }
			if (s === 0) { bottomTris++; continue; }
			let p, q, r;   // p,q＝同レベルの 2 点・r＝残り
			if (la === lb) { p = a; q = b; r = c; } else if (la === lc) { p = a; q = c; r = b; } else { p = b; q = c; r = a; }
			const cp = canon.get(p), cq = canon.get(q), cr = canon.get(r);
			if (cr !== cp && cr !== cq) return null;   // 斜めの壁
			if (!addEdge(cp, cq)) return null;
		}
		if (bottomTris && bottomTris !== topTris.length / 3) return null;   // 底があるなら天と同じ三角形数（同じ多角形の三角形分割）
		for (const c of edgeCnt.values()) if (c !== 2) return null;   // 底面辺は壁 2 三角形から必ず 2 回
		for (const s of adj.values()) if (s.size !== 2) return null;   // 各点の隣は 2 つ＝閉路
		const seen = new Set(), rings = [];
		for (const start of adj.keys()) {
			if (seen.has(start)) continue;
			const ring = [start]; seen.add(start);
			let prev = -1, cur = start;
			for (;;) {
				const [x, y] = [...adj.get(cur)];
				const nxt = x !== prev ? x : y;
				if (nxt === start) break;
				if (seen.has(nxt) || ring.length > adj.size) return null;
				ring.push(nxt); seen.add(nxt); prev = cur; cur = nxt;
			}
			if (ring.length < 3) return null;
			rings.push(ring);
		}
		if (seen.size !== adj.size) return null;
		let m = 0; for (const r of rings) m += r.length;
		if (tris.length !== 2 * m + topTris.length / 3 + bottomTris) return null;   // 三角形数の突合＝壁 2Σm＋天＋底
		// 外周を CCW（正の符号付き面積）に、穴は CW に＝押し出しの壁法線が外向きになる（片面描画は法線で裏面 discard＝向きが要る）
		const area = ring => { let s = 0; for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; s += en[a * 2] * en[b * 2 + 1] - en[b * 2] * en[a * 2 + 1]; } return s / 2; };
		let outer = 0, best = -Infinity;
		rings.forEach((r, i) => { const A = Math.abs(area(r)); if (A > best) { best = A; outer = i; } });
		rings.forEach((r, i) => { const A = area(r); if ((i === outer && A < 0) || (i !== outer && A > 0)) r.reverse(); });
		const local = new Map(); let li = 0;
		const ringQ = rings.map(r => r.map(b => { local.set(b, li++); return [Math.round(en[b * 2] / PRISM_Q), Math.round(en[b * 2 + 1] / PRISM_Q)]; }));
		const top = topTris.map(b => local.get(b));
		const baseQ = Math.round((baseSum / baseN) / PRISM_Q), hQ = Math.round((topSum / topN - baseSum / baseN) / PRISM_Q);
		if (hQ <= 0) return null;
		return { tier: tierOf(tris[0] * 3, lodCounts), base: baseQ, h: hQ, rings: ringQ, top, bottom: bottomTris > 0 };
	}
}

// 角柱 → メッシュ（押し出し）。壁＝辺ごとに 4 頂点（外向き法線）・天＝リング頂点（U）・底＝同（−U・bottom 時）。
// 出力は溶接済み相当（面ごとに頂点）。戻り値 { pos, nrm, idx }（origin 相対 f32）。角柱 p の index 数＝6Σm＋天(+底)。
export function extrudePrisms(prisms, origin) {
	const { E, N, U } = enuBasis(origin);
	let nvT = 0, niT = 0;
	for (const p of prisms) { let m = 0; for (const r of p.rings) m += r.length; nvT += 5 * m + (p.bottom ? m : 0); niT += 6 * m + p.top.length * (p.bottom ? 2 : 1); }
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
				const [e0, n0] = ring[i], [e1, n1] = ring[(i + 1) % m];
				const de = e1 - e0, dn = n1 - n0, L = Math.hypot(de, dn) || 1;
				const wx = dn / L, wy = -de / L;   // CCW 外周の外向き（穴は CW＝穴側から見て外向き）
				const nx = q8(wx * E[0] + wy * N[0]), ny = q8(wx * E[1] + wy * N[1]), nz = q8(wx * E[2] + wy * N[2]);
				const a = put(e0, n0, b, nx, ny, nz), c = put(e1, n1, b, nx, ny, nz), d = put(e1, n1, t, nx, ny, nz), f = put(e0, n0, t, nx, ny, nz);
				idx[io++] = a; idx[io++] = c; idx[io++] = d; idx[io++] = a; idx[io++] = d; idx[io++] = f;
			}
		}
		const topBase = vo;   // 天
		for (const ring of p.rings) for (const [e, n] of ring) put(e, n, t, upN[0], upN[1], upN[2]);
		for (let k = 0; k < p.top.length; k++) idx[io++] = topBase + p.top[k];
		if (p.bottom) {   // 底（天の鏡像＝同じ三角形分割・巻きを反転）
			const botBase = vo;
			for (const ring of p.rings) for (const [e, n] of ring) put(e, n, b, dnN[0], dnN[1], dnN[2]);
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
		po.varint(p.bottom ? 1 : 0); po.zig(p.base); po.varint(p.h);
		po.varint(p.rings.length);
		let pe = 0, pn = 0;
		for (const r of p.rings) { po.varint(r.length); for (const [e, n] of r) { po.zig(e - pe); po.zig(n - pn); pe = e; pn = n; } }
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
export function unpackPLQ(u8) {
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
			for (let r = 0; r < nr; r++) { const m = rd.varint(), ring = new Array(m); for (let j = 0; j < m; j++) { pe += rd.zig(); pn += rd.zig(); ring[j] = [pe, pn]; } rings.push(ring); }
			const ntp = rd.varint(), top = new Array(ntp * 3);
			for (let j = 0; j < ntp * 3; j++) top[j] = rd.varint();
			prisms.push({ tier: k, base: b, h: hh, rings, top, bottom: !!(flags & 1) });
		}
		const ex = extrudePrisms(prisms, h.origin);
		const perPrism = prisms.map(p => { let m = 0; for (const r of p.rings) m += r.length; return 6 * m + p.top.length * (p.bottom ? 2 : 1); });
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
	} catch { return null; }
}
