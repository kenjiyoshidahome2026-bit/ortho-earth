// デコード済みMVT + style.json → 描画op列（style層の順＝厳密な painter順）。
// 各 style層が1つの op（fill or line）になり、renderer はこの順にそのまま描く。
// 投影非依存の部分だけ担当：幾何を経緯度に戻し、シーン原点からの delta(float32) と地物ごとの色/線幅を確定。
// 線幅はスクリーン空間の定px（fat-line/capsule 展開は頂点シェーダ側）。
import earcut from "earcut";

// 一番上（pole=1）／下（pole=-1）の行のタイル：上端（py≤0）／下端（py≥extent）に沿う「境界の辺」（1 つの三角形にしか属さない辺）から、極の 1 頂点へ扇を張る。
// 極の頂点はタイル座標では表せない＝末尾に置き、呼び手が経緯度（緯度 ±90）を直に書く。境界の辺が無ければ何もしない（配列はそのまま返す）
export function extendToPole(flat, tris, extent, pole) {
	const onEdge = i => (pole > 0 ? flat[i * 2 + 1] <= 0 : flat[i * 2 + 1] >= extent);
	const cnt = new Map(), key = (i, j) => (i < j ? i * 4294967296 + j : j * 4294967296 + i);
	for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) { const i = tris[t + k], j = tris[t + (k + 1) % 3]; if (onEdge(i) && onEdge(j)) { const kk = key(i, j); cnt.set(kk, (cnt.get(kk) || 0) + 1); } }
	const edges = [];
	for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) { const i = tris[t + k], j = tris[t + (k + 1) % 3]; if (onEdge(i) && onEdge(j) && cnt.get(key(i, j)) === 1) edges.push(i, j); }
	if (!edges.length) return [flat, tris];
	const pts = Array.from(flat), out = Array.from(tris), p = pts.length >> 1;
	pts.push(0, pole > 0 ? -extent : 2 * extent);   // 仮の座標（呼び手が経緯度を上書きする）
	for (let e = 0; e < edges.length; e += 2) out.push(edges[e], edges[e + 1], p);   // 向きは境界の辺の向きに従う（塗りは両面）
	return [pts, out];
}
// 三角形の集合を「辺の長さ ≤ maxLen（タイル単位）」まで最長辺の二等分で細分（共有辺の中点は 1 回だけ作る＝隙間なし）。戻り＝[flat（x,y,…）, tris（index）]
// 多角形（外周＋穴・タイル単位）を四角 [0,extent]² で切り抜く（Sutherland–Hodgman・凸の窓なので環ごとに独立に切ってよい）。
// 全部が窓の中なら元の配列をそのまま返す（コピー無し）。外周が消えたら null。空になった穴は捨てる
export function clipToExtent(flat, holes, extent) {
	let inside = true;
	for (let i = 0; i < flat.length && inside; i += 2) if (flat[i] < 0 || flat[i] > extent || flat[i + 1] < 0 || flat[i + 1] > extent) inside = false;
	if (inside) return [flat, holes];
	// 環を窓の 4 辺で順に切る（ping-pong の 2 本の作業配列・旧＝辺ごとに JS 配列を作っていた＝式と順はそのまま＝ビット同値）
	const ring = (s, e) => {
		if (clipA.length < e - s) clipA = new Float64Array(e - s);
		let src = clipA, dst = clipB, m = e - s;
		for (let i = 0; i < m; i++) src[i] = flat[s + i];
		for (let side = 0; side < 4 && m; side++) {
			const ax = side & 1, hi = side >= 2;   // side: 0=x≥0 1=y≥0 2=x≤extent 3=y≤extent
			const n = m >> 1; let o = 0;
			if (dst.length < 2 * m) { dst = new Float64Array(2 * m); if (src === clipA) clipB = dst; else clipA = dst; }   // 1 辺で切ると各頂点は高々 2 点（自分＋交点）
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n, px = src[i * 2], py = src[i * 2 + 1], qx = src[j * 2], qy = src[j * 2 + 1];
				const pv = ax ? py : px, qv = ax ? qy : qx, pi = hi ? pv <= extent : pv >= 0, qi = hi ? qv <= extent : qv >= 0;
				if (pi) { dst[o++] = px; dst[o++] = py; }
				if (pi !== qi) {   // 辺が窓の縁を跨ぐ＝交点を足す
					const b = hi ? extent : 0, t = ax ? (b - py) / (qy - py) : (b - px) / (qx - px);
					dst[o++] = ax ? px + (qx - px) * t : b; dst[o++] = ax ? b : py + (qy - py) * t;
				}
			}
			const tmp = src; src = dst; dst = tmp; m = o;
		}
		return m >= 6 ? src.slice(0, m) : null;
	};
	const bounds = [0, ...holes.map(h => h * 2), flat.length];
	const outer = ring(bounds[0], bounds[1]); if (!outer) return null;
	const parts = [outer], hs = [];
	let len = outer.length;
	for (let k = 1; k + 1 < bounds.length; k++) { const h = ring(bounds[k], bounds[k + 1]); if (h) { hs.push(len >> 1); parts.push(h); len += h.length; } }
	if (parts.length === 1) return [outer, hs];
	const pts = new Float64Array(len); let o = 0;
	for (const p of parts) { pts.set(p, o); o += p.length; }
	return [pts, hs];
}
let clipA = new Float64Array(1024), clipB = new Float64Array(1024);   // clipToExtent の作業配列（伸びるだけ・worker ごと）

// 線分の両端がタイルの同じ側の外（余白＝buffer の中）＝MapLibre ならステンシルで見えない線分。ポリゴンの輪郭を線で描く層（demotiles の countries-boundary）は
// タイル生成側が余白の縁で切った辺（x＝−buffer／extent＋buffer に沿う縦横の直線）を持ち、描くとタイルの境の両脇に白い二重線が出る（2026-09-30 本人の写し・回転した視点では 45°）。
// 境をまたぐ線分は丸ごと残す（継ぎ目の join のため）
const outsideSameSide = (ax, ay, bx, by, extent) => (ax < 0 && bx < 0) || (ax > extent && bx > extent) || (ay < 0 && by < 0) || (ay > extent && by > extent);
// 三角形を格子（マス幅 cell・タイル単位）で切り分ける＝MapLibre の subdivideFill と同じ「格子で切る」細分。
// 旧＝最長辺の二等分：隣の三角形が同じ辺を割らないと T 字の接点ができ、球の上では割った側の中点は球面に乗り・割らない側の辺は弦のまま沈む
// ＝その差が 45° の白い筋（低ズームの demotiles・2026-09-30 本人の写し）。格子線との交点は辺の向きに依らず同じ式で出す＝隣同士が必ず同じ頂点を共有＝継ぎ目なし
export function subdivideTris(flat, tris, cell) {
	const pts = Array.from(flat), out = [], seen = new Map();
	const addPt = (x, y) => { const k = x + "," + y; let r = seen.get(k); if (r === undefined) { r = pts.length >> 1; pts.push(x, y); seen.set(k, r); } return r; };
	// 辺 (p,q) と格子線 axis=v の交点＝頂点添字の小さい方を始点に計算（向きに依らずビット同値）
	const cut = (p, q, ax, v) => {
		if (p > q) { const t = p; p = q; q = t; }
		const pc = pts[p * 2 + ax], qc = pts[q * 2 + ax], po = pts[p * 2 + 1 - ax], qo = pts[q * 2 + 1 - ax], o = po + (qo - po) * ((v - pc) / (qc - pc));
		return ax ? addPt(o, v) : addPt(v, o);
	};
	let guard = 0;
	const split = poly => {
		if (guard++ > 4e6) return;
		const n = poly.length;
		let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
		for (const i of poly) { const x = pts[i * 2], y = pts[i * 2 + 1]; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
		// 箱の中を通る格子線（端を含まない）：多い方の軸の真ん中の 1 本で二分＝再帰の深さ log
		const kx0 = Math.floor(minx / cell) + 1, kx1 = Math.ceil(maxx / cell) - 1, ky0 = Math.floor(miny / cell) + 1, ky1 = Math.ceil(maxy / cell) - 1;
		const nx = Math.max(0, kx1 - kx0 + 1), ny = Math.max(0, ky1 - ky0 + 1);
		if (!nx && !ny) { for (let i = 1; i + 1 < n; i++) out.push(poly[0], poly[i], poly[i + 1]); return; }   // 凸多角形＝扇
		const ax = nx >= ny ? 0 : 1, v = (ax ? ky0 + (ny >> 1) : kx0 + (nx >> 1)) * cell;
		const lo = [], hi = [];
		for (let i = 0; i < n; i++) {
			const p = poly[i], q = poly[(i + 1) % n], pc = pts[p * 2 + ax], qc = pts[q * 2 + ax];
			if (pc <= v) lo.push(p); if (pc >= v) hi.push(p);
			if ((pc < v && qc > v) || (pc > v && qc < v)) { const m = cut(p, q, ax, v); lo.push(m); hi.push(m); }
		}
		if (lo.length >= 3) split(lo); if (hi.length >= 3) split(hi);
	};
	for (let t = 0; t < tris.length; t += 3) split([tris[t], tris[t + 1], tris[t + 2]]);
	return [pts, out];
}
import { evalExpr, truthy, originOfLayer } from "./expr.js";   // originOfLayer＝MapLibre の文書から来た層は MapLibre の意味で評価（ctx.origin・2026-09-26）
import { parseRGBA } from "./color.js";
import { tileLocalToLonLat } from "./tile.js";
import { polygons, signedArea } from "./decode.js";   // フラットgeom({coords,ends})→[flat, holes]（buildings と共用）
import { SEA_FB_BASE } from "./scene.js";

// 組み立ての出力の伸びる型付き配列（層ごとに reset・最後に out() で必要な長さだけ写す）。旧＝JS の数の配列へ push して最後に Float32Array(配列)＝
// 伸びるたびの付け替え・倍精度の箱・2 度目の写しが組み立ての GC の大半だった。Float32Array へ直に書く丸めは Float32Array(配列) と同じ（ビット同値）。
// 組み立ては同期＝worker の中で入れ子にならない限り使い回してよい（入れ子＝buildEmptySeaOps から呼ぶ時は depth で新しい物を作る）
class Grow {
	constructor(T, n = 4096) { this.T = T; this.a = new T(n); this.n = 0; }
	reserve(k) { if (this.n + k > this.a.length) { let m = this.a.length * 2; while (m < this.n + k) m *= 2; const b = new this.T(m); b.set(this.a.subarray(0, this.n)); this.a = b; } return this.a; }
	out(T = this.T) { return T === this.T ? this.a.slice(0, this.n) : T.from(this.a.subarray(0, this.n)); }
}
const newBufs = () => ({ pos: new Grow(Float32Array), col: new Grow(Uint8Array), idx: new Grow(Uint32Array), P1: new Grow(Float32Array), P2: new Grow(Float32Array), half: new Grow(Float32Array), off: new Grow(Float32Array) });
let sharedBufs = null, bufDepth = 0;
const LS = { p1: new Grow(Float32Array), p2: new Grow(Float32Array), r: new Grow(Uint32Array), k: new Grow(Uint32Array), fl: new Grow(Uint8Array) };   // lineSegs の作業（同期・入れ子にならない＝使い回す）

// line-dasharray の評価結果 → 模様（線,間,線,間…）。数でない・負・合計 0 は null（破線なし）。奇数個は MapLibre/SVG と同じく 2 回繰り返す
const NO_SLIDES = [[], []];
export function dashPattern(v) {
	if (!Array.isArray(v) || !v.length || v.some(x => typeof x !== "number" || !(x >= 0) || !isFinite(x))) return null;
	const p = v.length & 1 ? v.concat(v) : v;
	return p.reduce((a, b) => a + b, 0) > 0 ? p : null;
}

// line-offset の角の継ぎ（#49）：線分ごとに「始点・終点を線分の向きへ何倍ずらすか」（t）を頂点のマイターから求める。
// 頂点のマイター m＝(n0+n1)/(1+n0·n1)（n＝右の単位法線・|m|＝1/cos(θ/2)）。線分の座標系で m＝n＋d·t（m·n＝1）＝t＝m·d。
// シェーダは端点を off×(perp＋dir×t) だけ動かす＝隣の線分の端点と同じ所に着く（線分ごとの法線だけでずらすと、細かく折れる
// 海岸線・川が点々に散る＝2026-09-25 実描画で確認）。タイル座標（メルカトル＝等角・y 下向き＝画面と同じ向き）で測る。
// 端（閉じていない線の頭と尻）は 0・閉じた環は一周つなぐ・折り返し（180°）は 0・マイターの限界＝|t|≤1（それを超える鋭角は隙間/重なり）。
// 戻り＝[tS, tE]（線分 k＝点 k→k+1 の始点と終点の t）。長さ 0 の線分は隣の向きを借りる
export function miterSlides(coords, ls, le) {
	const n = (le - ls) >> 1, ns = Math.max(0, n - 1), tS = new Float32Array(ns), tE = new Float32Array(ns);
	if (ns < 1) return [tS, tE];
	const dx = new Float64Array(ns), dy = new Float64Array(ns);
	let has = false;
	for (let k = 0; k < ns; k++) {
		const i = ls + k * 2, ex = coords[i + 2] - coords[i], ey = coords[i + 3] - coords[i + 1], l = Math.hypot(ex, ey);
		if (l > 0) { dx[k] = ex / l; dy[k] = ey / l; has = true; } else dx[k] = NaN;
	}
	if (!has) return [tS, tE];
	for (let k = 0; k < ns; k++) if (isNaN(dx[k])) { let j = k - 1; while (j >= 0 && isNaN(dx[j])) j--; if (j < 0) { j = k + 1; while (isNaN(dx[j])) j++; } dx[k] = dx[j]; dy[k] = dy[j]; }
	const closed = n >= 4 && coords[ls] === coords[le - 2] && coords[ls + 1] === coords[le - 1];
	const lim = v => v > 1 ? 1 : v < -1 ? -1 : v;   // 限界＝|t|≤1（90° まで継ぐ）。それより鋭い角は継ぎを諦める（2 まで許すと画素級のぎざぎざで棘が出た）
	// 頂点 v（0..n-1）で入る線分 a・出る線分 b のマイターを線分 k の向きで測る
	const tAt = (a, b, k) => {
		const n0x = -dy[a], n0y = dx[a], n1x = -dy[b], n1y = dx[b], den = 1 + n0x * n1x + n0y * n1y;
		if (den < 1e-6) return 0;
		return lim(((n0x + n1x) * dx[k] + (n0y + n1y) * dy[k]) / den);
	};
	for (let k = 0; k < ns; k++) {
		const prev = k > 0 ? k - 1 : closed ? ns - 1 : -1, next = k < ns - 1 ? k + 1 : closed ? 0 : -1;
		tS[k] = prev < 0 ? 0 : tAt(prev, k, k);
		tE[k] = next < 0 ? 0 : tAt(k, next, k);
	}
	return [tS, tE];
}

// origin: [lon,lat] シーン原点（精度確保のため頂点は原点からの差分で持つ）
// pale: 色文字列→色文字列 の変換（無ければ恒等）
// subLenM＝線の細分の長さ（m・既定 700＝基図）。利用者の vector の層（段 8⑤）は低ズームのタイルで細分が膨れないよう長くして渡す
// stateOf＝地物 → その feature-state（#109・省略可）。paint の ["feature-state", k] だけが読む（filter と sort-key は読まない＝MapLibre と同じ）。
//   渡すのは利用者の vector の描く層（globe の vtdraw）だけ＝基図は渡さない＝今と同じ絵（黄金の写しは不変）・層の中の sort-key の順も崩れない
export function buildTileDrawList(tile, style, origin, pale = c => c) {
	const B = bufDepth++ === 0 ? (sharedBufs ??= newBufs()) : newBufs();
	try { return buildTileDrawList1(tile, style, origin, pale, B); } finally { bufDepth--; }
}
function buildTileDrawList1({ layers, z, x, y, subLenM = 700, stateOf = null }, style, origin, pale, B) {
	const [ox, oy] = origin;
	const ops = [];   // { kind:'fill'|'line', li, ... } を style層順に（li=style層index、跨ぎバッチ結合用）
	// タイルローカル(0..extent) → 経緯度(原点相対) を out[oi],out[oi+1] へ直書き。x,y,n はタイル内で不変なので
	// ここで一度だけ捕獲し、毎頂点の一時配列 [lon,lat] 生成を廃す（＝GC削減）。extent は層毎に渡す。
	const nTiles = 1 << z, R2D = 180 / Math.PI, HALF_PI = Math.PI / 2;
	// 緯度（メルカトルの逆・atan＋exp）は整数の py（MVT の頂点はほぼ全部）ごとに一度だけ計算して覚える＝同じ式・同じ値（ビット同値）。
	// 覚えは層の extent ごと（通常は全層 4096）・範囲は余白込みの [−extent, 2·extent)。切り口の交点・線の細分の点（小数）は毎回計算
	let latE = 0, latC = null;
	const latOf = (py, extent) => {
		if (Number.isInteger(py) && py >= -extent && py < 2 * extent) {
			if (latE !== extent) { latE = extent; latC = new Float64Array(3 * extent).fill(NaN); }
			const i = py + extent, v = latC[i];
			if (v === v) return v;
			return (latC[i] = R2D * (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * ((y + py / extent) / nTiles)))) - HALF_PI) - oy);
		}
		return R2D * (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * ((y + py / extent) / nTiles)))) - HALF_PI) - oy;
	};
	const llInto = (px, py, extent, out, oi) => {
		const wx = (x + px / extent) / nTiles;
		out[oi] = (wx * 360 - 180) - ox;
		out[oi + 1] = latOf(py, extent);
	};
	const sc = new Float64Array(2);    // line 用スクラッチ（1頂点）＝毎回の一時配列を作らない
	let llBuf = new Float64Array(0);   // fill 用：ポリゴン頂点の経緯度を貯める再利用バッファ（最大サイズまで成長）
	// 頂点色は Uint8×4（正規化attribでGLへ）：float32×4 だと fill 頂点24Bの2/3が色＝実質8bit精度のデータに
	// バス幅の2/3を割いていた。バイト化で tess出力→transfer→常駐→merge→upload の全段が縮む。
	const b255 = v => v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
	// 線分細分の閾値（タイル単位）：地形にドレープする際、長い直線が尾根で折れないよう ~700m 毎に分割。
	const [, cLat] = tileLocalToLonLat(x, y, z, 2048, 2048, 4096);
	const mPerUnit = 40075016.686 * Math.cos(cLat * Math.PI / 180) / (Math.pow(2, z) * 4096);
	const subLen = Math.max(1, subLenM / mPerUnit);   // 700m（既定）相当のタイル単位

	// 塗りの地物の幾何（切り抜き→三角形分割→細分→極の扇→経緯度）は色に依らない＝地物ごとに一度だけ作って層を跨いで使い回す。
	// 基図は同じ source-layer の地物を複数の fill 層（water／water-hi 等）が塗る＝旧は同じ地物を層の数だけ earcut していた（optbv の見本で全て 2 回）。
	// 戻り＝[{ ll: Float32Array（経緯度・原点相対）, tris }]（塗りの頂点は Float32 で運ぶ＝旧と同じ丸め）
	const fillCache = new Map();
	const fillSub0 = z <= 6;
	const fillParts = (geom, extent) => {
		let parts = fillCache.get(geom);
		if (parts) return parts;
		parts = [];
		const fillSub = fillSub0 ? extent / Math.max(1, 128 >> z) : 0;   // 細分の格子のマス幅（タイル単位）＝MapLibre の granularity 128/2^z（z0＝128 マス）。z≥7 は細分しない
		for (const [flatRaw, holesRaw] of polygons(geom)) {
			// タイルの extent で切り抜く（MapLibre はタイルごとにステンシルで extent の外を捨てる）：MVT の余白（buffer）を隣同士が両方描くと
			// 半透明の塗りが二重に重なり縁に濃い帯が出る・ズーム中はタイルが替わる度に帯が動く＝「塗りがチラチラ」（2026-09-30 本人）
			const clipped = clipToExtent(flatRaw, holesRaw, extent); if (!clipped) continue;
			const [flat0, holes] = clipped;
			const tris0 = earcut(flat0, holes, 2);
			if (!tris0.length) continue;
			// 低ズームの塗りは球の上で細分（MapLibre の globe の subdivisionGranularity fill＝128/2^z・z≥7 は無し）：
			// 粗い三角形は弦＝球の内側に沈み、縁では頂点が裏でも面の一部が表＝v_front の補間と弦の沈みで縁の帯が塗られない（極を見下ろす z1 の海＝八角形に欠けた・2026-09-30）
			const [flat1, tris1] = fillSub > 0 ? subdivideTris(flat0, tris0, fillSub) : [flat0, tris0];
			// 極まで延ばす（MapLibre の extendToNorthPole／SouthPole）：一番上／下の行のタイルで、上端（py≤0）／下端（py≥extent）に沿う境界の辺から極の 1 頂点へ扇を張る
			// ＝北極海・南極大陸がメルカトルの端（85.05°）で切れず極まで塗られる（旧＝極の周りが球の地の色・2026-09-30）。極の頂点は経緯度を直に書く（下の poleAt）
			const poleAt = fillSub > 0 && y === 0 ? 1 : fillSub > 0 && y === nTiles - 1 ? -1 : 0;
			const [flat, tris] = poleAt ? extendToPole(flat1, tris1, extent, poleAt) : [flat1, tris1];
			// ユニーク頂点を一度だけ経緯度化（原点相対）→ 三角形は共有頂点をインデックスで引く。
			if (llBuf.length < flat.length) llBuf = new Float64Array(flat.length);
			for (let i = 0; i < flat.length; i += 2) llInto(flat[i], flat[i + 1], extent, llBuf, i);
			if (poleAt && flat.length > flat1.length) { const i = flat.length - 2; llBuf[i] = ((x + 0.5) / nTiles) * 360 - 180 - ox; llBuf[i + 1] = 90 * poleAt - oy; }   // 極の頂点（最後の 1 個）＝経緯度を直に
			parts.push({ ll: Float32Array.from(llBuf.subarray(0, flat.length)), tris });
		}
		fillCache.set(geom, parts);
		return parts;
	};

	// 破線でない線の線分列（色・幅に依らない）＝地物ごとに一度だけ作る。細分点を含む頂点を一度だけ経緯度化し、連続ペアを線分に
	// （隣接サブ線分＝隣接線分が端点を共有＝「サブ線分ごとに両端を変換」の重複なし）。余白だけを走る線分は描かない（outsideSameSide）。
	// 戻り＝{ n, p1, p2（Float32・経緯度・原点相対）, r（環の番号）, k（環の中の元の線分の番号）, fl（1＝元の線分の最初の小片・2＝最後の小片）, rs/re（環の始終の添字） }
	const lineCache = new Map();
	const lineSegs = (geom, extent) => {
		let g = lineCache.get(geom);
		if (g) return g;
		const { coords, ends } = geom, p1 = LS.p1, p2 = LS.p2, rr = LS.r, kk = LS.k, fl = LS.fl, rs = [], re = [];
		p1.n = p2.n = rr.n = kk.n = fl.n = 0;
		let ls = 0;
		for (let r = 0; r < ends.length; r++) {
			const le = ends[r];
			rs.push(ls); re.push(le);
			if (le - ls < 4) { ls = le; continue; }   // 2点未満
			llInto(coords[ls], coords[ls + 1], extent, sc, 0);
			let pLon = sc[0], pLat = sc[1];
			for (let i = ls + 2; i < le; i += 2) {
				const Ax = coords[i - 2], Ay = coords[i - 1];
				if (outsideSameSide(Ax, Ay, coords[i], coords[i + 1], extent)) { llInto(coords[i], coords[i + 1], extent, sc, 0); pLon = sc[0]; pLat = sc[1]; continue; }   // 余白だけを走る線分＝描かない（下の outsideSameSide）
				const dx = coords[i] - Ax, dy = coords[i + 1] - Ay;
				const steps = Math.min(24, Math.max(1, Math.ceil(Math.hypot(dx, dy) / subLen)));  // 地形ドレープ用に細分
				const k = (i - ls - 2) >> 1;
				for (let s = 1; s <= steps; s++) {
					const t = s / steps;
					llInto(Ax + dx * t, Ay + dy * t, extent, sc, 0);
					const a1 = p1.reserve(2), a2 = p2.reserve(2);
					a1[p1.n++] = pLon; a1[p1.n++] = pLat; a2[p2.n++] = sc[0]; a2[p2.n++] = sc[1];
					rr.reserve(1)[rr.n++] = r; kk.reserve(1)[kk.n++] = k; fl.reserve(1)[fl.n++] = (s === 1 ? 1 : 0) | (s === steps ? 2 : 0);
					pLon = sc[0]; pLat = sc[1];
				}
			}
			ls = le;
		}
		g = { n: rr.n, p1: p1.out(), p2: p2.out(), r: rr.out(), k: kk.out(), fl: fl.out(), rs, re };
		lineCache.set(geom, g);
		return g;
	};

	for (let li = 0; li < style.layers.length; li++) {
		const L = style.layers[li], eo = originOfLayer(L);   // eo＝式の出自（引数 origin はシーンの原点＝別物）
		if (L.type !== "fill" && L.type !== "line") continue;
		if (L.layout && L.layout.visibility === "none") continue;
		if (L.minzoom != null && z < L.minzoom) continue;
		if (L.maxzoom != null && z >= L.maxzoom) continue;
		const src = layers[L["source-layer"]]; if (!src) continue;
		const extent = src.extent;
		// filter で残る地物だけを line-sort-key/fill-sort-key の昇順に（高い値ほど後＝上に描く）。std は道路を vt_drworder で並べる。
		// 旧＝層の全地物を並べてから filter＝同じ source-layer（road）を読む層の数だけ全地物の sort-key を評価して並べていた
		const feats = filterSortFeatures(src.features, L.filter, L.layout?.["line-sort-key"] ?? L.layout?.["fill-sort-key"], z, eo);

		if (L.type === "fill") {
			// インデックス描画：ユニーク頂点(pos/col)＋三角形index。スープ展開（3頂点/三角形）をやめ、
			// 頂点は一度だけ持つ＝典型ポリゴン(tris≈verts)でバイト2/3・GPUのpost-transform cacheも効く。
			const pos = B.pos, col = B.col, idx = B.idx; pos.n = col.n = idx.n = 0;
			const ctx = { zoom: z, props: null, geom: null, vars: {}, origin: eo, state: undefined };   // feature 間で使い回す（compile 済み evalExpr は ctx を保持しない＝安全）
			for (const f of feats) {
				ctx.props = f.props; ctx.geom = f.type; ctx.state = undefined;   // filter は filterSortFeatures で済んでいる
				if (stateOf) ctx.state = stateOf(f);   // filter の後＝paint だけが読む
				const c = parseRGBA(pale(evalExpr(L.paint?.["fill-color"] ?? "#000", ctx)));
				const op = L.paint?.["fill-opacity"], ov = op != null ? evalExpr(op, ctx) : 1; const a = c[3] * (ov === undefined && eo ? 1 : ov);   // ML の評価エラー＝既定 1
				const cr = b255(c[0]), cg = b255(c[1]), cb = b255(c[2]), ca = b255(a);
				for (const part of fillParts(f.geom, extent)) {
					const ll = part.ll, tris = part.tris, base = pos.n >> 1, nv = ll.length >> 1;
					const pa = pos.reserve(nv * 2), ca4 = col.reserve(nv * 4);
					pa.set(ll, pos.n);
					for (let i = 0, cn = col.n; i < nv; i++) { ca4[cn++] = cr; ca4[cn++] = cg; ca4[cn++] = cb; ca4[cn++] = ca; }
					pos.n += nv * 2; col.n += nv * 4;
					const ia = idx.reserve(tris.length); let inn = idx.n;
					for (let t = 0; t < tris.length; t++) ia[inn++] = base + tris[t];
					idx.n = inn;
				}
			}
			// index はタイル単体なら大抵 Uint16 で足りる（65536頂点超の層だけ Uint32）＝transfer/常駐がさらに半減。
			// merge 側は結合時に常に Uint32 へ広げる（結合後は頂点数が容易に 65k を超える）。
			if (pos.n) ops.push({ kind: "fill", li, id: L.id, pos: pos.out(), col: col.out(), idx: idx.out(pos.n >> 1 <= 65535 ? Uint16Array : Uint32Array) });
		} else { // line
			const P1 = B.P1, P2 = B.P2, col = B.col, half = B.half; P1.n = P2.n = col.n = half.n = 0;
			// line-offset（MapLibre 互換の口・#49）：線を進行方向の右（正）／左（負）へ平行にずらす＝画面 px（線幅と同じ単位）。
			// ずらしは頂点シェーダが画面空間で掛ける＝ここは線分ごとに [off, tS, tE]（角の継ぎ＝miterSlides）を添えるだけ。
			// 層が持つ時だけ配列を作る（無い層は 0 バイト）
			const offExpr = L.paint?.["line-offset"], off = offExpr != null ? B.off : null; if (off) off.n = 0;
			// line-dasharray [線, 間隔, …]：走行距離の位相を保って線分を刻む。
			// renderer の capsule は丸端なので、刻んだ破片がそのままピル状のダッシュになる（トンネル破線等）。
			// 値は式として評価する（["literal",[..]]・step/interpolate・旧式関数の変換物）＝MapLibre でも zoom だけに依る＝層で一度。
			// 単位：内蔵 style は px（タイル基準ズームでの見かけ）、外来 MapLibre style（dashInLineWidths）は線幅の倍数。
			// 読めない値は破線なし（実線）に倒す＝線ごと消さない（2026-09-25・旧版は NaN で片が 0 になり線が消えた）
			const dashPat = dashPattern(evalExpr(L.paint?.["line-dasharray"] ?? null, { zoom: z, props: {}, geom: null, vars: {}, origin: eo }));
			const ctx = { zoom: z, props: null, geom: null, vars: {}, origin: eo, state: undefined };   // feature 間で使い回す（compile 済み evalExpr は ctx を保持しない＝安全）
			for (const f of feats) {
				ctx.props = f.props; ctx.geom = f.type; ctx.state = undefined;   // filter は filterSortFeatures で済んでいる
				if (stateOf) ctx.state = stateOf(f);   // filter の後＝paint だけが読む
				const c = parseRGBA(pale(evalExpr(L.paint?.["line-color"] ?? "#000", ctx)));
				const op = L.paint?.["line-opacity"], ov = op != null ? evalExpr(op, ctx) : 1; const a = c[3] * (ov === undefined && eo ? 1 : ov);   // ML の評価エラー＝既定 1
				const cr = b255(c[0]), cg = b255(c[1]), cb = b255(c[2]), ca = b255(a);
				let w = evalExpr(L.paint?.["line-width"] ?? 1, ctx);
				if (typeof w !== "number" || isNaN(w) || w <= 0) w = 1;
				const hw = w * 0.5;
				let ow = 0;
				if (off) { ow = +evalExpr(offExpr, ctx); if (!isFinite(ow)) ow = 0; }
				// 線分 1 本を書く（P1＝始点・P2＝終点の経緯度（原点相対）・色・半幅・ずらし）
				const seg = (alon, alat, blon, blat, ta, tb) => {
					const n = half.n, p1 = P1.reserve(2), p2 = P2.reserve(2), c4 = col.reserve(4), hf = half.reserve(1);
					p1[n * 2] = alon; p1[n * 2 + 1] = alat; p2[n * 2] = blon; p2[n * 2 + 1] = blat;
					c4[n * 4] = cr; c4[n * 4 + 1] = cg; c4[n * 4 + 2] = cb; c4[n * 4 + 3] = ca; hf[n] = hw;
					P1.n += 2; P2.n += 2; col.n += 4; half.n++;
					if (off) { const o = off.reserve(3); o[off.n++] = ow; o[off.n++] = ta; o[off.n++] = tb; }
				};
				const emit = (ax, ay, bx, by, ta, tb) => {
					llInto(ax, ay, extent, sc, 0); const alon = sc[0], alat = sc[1];
					llInto(bx, by, extent, sc, 0);
					seg(alon, alat, sc[0], sc[1], ta, tb);
				};
				// フラットgeom：coords([x,y,…]) を ends の区切りで線/リング毎に走査（添字直読み＝Point中間なし）
				const { coords, ends } = f.geom;
				if (!dashPat) {   // 破線でない線＝地物ごとに一度だけ作った線分列（lineSegs）を写す＝ケーシングと本線など同じ地物を描く層の数だけ経緯度化・細分をやり直さない
					const g = lineSegs(f.geom, extent), n = g.n;
					if (!n) continue;
					P1.reserve(n * 2).set(g.p1, P1.n); P2.reserve(n * 2).set(g.p2, P2.n);
					const c4 = col.reserve(n * 4), hf = half.reserve(n);
					for (let j = 0, cn = col.n, hn = half.n; j < n; j++) { c4[cn++] = cr; c4[cn++] = cg; c4[cn++] = cb; c4[cn++] = ca; hf[hn++] = hw; }
					P1.n += n * 2; P2.n += n * 2; col.n += n * 4; half.n += n;
					if (off) {
						const sl = ow ? g.rs.map((s0, r) => miterSlides(coords, s0, g.re[r])) : null;   // 線分 k＝点 (ls+2k)→(ls+2k+2)
						const o = off.reserve(n * 3); let on = off.n;
						for (let j = 0; j < n; j++) {
							const fl = g.fl[j], k = g.k[j], sr = sl ? sl[g.r[j]] : NO_SLIDES;
							o[on++] = ow; o[on++] = fl & 1 ? sr[0][k] ?? 0 : 0; o[on++] = fl & 2 ? sr[1][k] ?? 0 : 0;   // 細分の途中は直線＝0
						}
						off.n = on;
					}
					continue;
				}
				let ls = 0;
				for (let r = 0; r < ends.length; r++) {
					const le = ends[r];
					const [tS, tE] = ow ? miterSlides(coords, ls, le) : NO_SLIDES;   // 線分 k＝点 (ls+2k)→(ls+2k+2)
					if (dashPat) {
						const k = (L.dashInLineWidths ? w : 1) * extent / 256;   // 模様の 1 単位＝タイル単位
						let pi = 0, rem = dashPat[0] * k;   // 模様の何番目か（偶数＝線・奇数＝間）とその残り。頂点をまたいで継続＝角でダッシュが割れない
						for (let i = ls; i + 3 < le; i += 2) {   // 線分＝点(i)→点(i+2)
							const Ax = coords[i], Ay = coords[i + 1];
							const dx = coords[i + 2] - Ax, dy = coords[i + 3] - Ay, len = Math.hypot(dx, dy);
							if (!len) continue;
							const hidden = outsideSameSide(Ax, Ay, coords[i + 2], coords[i + 3], extent);   // 余白だけの線分＝模様の位相は進めて描かない
							let pos = 0;
							while (pos < len - 1e-9) {
								const take = Math.min(rem, len - pos);
								if (!(pi & 1) && take > 0 && !hidden) { const k = (i - ls) >> 1; emit(Ax + dx * (pos / len), Ay + dy * (pos / len), Ax + dx * ((pos + take) / len), Ay + dy * ((pos + take) / len), pos === 0 ? tS[k] ?? 0 : 0, pos + take >= len - 1e-9 ? tE[k] ?? 0 : 0); }
								pos += take; rem -= take;
								if (rem <= 1e-9) { pi = (pi + 1) % dashPat.length; rem = dashPat[pi] * k; }
							}
						}
						ls = le; continue;
					}
					ls = le;
				}
			}
			if (half.n) {
				const op = { kind: "line", li, id: L.id, P1: P1.out(), P2: P2.out(), col: col.out(), half: half.out() };
				if (off) { let any = false; for (let i = 0; i < off.n; i += 3) if (off.a[i]) { any = true; break; } if (any) op.off = off.out(); }   // [off, tS, tE]×線分。ずらしが全部 0（式が今の z で 0）なら持たない
				ops.push(op);
			}
		}
	}
	return { ops };
}

// 図郭外に敷く「標高ゲート付き全面水域」op列（フォールバック水域）。
// GSI 自身が z8+ の提供圏内の外洋・外国領土に配る全面WAダミー（57B・全面ポリゴン一枚）の自前版：
// style.emptySea（水層の id・app がオプトイン）と同じ source-layer を使う全 fill 層（water＋water-hi 等）の
// 色・式で全面ポリゴンを焼き、li を擬似帯 SEA_FB_BASE+実li へ付け替える（実層より下・チップ連動は merge が
// seaFbReal で還元）。renderer はこの帯で u_seaGate=1 を立て、FS が elev(v_ll)>0 の画素を discard
// ＝「水域は地理院・陸は標高(GEBCO/R10)」の管轄裁定を画素単位で行う（韓国等が偽の白い陸になる件の根治）。
// 敷く条件（z≥8。z<8 は GSI 自身も全面WAを配らない紙の海の領分。表示は renderer の sea.minzoom にも従う）:
//  (a) __empty＝404/204＝提供図郭の完全な外
//  (b) タイルの中身が「WA だけ・しかも全面を覆わない」＝図郭の縁のダミー（マスクで刈られた WA スライバが
//      1個だけ残る 51B 級タイル。日本の実タイルは陸があれば AdmArea/道路等を必ず伴うので誤爆しない。
//      純外洋で WA 全面のものは覆率≈1 で除外＝既に青いので敷く必要がない）
export function buildEmptySeaOps(layers, { z, x, y }, style, origin) {
	const id = style.emptySea; if (!id || z < 8) return null;
	const base = style.layers.find(L => L.id === id); if (!base) return null;
	const src = base["source-layer"];
	if (!layers.__empty && !waOnlyPartial(layers, src)) return null;
	const idxs = [];
	style.layers.forEach((L, i) => { if (L.type === "fill" && L["source-layer"] === src) idxs.push(i); });
	if (!idxs.length) return null;
	const sq = { [src]: { extent: 4096, features: [{ type: "Polygon", id: 0, props: style.schema && style.schema.seaProps || {},   // 申告された「海の名乗り」（色式が属性を見る style でも水色に転ぶ）
		geom: { coords: new Int32Array([0, 0, 4096, 0, 4096, 4096, 0, 4096, 0, 0]), ends: [10] } }] } };
	const dl = buildTileDrawList({ layers: sq, z, x, y }, { layers: idxs.map(i => style.layers[i]) }, origin);
	for (const op of dl.ops) { op.li = SEA_FB_BASE + idxs[op.li]; op.id = "empty-sea:" + op.id; }   // sub-style の li(0..)→実li→擬似帯
	return dl.ops.length ? dl.ops : null;
}
// 「WA しか無く、その WA が全面を覆っていない」＝図郭縁ダミーの判定（覆率 99.5% 未満）。穴は無い前提の |面積| 和。
function waOnlyPartial(layers, src) {
	const names = Object.keys(layers); if (names.length !== 1 || names[0] !== src) return false;
	const { extent, features } = layers[src];
	let area = 0;
	for (const f of features) {
		if (f.type !== "Polygon") continue;
		const { coords, ends } = f.geom; let p = 0;
		for (const e of ends) { area += Math.abs(signedArea(coords, p, e)); p = e; }
	}
	return area < extent * extent * 0.995;
}

// 層の filter に通る地物を、sort-key 式があれば昇順に並べ替える（安定ソート）。無ければ元順のまま。
// filter が先＝落ちる地物の sort-key は評価も並べ替えもしない。並べる順は「全地物を並べてから filter」と同じ（比較＝(鍵, 元の添字)の全順序）。
// ただし鍵に NaN（数でない sort-key）が混ざる時だけは比較が全順序でなく、並べ替えの結果が集合の大きさに依る＝旧来の順（全地物を並べてから filter）で並べる＝絵を変えない
function filterSortFeatures(features, filter, sortExpr, z, eo) {
	const ctx = { zoom: z, props: null, geom: null, vars: {}, origin: eo, state: undefined };   // ctx は 1 個を使い回す（compile 済み evalExpr は ctx を保持しない）
	const pass = f => { ctx.props = f.props; ctx.geom = f.type; return truthy(evalExpr(filter, ctx)); };
	if (!sortExpr) return filter ? features.filter(pass) : features;
	const src = filter ? features.filter(pass) : features;
	// {f,i,k} を feature 毎に作らず、キー配列＋インデックス配列で安定ソート（GC削減）
	const sorted = list => {
		const n = list.length, keys = new Array(n), idx = new Array(n);
		let nan = false;
		for (let i = 0; i < n; i++) { const f = list[i]; ctx.props = f.props; ctx.geom = f.type; const k = evalExpr(sortExpr, ctx); keys[i] = k; idx[i] = i; if (Number.isNaN(k - 0)) nan = true; }
		if (nan) return null;
		idx.sort((a, b) => (keys[a] - keys[b]) || (a - b));
		const out = new Array(n);
		for (let i = 0; i < n; i++) out[i] = list[idx[i]];
		return out;
	};
	const out = sorted(src);
	if (out || !filter) return out ?? legacySort(features, sortExpr, ctx);
	return legacySort(features, sortExpr, ctx).filter(pass);
}
// 旧来の並べ替え（全順序でない鍵＝NaN を含む時の順をそのまま保つ）
function legacySort(features, sortExpr, ctx) {
	const n = features.length, keys = new Array(n), idx = new Array(n);
	for (let i = 0; i < n; i++) { const f = features[i]; ctx.props = f.props; ctx.geom = f.type; keys[i] = evalExpr(sortExpr, ctx); idx[i] = i; }
	idx.sort((a, b) => (keys[a] - keys[b]) || (a - b));
	const out = new Array(n);
	for (let i = 0; i < n; i++) out[i] = features[idx[i]];
	return out;
}

