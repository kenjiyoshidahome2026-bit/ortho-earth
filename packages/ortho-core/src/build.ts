// デコード済みMVT + style.json → 描画op列（style層の順＝厳密な painter順）。
// 各 style層が1つの op（fill or line）になり、renderer はこの順にそのまま描く。
// 投影非依存の部分だけ担当：幾何を経緯度に戻し、シーン原点からの delta(float32) と地物ごとの色/線幅を確定。
// 線幅はスクリーン空間の定px（fat-line/capsule 展開は頂点シェーダ側）。
import earcut from "earcut";
import type { DrawOp, LineOp } from "./scene.ts";
import type { DecodedFeature, DecodedGeom, DecodedTile, EmptyTile, TileData } from "./tileformat.ts";
import type { ExprContext } from "./expr.ts";
import type { GeoCtxTile } from "./expr-geo.ts";
import type { TileXYZ } from "./tile.ts";
import type { BuildingsSchema } from "./buildings.ts";

/** 基図の style の層（MapLibre の部分集合＝fill / line / symbol / background・式は評価器 expr.ts が読む） */
export interface StyleLayer { id: string; type: string; "source-layer"?: string; filter?: unknown; layout?: Record<string, unknown> | null; paint?: Record<string, unknown> | null; minzoom?: number | null; maxzoom?: number | null; metadata?: Record<string, unknown> | null; dashInLineWidths?: boolean; [k: string]: unknown }
/** style の申告（どの層のどの属性が建物・海・注記の分類か） */
export interface StyleSchema { buildings?: BuildingsSchema | null; seaProps?: Record<string, unknown> | null; labelCode?: string | null; [k: string]: unknown }
/** 基図の style（build / labels / tilepayload が食べる形） */
export interface Style { layers: StyleLayer[]; emptySea?: string | null; schema?: StyleSchema | null; [k: string]: unknown }
/** 地物 → その feature-state（#109） */
export type StateOf = (f: DecodedFeature) => Record<string, unknown> | null | undefined;
/** buildTileDrawList の入力＝解読済みの層と タイル座標 */
export interface BuildTile extends TileXYZ { layers: TileData; subLenM?: number; stateOf?: StateOf | null }
export interface DrawList { ops: DrawOp[] }

// 一番上（pole=1）／下（pole=-1）の行のタイル：上端（py≤0）／下端（py≥extent）に沿う「境界の辺」（1 つの三角形にしか属さない辺）から、極の 1 頂点へ扇を張る。
// 極の頂点はタイル座標では表せない＝末尾に置き、呼び手が経緯度（緯度 ±90）を直に書く。境界の辺が無ければ何もしない（配列はそのまま返す）
function extendToPole(flat: ArrayLike<number>, tris: ArrayLike<number>, extent: number, pole: number): [ArrayLike<number>, ArrayLike<number>] {
	// 端の頂点の印を先に 1 回だけ（旧＝三角形ごと・辺ごとに座標を見直し＝全球のタイルで細分の後の数万三角形×6 回）。辺の鍵は端の頂点どうしの辺だけ
	const nv = flat.length >> 1, on = new Uint8Array(nv);
	let any = 0;
	for (let i = 0; i < nv; i++) { const y = flat[i * 2 + 1]; if (pole > 0 ? y <= 0 : y >= extent) { on[i] = 1; any++; } }
	if (any < 2) return [flat, tris];
	const cnt = new Map<number, number>(), key = (i: number, j: number): number => (i < j ? i * 4294967296 + j : j * 4294967296 + i);
	for (let t = 0; t < tris.length; t += 3) { const a = tris[t], b = tris[t + 1], c = tris[t + 2]; if (on[a] + on[b] + on[c] < 2) continue; for (let k = 0; k < 3; k++) { const i = tris[t + k], j = tris[t + (k + 1) % 3]; if (on[i] && on[j]) { const kk = key(i, j); cnt.set(kk, (cnt.get(kk) || 0) + 1); } } }
	const edges: number[] = [];
	for (let t = 0; t < tris.length; t += 3) { const a = tris[t], b = tris[t + 1], c = tris[t + 2]; if (on[a] + on[b] + on[c] < 2) continue; for (let k = 0; k < 3; k++) { const i = tris[t + k], j = tris[t + (k + 1) % 3]; if (on[i] && on[j] && cnt.get(key(i, j)) === 1) edges.push(i, j); } }
	if (!edges.length) return [flat, tris];
	const p = nv, pts = new Float64Array(flat.length + 2); pts.set(flat);
	pts[flat.length] = 0; pts[flat.length + 1] = pole > 0 ? -extent : 2 * extent;   // 仮の座標（呼び手が経緯度を上書きする）
	const out = new Uint32Array(tris.length + edges.length / 2 * 3); out.set(tris);
	for (let e = 0, o = tris.length; e < edges.length; e += 2) { out[o++] = edges[e]; out[o++] = edges[e + 1]; out[o++] = p; }   // 向きは境界の辺の向きに従う（塗りは両面）
	return [pts, out];
}
// 三角形の集合を「辺の長さ ≤ maxLen（タイル単位）」まで最長辺の二等分で細分（共有辺の中点は 1 回だけ作る＝隙間なし）。戻り＝[flat（x,y,…）, tris（index）]
// 多角形（外周＋穴・タイル単位）を四角 [0,extent]² で切り抜く（Sutherland–Hodgman・凸の窓なので環ごとに独立に切ってよい）。
// 全部が窓の中なら元の配列をそのまま返す（コピー無し）。外周が消えたら null。空になった穴は捨てる
export function clipToExtent<F extends ArrayLike<number>>(flat: F, holes: number[], extent: number): [F | Float64Array, number[]] | null {
	let inside = true;
	for (let i = 0; i < flat.length && inside; i += 2) if (flat[i] < 0 || flat[i] > extent || flat[i + 1] < 0 || flat[i + 1] > extent) inside = false;
	if (inside) return [flat, holes];
	// 環を窓の 4 辺で順に切る（ping-pong の 2 本の作業配列・旧＝辺ごとに JS 配列を作っていた＝式と順はそのまま＝ビット同値）
	const ring = (s: number, e: number): Float64Array | null => {
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
	const parts = [outer], hs: number[] = [];
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
const outsideSameSide = (ax: number, ay: number, bx: number, by: number, extent: number): boolean => (ax < 0 && bx < 0) || (ax > extent && bx > extent) || (ay < 0 && by < 0) || (ay > extent && by > extent);
// 三角形を格子（マス幅 cell・タイル単位）で切り分ける＝MapLibre の subdivideFill と同じ「格子で切る」細分。
// 旧＝最長辺の二等分：隣の三角形が同じ辺を割らないと T 字の接点ができ、球の上では割った側の中点は球面に乗り・割らない側の辺は弦のまま沈む
// ＝その差が 45° の白い筋（低ズームの demotiles・2026-09-30 本人の写し）。格子線との交点は辺の向きに依らず同じ式で出す＝隣同士が必ず同じ頂点を共有＝継ぎ目なし
export function subdivideTris(flat: ArrayLike<number>, tris: ArrayLike<number>, cell: number): [Float64Array, Uint32Array] {
	// 作業域（worker ごと・伸びるだけ）：頂点＝Float64・三角形＝Uint32・再帰の多角形＝Uint32 の 1 本の棚（lo/hi を棚の上に積む＝多角形ごとの配列を作らない）。
	// 旧＝JS の配列へ push・交点の覚えは "x,y" の文字列の鍵＝全球（z0〜6）のタイルは 1 枚 100ms 超の 7 割がこの文字列化と GC だった。
	// 鍵＝x → y の二段の Map（数が鍵）＝文字列の鍵と同じ同一性（String(-0)==="0"＝SameValueZero と同じ）。頂点の採番と三角形の順は旧と同じ＝出力はビット同値
	let np = flat.length; if (SD.pts.length < np) SD.pts = new Float64Array(np * 2); const pts0 = SD.pts; pts0.set(flat);
	let pts = pts0, pn = np;
	SD.out.n = 0;
	// 交点の覚え＝(x, y) → 頂点の添字の開番地ハッシュ（表＝頂点の添字・座標は pts を見る）。旧＝x → (y → 添字) の二段の Map＝同じ同一性
	// （SameValueZero：0 と −0 は同じ・NaN は NaN と同じ）。鍵の比較は same()・ハッシュは −0 を 0 に・NaN を 1 つの値に寄せてから＝同じ点は同じ桶
	let cap = 256; while (cap < tris.length) cap <<= 1;
	let tab = new Int32Array(cap).fill(-1), used = 0;
	const same = (a: number, b: number): boolean => a === b || (a !== a && b !== b);
	const hashXY = (x: number, y: number): number => {
		HB[0] = x === 0 ? 0 : x; HB[1] = y === 0 ? 0 : y;   // −0 → 0（NaN は Float64Array に書くと既定の NaN の bit 列になる）
		if (x !== x) HB[0] = NaN; if (y !== y) HB[1] = NaN;
		let h = Math.imul(HU[0] ^ Math.imul(HU[1], 0x85EBCA77), 0x9E3779B1) ^ Math.imul(HU[2] ^ Math.imul(HU[3], 0xC2B2AE3D), 0x27D4EB2F);
		h ^= h >>> 15; return h >>> 0;
	};
	const addPt = (x: number, y: number): number => {
		let mask = cap - 1, h = hashXY(x, y) & mask;
		for (;;) { const r = tab[h]; if (r < 0) break; if (same(pts[r * 2], x) && same(pts[r * 2 + 1], y)) return r; h = (h + 1) & mask; }
		const r = pn >> 1;
		if (pn + 2 > pts.length) { const b = new Float64Array(pts.length * 2); b.set(pts.subarray(0, pn)); pts = SD.pts = b; }
		pts[pn++] = x; pts[pn++] = y;
		tab[h] = r;
		if (++used * 2 > cap) {   // 半分を超えたら倍に（入れ直し）
			const old = tab; cap <<= 1; mask = cap - 1; tab = new Int32Array(cap).fill(-1);
			for (let i = 0; i < old.length; i++) { const v = old[i]; if (v < 0) continue; let k = hashXY(pts[v * 2], pts[v * 2 + 1]) & mask; while (tab[k] >= 0) k = (k + 1) & mask; tab[k] = v; }
		}
		return r;
	};
	// 辺 (p,q) と格子線 axis=v の交点＝頂点添字の小さい方を始点に計算（向きに依らずビット同値）
	const cut = (p: number, q: number, ax: number, v: number): number => {
		if (p > q) { const t = p; p = q; q = t; }
		const pc = pts[p * 2 + ax], qc = pts[q * 2 + ax], po = pts[p * 2 + 1 - ax], qo = pts[q * 2 + 1 - ax], o = po + (qo - po) * ((v - pc) / (qc - pc));
		return ax ? addPt(o, v) : addPt(v, o);
	};
	let guard = 0, stk = SD.stk;
	// 多角形＝棚の [s, s+n)・top＝棚の空きの先頭。lo・hi を top から順に積み、lo を先に（旧と同じ順）・次に hi を割る（子の作業域は両方の後ろ＝重ならない）
	const split = (s: number, n: number, top: number): void => {
		if (guard++ > 4e6) return;
		let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
		for (let i = 0; i < n; i++) { const k = stk[s + i], x = pts[k * 2], y = pts[k * 2 + 1]; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
		// 箱の中を通る格子線（端を含まない）：多い方の軸の真ん中の 1 本で二分＝再帰の深さ log
		const kx0 = Math.floor(minx / cell) + 1, kx1 = Math.ceil(maxx / cell) - 1, ky0 = Math.floor(miny / cell) + 1, ky1 = Math.ceil(maxy / cell) - 1;
		const nx = Math.max(0, kx1 - kx0 + 1), ny = Math.max(0, ky1 - ky0 + 1);
		if (!nx && !ny) { const ia = SD.out.reserve(3 * (n - 2)); let io = SD.out.n; const a0 = stk[s]; for (let i = 1; i + 1 < n; i++) { ia[io++] = a0; ia[io++] = stk[s + i]; ia[io++] = stk[s + i + 1]; } SD.out.n = io; return; }   // 凸多角形＝扇
		const ax = nx >= ny ? 0 : 1, v = (ax ? ky0 + (ny >> 1) : kx0 + (nx >> 1)) * cell;
		if (stk.length < top + 4 * n + 4) { const b = new Uint32Array(Math.max(stk.length * 2, top + 4 * n + 4)); b.set(stk.subarray(0, top)); stk = SD.stk = b; }
		// lo を [top, …)・hi を一時に [top+2n, …) へ積み、hi を lo の直後へ詰める（1 辺で切ると各側は高々 2n 点）
		let nl = 0, nh = 0; const hb = top + 2 * n;
		for (let i = 0; i < n; i++) {
			const p = stk[s + i], q = stk[s + (i + 1) % n], pc = pts[p * 2 + ax], qc = pts[q * 2 + ax];
			if (pc <= v) stk[top + nl++] = p; if (pc >= v) stk[hb + nh++] = p;
			if ((pc < v && qc > v) || (pc > v && qc < v)) { const m = cut(p, q, ax, v); stk[top + nl++] = m; stk[hb + nh++] = m; }
		}
		stk.copyWithin(top + nl, hb, hb + nh);
		if (nl >= 3) split(top, nl, top + nl + nh);
		if (nh >= 3) split(top + nl, nh, top + nl + nh);
	};
	for (let t = 0; t < tris.length; t += 3) { if (stk.length < 3) stk = SD.stk = new Uint32Array(64); stk[0] = tris[t]; stk[1] = tris[t + 1]; stk[2] = tris[t + 2]; split(0, 3, 3); }
	return [pts.slice(0, pn), SD.out.out()];
}
import { evalExpr, truthy, originOfLayer } from "./expr.ts";   // originOfLayer＝MapLibre の文書から来た層は MapLibre の意味で評価（ctx.origin・2026-09-26）
import { parseRGBA } from "./color.ts";
import { tileLocalToLonLat } from "./tile.ts";
import { polygons, signedArea } from "./decode.ts";   // フラットgeom({coords,ends})→[flat, holes]（buildings と共用）
import { SEA_FB_BASE } from "./scene.ts";

// 組み立ての出力の伸びる型付き配列（層ごとに reset・最後に out() で必要な長さだけ写す）。旧＝JS の数の配列へ push して最後に Float32Array(配列)＝
// 伸びるたびの付け替え・倍精度の箱・2 度目の写しが組み立ての GC の大半だった。Float32Array へ直に書く丸めは Float32Array(配列) と同じ（ビット同値）。
// 組み立ては同期＝worker の中で入れ子にならない限り使い回してよい（入れ子＝buildEmptySeaOps から呼ぶ時は depth で新しい物を作る）
type TypedArray = Float32Array | Float64Array | Uint8Array | Uint16Array | Uint32Array;
interface TypedArrayCtor<T extends TypedArray> { new (n: number): T; from(a: ArrayLike<number>): T }
class Grow<T extends TypedArray> {
	T: TypedArrayCtor<T>;
	a: T;
	n: number;
	constructor(T: TypedArrayCtor<T>, n = 4096) { this.T = T; this.a = new T(n); this.n = 0; }
	reserve(k: number): T { if (this.n + k > this.a.length) { let m = this.a.length * 2; while (m < this.n + k) m *= 2; const b = new this.T(m); b.set(this.a.subarray(0, this.n)); this.a = b; } return this.a; }
	out(): T;
	out<U extends TypedArray>(T: TypedArrayCtor<U>): U;
	out(T: TypedArrayCtor<TypedArray> = this.T): TypedArray { return T === this.T ? this.a.slice(0, this.n) : T.from(this.a.subarray(0, this.n)); }
}
interface Bufs { pos: Grow<Float32Array>; col: Grow<Uint8Array>; idx: Grow<Uint32Array>; P1: Grow<Float32Array>; P2: Grow<Float32Array>; half: Grow<Float32Array>; off: Grow<Float32Array>; jf: Grow<Uint8Array>; dist: Grow<Float32Array> }
const newBufs = (): Bufs => ({ pos: new Grow(Float32Array), col: new Grow(Uint8Array), idx: new Grow(Uint32Array), P1: new Grow(Float32Array), P2: new Grow(Float32Array), half: new Grow(Float32Array), off: new Grow(Float32Array), jf: new Grow(Uint8Array), dist: new Grow(Float32Array) });
let sharedBufs: Bufs | null = null, bufDepth = 0;
const LS = { p1: new Grow(Float32Array), p2: new Grow(Float32Array), r: new Grow(Uint32Array), k: new Grow(Uint32Array), fl: new Grow(Uint8Array), d: new Grow(Float32Array) };   // lineSegs の作業（同期・入れ子にならない＝使い回す）
const SD = { pts: new Float64Array(1 << 12), stk: new Uint32Array(1 << 12), out: new Grow(Uint32Array, 1 << 14) };   // subdivideTris の作業（同期・使い回す）
const HB = new Float64Array(2), HU = new Uint32Array(HB.buffer);   // subdivideTris の交点の覚えのハッシュ（座標の bit 列）

// line-dasharray の評価結果 → 模様（線,間,線,間…）。数でない・負・合計 0 は null（破線なし）。奇数個は MapLibre/SVG と同じく 2 回繰り返す
const NO_SLIDES: [ArrayLike<number>, ArrayLike<number>] = [[], []];

// line-cap／line-join（MapLibre 互換・S-P1-1・2026-10-22）の種類の番号＝LineOp.cj＝cap | join<<2 | round(miter-limit×8)<<4（シェーダの u_cj と同じ並び）。
// 丸い端・丸い継ぎ（0）の層は今までどおり capsule（線分ごとの丸い棒の重ね）＝jf を持たない。それ以外は線分ごとに隣と継ぐかの旗（JF_*）を添え、
// シェーダが隣の線分（並びの前後＝線分レコードは増やさない）の点から継ぎを画面空間の二等分線で切る（両隣が同じ線で切る＝隙も重なりも無い）。
// 既定は MapLibre と同じ butt／miter／2。ただし内蔵の style（出自が ml でない層）は既定を丸のまま＝今の絵
// 旗＝1：始点を前の線分（すぐ前）と継ぐ・2：終点を次の線分（すぐ後）と継ぐ・4／8：始点／終点は閉じた環の継ぎ目（前後が並びで隣でない＝丸い継ぎに倒す）。どれも無い端＝line-cap
export const JF_PREV = 1;
export const JF_NEXT = 2;
export const JF_RING_START = 4;
export const JF_RING_END = 8;
const CAP_ROUND = 0, CAP_BUTT = 1, CAP_SQUARE = 2, JOIN_ROUND = 0, JOIN_MITER = 1, JOIN_BEVEL = 2;
const CAP_OF: Record<string, number> = { round: CAP_ROUND, butt: CAP_BUTT, square: CAP_SQUARE }, JOIN_OF: Record<string, number> = { round: JOIN_ROUND, miter: JOIN_MITER, bevel: JOIN_BEVEL };
export function lineCapJoin(layout: Record<string, unknown> | null | undefined, z: number, eo: "ml" | undefined): number {
	const ctx: ExprContext = { zoom: z, props: {}, geom: null, vars: {}, origin: eo };   // 層で一度（line-cap は zoom だけ・line-join は属性も読めるが層で一度＝近似）
	const v = (k: string, d: unknown): unknown => { const e = layout?.[k]; if (e == null) return d; const r = evalExpr(e, ctx); return r === undefined ? d : r; };
	const cap = CAP_OF[String(v("line-cap", eo ? "butt" : "round"))] ?? (eo ? CAP_BUTT : CAP_ROUND);
	const join = JOIN_OF[String(v("line-join", eo ? "miter" : "round"))] ?? (eo ? JOIN_MITER : JOIN_ROUND);
	const ml = +(v("line-miter-limit", 2) as number);
	return cap | join << 2 | Math.max(0, Math.min(255, Math.round((isFinite(ml) ? ml : 2) * 8))) << 4;
}
// 層の画面効果（S-P1-4/5・2026-10-22）＝[tx, ty, anchor（1＝viewport）, blur, rel（1＝blur は半幅の割合）]。何も無い層は null。
// *-translate（MapLibre では zoom だけに依る）と line-blur（属性も読めるが層で一度＝近似）は作ったタイルの z で評価する（cj と同じ）。
// circle-blur＝vtdraw の円（長さ 0 の線）が持ち込む「半径の割合」（MapLibre の circle の antialiasblur）
export function layerFx(L: { type: string; paint?: Record<string, unknown> | null }, z: number, eo: "ml" | undefined): number[] | null {
	const p = L.paint, pre = L.type === "fill" ? "fill" : "line";
	if (!p) return null;
	const ctx: ExprContext = { zoom: z, props: {}, geom: null, vars: {}, origin: eo };
	const v = (k: string): unknown => { const e = p[k]; return e == null ? undefined : evalExpr(e, ctx); };
	const t = v(pre + "-translate"), tr = Array.isArray(t) && t.length >= 2 ? [+t[0] || 0, +t[1] || 0] : [0, 0];
	const anc = v(pre + "-translate-anchor") === "viewport" ? 1 : 0;
	const cb = pre === "line" ? +(v("circle-blur") as number) : NaN, lb = pre === "line" ? +(v("line-blur") as number) : NaN;
	const rel = cb > 0 ? 1 : 0, blur = rel ? Math.min(cb, 1) : lb > 0 ? lb : 0;
	return tr[0] || tr[1] || blur ? [tr[0], tr[1], anc, blur, rel] : null;
}
export function dashPattern(v: unknown, ml = false): number[] | null {
	if (!Array.isArray(v) || !v.length || v.some(x => typeof x !== "number" || !(x >= 0) || !isFinite(x))) return null;
	if (ml) return v.length > 1 && v.reduce((a, b) => a + b, 0) > 0 ? v : null;   // MapLibre＝奇数個は 2 回でなく「最後と最初の線がつながる」（LineAtlas.getDashRanges）・1 個は実線
	const p: number[] = v.length & 1 ? v.concat(v) : v;
	return p.reduce((a, b) => a + b, 0) > 0 ? p : null;
}
// 破線をシェーダで描く（S-P1-3・2026-10-22）：外来 MapLibre の層で、ずらさず、模様が 8 個まで＝線分は刻まず、始点までの線に沿う距離（LineOp.dist）を添える。
// 距離の単位＝z24 の px（256 px 世界＝このエンジンの z）＝世界の幅の 2^32 分の 1。タイルの中で環（線）の始点から数える（MVT はタイルで切られて来る＝MapLibre と同じ）。
// シェーダは floor(zoom) の px に直して模様（線幅の倍数）を当てる＝MapLibre の tileZoom と同じ（このエンジンの z は MapLibre の z＋1）
export const DASH_GPU_MAX = 8;
// 外来の奇数個の模様を CPU で刻む形へ：[a, b, c]＝c と a がつながる＝[c+a, b]・刻み始めは最初の線の残り a
function dashCpuML(p: number[]): [number[], number] | null {
	if (!(p.length & 1)) return [p, p[0]];
	return p.length > 1 ? [[p[p.length - 1] + p[0], ...p.slice(1, -1)], p[0]] : null;
}

// line-offset の角の継ぎ（#49）：線分ごとに「始点・終点を線分の向きへ何倍ずらすか」（t）を頂点のマイターから求める。
// 頂点のマイター m＝(n0+n1)/(1+n0·n1)（n＝右の単位法線・|m|＝1/cos(θ/2)）。線分の座標系で m＝n＋d·t（m·n＝1）＝t＝m·d。
// シェーダは端点を off×(perp＋dir×t) だけ動かす＝隣の線分の端点と同じ所に着く（線分ごとの法線だけでずらすと、細かく折れる
// 海岸線・川が点々に散る＝2026-09-25 実描画で確認）。タイル座標（メルカトル＝等角・y 下向き＝画面と同じ向き）で測る。
// 端（閉じていない線の頭と尻）は 0・閉じた環は一周つなぐ・折り返し（180°）は 0・マイターの限界＝|t|≤1（それを超える鋭角は隙間/重なり）。
// 戻り＝[tS, tE]（線分 k＝点 k→k+1 の始点と終点の t）。長さ 0 の線分は隣の向きを借りる
export function miterSlides(coords: ArrayLike<number>, ls: number, le: number): [Float32Array, Float32Array] {
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
	const lim = (v: number): number => v > 1 ? 1 : v < -1 ? -1 : v;   // 限界＝|t|≤1（90° まで継ぐ）。それより鋭い角は継ぎを諦める（2 まで許すと画素級のぎざぎざで棘が出た）
	// 頂点 v（0..n-1）で入る線分 a・出る線分 b のマイターを線分 k の向きで測る
	const tAt = (a: number, b: number, k: number): number => {
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
// subLenM＝線の細分の長さ（m・既定 700＝基図）。利用者の vector の層（段 8⑤）は低ズームのタイルで細分が膨れないよう長くして渡す。
// Infinity＝地形にドレープしない地図（terrain 無し・vt perf plan §3.2）＝細分しない。ただし z≤6 は fill と同じ格子（128>>z）で粗く刻む＝球の弦の沈み（長い線が球に潜る）を防ぐ
// stateOf＝地物 → その feature-state（#109・省略可）。paint の ["feature-state", k] だけが読む（filter と sort-key は読まない＝MapLibre と同じ）。
//   渡すのは利用者の vector の描く層（globe の vtdraw）だけ＝基図は渡さない＝今と同じ絵（黄金の写しは不変）・層の中の sort-key の順も崩れない
export function buildTileDrawList(tile: BuildTile, style: Style, origin: readonly number[], pale: (c: unknown) => unknown = c => c): DrawList {
	const B = bufDepth++ === 0 ? (sharedBufs ??= newBufs()) : newBufs();
	try { return buildTileDrawList1(tile, style, origin, pale, B); } finally { bufDepth--; }
}
interface FillPart { ll: Float32Array; tris: ArrayLike<number> }
interface LineSegs { n: number; p1: Float32Array; p2: Float32Array; r: Uint32Array; k: Uint32Array; fl: Uint8Array; d: Float32Array; rs: number[]; re: number[]; pv?: Int32Array; nx?: Int32Array }
// 線分の隣（S-P1-1）：同じ環で端点を共有する前・次の線分の添字（無ければ −1＝端）。閉じた環は一周つなぐ。
// 長さ 0 の線分は飛ばしてつなぐ（自分は −1＝丸でない端なら描かれない）。余白で落とした線分の所は切れる＝端
function linkSegs(g: LineSegs): void {
	if (g.pv) return;
	const { n, p1, p2, r } = g, pv = new Int32Array(n).fill(-1), nx = new Int32Array(n).fill(-1);
	const meets = (a: number, b: number): boolean => p2[a * 2] === p1[b * 2] && p2[a * 2 + 1] === p1[b * 2 + 1];   // a の終点＝b の始点（同じ値の Float32＝ビット同値）
	const close = (f: number, l: number): void => { if (f >= 0 && l > f && pv[f] < 0 && nx[l] < 0 && meets(l, f)) { pv[f] = l; nx[l] = f; } };
	let first = -1, last = -1;
	for (let j = 0; j < n; j++) {
		if (j && r[j] !== r[j - 1]) { close(first, last); first = last = -1; }
		if (p1[j * 2] === p2[j * 2] && p1[j * 2 + 1] === p2[j * 2 + 1]) continue;
		if (last >= 0 && meets(last, j)) { pv[j] = last; nx[last] = j; }
		if (first < 0) first = j;
		last = j;
	}
	close(first, last);
	g.pv = pv; g.nx = nx;
}
function buildTileDrawList1({ layers, z, x, y, subLenM = 700, stateOf = null }: BuildTile, style: Style, origin: readonly number[], pale: (c: unknown) => unknown, B: Bufs): DrawList {
	const [ox, oy] = origin;
	const ops: DrawOp[] = [];   // { kind:'fill'|'line', li, ... } を style層順に（li=style層index、跨ぎバッチ結合用）
	// タイルローカル(0..extent) → 経緯度(原点相対) を out[oi],out[oi+1] へ直書き。x,y,n はタイル内で不変なので
	// ここで一度だけ捕獲し、毎頂点の一時配列 [lon,lat] 生成を廃す（＝GC削減）。extent は層毎に渡す。
	const nTiles = 1 << z, R2D = 180 / Math.PI, HALF_PI = Math.PI / 2;
	// 緯度（メルカトルの逆・atan＋exp）は整数の py（MVT の頂点はほぼ全部）ごとに一度だけ計算して覚える＝同じ式・同じ値（ビット同値）。
	// 覚えは層の extent ごと（通常は全層 4096）・範囲は余白込みの [−extent, 2·extent)。切り口の交点・線の細分の点（小数）は毎回計算
	let latE = 0, latC: Float64Array | null = null;
	const latOf = (py: number, extent: number): number => {
		if (Number.isInteger(py) && py >= -extent && py < 2 * extent) {
			if (latE !== extent) { latE = extent; latC = new Float64Array(3 * extent).fill(NaN); }
			const i = py + extent, v = latC![i];
			if (v === v) return v;
			return (latC![i] = R2D * (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * ((y + py / extent) / nTiles)))) - HALF_PI) - oy);
		}
		return R2D * (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * ((y + py / extent) / nTiles)))) - HALF_PI) - oy;
	};
	const llInto = (px: number, py: number, extent: number, out: Float64Array, oi: number): void => {
		const wx = (x + px / extent) / nTiles;
		out[oi] = (wx * 360 - 180) - ox;
		out[oi + 1] = latOf(py, extent);
	};
	const sc = new Float64Array(2);    // line 用スクラッチ（1頂点）＝毎回の一時配列を作らない
	let llBuf = new Float64Array(0);   // fill 用：ポリゴン頂点の経緯度を貯める再利用バッファ（最大サイズまで成長）
	// 頂点色は Uint8×4（正規化attribでGLへ）：float32×4 だと fill 頂点24Bの2/3が色＝実質8bit精度のデータに
	// バス幅の2/3を割いていた。バイト化で tess出力→transfer→常駐→merge→upload の全段が縮む。
	const b255 = (v: number): number => v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
	// 線分細分の閾値（タイル単位）：地形にドレープする際、長い直線が尾根で折れないよう ~700m 毎に分割。
	const [, cLat] = tileLocalToLonLat(x, y, z, 2048, 2048, 4096);
	const mPerUnit = 40075016.686 * Math.cos(cLat * Math.PI / 180) / (Math.pow(2, z) * 4096);
	const subLen = Math.max(1, subLenM / mPerUnit);   // 700m（既定）相当のタイル単位（Infinity＝細分なし・下の lineSegs で低 z だけ fill の格子に倒す）

	// 塗りの地物の幾何（切り抜き→三角形分割→細分→極の扇→経緯度）は色に依らない＝地物ごとに一度だけ作って層を跨いで使い回す。
	// 基図は同じ source-layer の地物を複数の fill 層（water／water-hi 等）が塗る＝旧は同じ地物を層の数だけ earcut していた（optbv の見本で全て 2 回）。
	// 戻り＝[{ ll: Float32Array（経緯度・原点相対）, tris }]（塗りの頂点は Float32 で運ぶ＝旧と同じ丸め）
	const fillCache = new Map<DecodedGeom, FillPart[]>();
	const fillSub0 = z <= 6;
	const fillParts = (geom: DecodedGeom, extent: number): FillPart[] => {
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
			const [flat1, tris1]: [ArrayLike<number>, ArrayLike<number>] = fillSub > 0 ? subdivideTris(flat0, tris0, fillSub) : [flat0, tris0];
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
	const lineCache = new Map<DecodedGeom, LineSegs>();
	const lineSegs = (geom: DecodedGeom, extent: number): LineSegs => {
		let g = lineCache.get(geom);
		if (g) return g;
		const { coords, ends } = geom, p1 = LS.p1, p2 = LS.p2, rr = LS.r, kk = LS.k, fl = LS.fl, dd = LS.d, rs: number[] = [], re: number[] = [];
		const sl = isFinite(subLen) ? subLen : fillSub0 ? extent / Math.max(1, 128 >> z) : Infinity;   // ドレープ無し＝z≤6 だけ fill の格子で粗く（弦の沈み）・z≥7 は細分なし
		p1.n = p2.n = rr.n = kk.n = fl.n = dd.n = 0;
		let ls = 0;
		for (let r = 0; r < ends.length; r++) {
			const le = ends[r];
			rs.push(ls); re.push(le);
			if (le - ls < 4) { ls = le; continue; }   // 2点未満
			llInto(coords[ls], coords[ls + 1], extent, sc, 0);
			let pLon = sc[0], pLat = sc[1], acc = 0;   // acc＝環の始点からの線に沿う距離（タイル単位・破線の位相＝S-P1-3）
			for (let i = ls + 2; i < le; i += 2) {
				const Ax = coords[i - 2], Ay = coords[i - 1];
				const dx = coords[i] - Ax, dy = coords[i + 1] - Ay, len = Math.hypot(dx, dy);
				if (outsideSameSide(Ax, Ay, coords[i], coords[i + 1], extent)) { llInto(coords[i], coords[i + 1], extent, sc, 0); pLon = sc[0]; pLat = sc[1]; acc += len; continue; }   // 余白だけを走る線分＝描かない（下の outsideSameSide）・位相は進める
				const steps = Math.min(24, Math.max(1, Math.ceil(len / sl)));  // 地形ドレープ用に細分（sl＝Infinity なら 1）
				const k = (i - ls - 2) >> 1;
				for (let s = 1; s <= steps; s++) {
					const t = s / steps;
					llInto(Ax + dx * t, Ay + dy * t, extent, sc, 0);
					const a1 = p1.reserve(2), a2 = p2.reserve(2);
					a1[p1.n++] = pLon; a1[p1.n++] = pLat; a2[p2.n++] = sc[0]; a2[p2.n++] = sc[1];
					rr.reserve(1)[rr.n++] = r; kk.reserve(1)[kk.n++] = k; fl.reserve(1)[fl.n++] = (s === 1 ? 1 : 0) | (s === steps ? 2 : 0);
					dd.reserve(1)[dd.n++] = acc + len * (s - 1) / steps;
					pLon = sc[0]; pLat = sc[1];
				}
				acc += len;
			}
			ls = le;
		}
		g = { n: rr.n, p1: p1.out(), p2: p2.out(), r: rr.out(), k: kk.out(), fl: fl.out(), d: dd.out(), rs, re };
		lineCache.set(geom, g);
		return g;
	};

	for (let li = 0; li < style.layers.length; li++) {
		const L = style.layers[li], eo = originOfLayer(L);   // eo＝式の出自（引数 origin はシーンの原点＝別物）
		if (L.type !== "fill" && L.type !== "line") continue;
		if (L.layout && L.layout.visibility === "none") continue;
		if (L.minzoom != null && z < L.minzoom) continue;
		if (L.maxzoom != null && z >= L.maxzoom) continue;
		const src = (layers as DecodedTile)[L["source-layer"] as string]; if (!src) continue;
		const extent = src.extent;
		// filter で残る地物だけを line-sort-key/fill-sort-key の昇順に（高い値ほど後＝上に描く）。std は道路を vt_drworder で並べる。
		// 旧＝層の全地物を並べてから filter＝同じ source-layer（road）を読む層の数だけ全地物の sort-key を評価して並べていた
		const feats = filterSortFeatures(src.features, L.filter, L.layout?.["line-sort-key"] ?? L.layout?.["fill-sort-key"], z, eo, { z, x, y, E: extent });   // tile＝within/distance（C2）が地物の形を経緯度へ

		if (L.type === "fill") {
			// インデックス描画：ユニーク頂点(pos/col)＋三角形index。スープ展開（3頂点/三角形）をやめ、
			// 頂点は一度だけ持つ＝典型ポリゴン(tris≈verts)でバイト2/3・GPUのpost-transform cacheも効く。
			const pos = B.pos, col = B.col, idx = B.idx; pos.n = col.n = idx.n = 0;
			const ctx: ExprContext = { zoom: z, props: null, geom: null, vars: {}, origin: eo, state: undefined, feat: null, tile: { z, x, y, E: extent } };   // feature 間で使い回す（compile 済み evalExpr は ctx を保持しない＝安全）
			for (const f of feats) {
				ctx.props = f.props; ctx.geom = f.type; ctx.state = undefined; ctx.feat = f;   // filter は filterSortFeatures で済んでいる。feat＝distance（C2）
				if (stateOf) ctx.state = stateOf(f);   // filter の後＝paint だけが読む
				const c = parseRGBA(pale(evalExpr(L.paint?.["fill-color"] ?? "#000", ctx)));
				const op = L.paint?.["fill-opacity"], ov = op != null ? evalExpr(op, ctx) : 1; const a = c[3] * ((ov === undefined && eo ? 1 : ov) as number);   // ML の評価エラー＝既定 1
				const cr = b255(c[0]), cg = b255(c[1]), cb = b255(c[2]), ca = b255(a);
				for (const part of fillParts(f.geom!, extent)) {
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
			const fx = eo ? layerFx(L, z, eo) : null;   // fill-translate（S-P1-4/5）＝外来の層だけ
			if (pos.n) ops.push({ kind: "fill", li, id: L.id, pos: pos.out(), col: col.out(), idx: pos.n >> 1 <= 65535 ? idx.out(Uint16Array) : idx.out(Uint32Array), ...(fx ? { fx } : {}) });
		} else { // line
			const P1 = B.P1, P2 = B.P2, col = B.col, half = B.half; P1.n = P2.n = col.n = half.n = 0;
			// line-offset（MapLibre 互換の口・#49）：線を進行方向の右（正）／左（負）へ平行にずらす＝画面 px（線幅と同じ単位）。
			// ずらしは頂点シェーダが画面空間で掛ける＝ここは線分ごとに [off, tS, tE]（角の継ぎ＝miterSlides）を添えるだけ。
			// 層が持つ時だけ配列を作る（無い層は 0 バイト）
			// line-gap-width（MapLibre 互換・2026-10-03）：線の芯の両脇に幅 line-width の線を 2 本（芯から gap/2＋width/2 ずらす＝ずらしの口（off）で描く・継ぎはマイター）
			const gapExpr = L.paint?.["line-gap-width"];
			const offExpr = L.paint?.["line-offset"], off = offExpr != null || gapExpr != null ? B.off : null; if (off) off.n = 0;
			// 端と継ぎ（S-P1-1）：丸でない層だけ線分に隣の点 [P0, P3] を添える。ずらす層（line-offset・line-gap-width）は今は丸のまま（角の継ぎは miterSlides）
			const cj = lineCapJoin(L.layout, z, eo), jf = !off && cj & 15 ? B.jf : null; if (jf) jf.n = 0;
			// line-dasharray [線, 間隔, …]：走行距離の位相を保って線分を刻む。
			// renderer の capsule は丸端なので、刻んだ破片がそのままピル状のダッシュになる（トンネル破線等）。
			// 値は式として評価する（["literal",[..]]・step/interpolate・旧式関数の変換物）＝MapLibre でも zoom だけに依る＝層で一度。
			// 単位：内蔵 style は px（タイル基準ズームでの見かけ）、外来 MapLibre style（dashInLineWidths）は線幅の倍数。
			// 読めない値は破線なし（実線）に倒す＝線ごと消さない（2026-09-25・旧版は NaN で片が 0 になり線が消えた）
			const dashV = evalExpr(L.paint?.["line-dasharray"] ?? null, { zoom: z, props: {}, geom: null, vars: {}, origin: eo });
			const ml = !!(eo && L.dashInLineWidths), dashRaw = dashPattern(dashV, ml);
			const gpuDash = ml && dashRaw && !off && dashRaw.length <= DASH_GPU_MAX ? dashRaw : null;   // シェーダで描く（S-P1-3）＝刻まない
			const dist = gpuDash ? B.dist : null; if (dist) dist.n = 0;
			const dK = 2 ** (32 - z) / extent;   // タイル単位 → z24 の px
			const cpu = gpuDash || !dashRaw ? null : ml ? dashCpuML(dashRaw) : [dashRaw, dashRaw[0]] as [number[], number];   // CPU で刻む模様と刻み始めの残り
			const dashPat = cpu ? cpu[0] : null;
			const ctx: ExprContext = { zoom: z, props: null, geom: null, vars: {}, origin: eo, state: undefined, feat: null, tile: { z, x, y, E: extent } };   // feature 間で使い回す（compile 済み evalExpr は ctx を保持しない＝安全）
			for (const f of feats) {
				ctx.props = f.props; ctx.geom = f.type; ctx.state = undefined; ctx.feat = f;   // filter は filterSortFeatures で済んでいる。feat＝distance（C2）
				if (stateOf) ctx.state = stateOf(f);   // filter の後＝paint だけが読む
				const c = parseRGBA(pale(evalExpr(L.paint?.["line-color"] ?? "#000", ctx)));
				const op = L.paint?.["line-opacity"], ov = op != null ? evalExpr(op, ctx) : 1; const a = c[3] * ((ov === undefined && eo ? 1 : ov) as number);   // ML の評価エラー＝既定 1
				const cr = b255(c[0]), cg = b255(c[1]), cb = b255(c[2]), ca = b255(a);
				const w0 = evalExpr(L.paint?.["line-width"] ?? 1, ctx);
				const w = typeof w0 !== "number" || isNaN(w0) || w0 <= 0 ? 1 : w0;
				const hw = w * 0.5;
				let ow0 = 0;
				if (offExpr != null) { ow0 = +(evalExpr(offExpr, ctx) as number); if (!isFinite(ow0)) ow0 = 0; }
				let gw = 0;
				if (gapExpr != null) { gw = +(evalExpr(gapExpr, ctx) as number); if (!(gw > 0)) gw = 0; }
				for (let side = 0, nSide = gw ? 2 : 1; side < nSide; side++) {   // 隙間つき＝右（+）と左（−）の 2 本・無ければ 1 本
				const ow = gw ? ow0 + (side ? -1 : 1) * (gw * 0.5 + hw) : ow0;
				// 線分 1 本を書く（P1＝始点・P2＝終点の経緯度（原点相対）・色・半幅・ずらし）
				// link＝すぐ前に書いた線分の終点から続く（破線の 1 片が頂点を跨ぐ）＝互いに継ぐ旗
				const seg = (alon: number, alat: number, blon: number, blat: number, ta: number, tb: number, link: boolean): void => {
					const n = half.n, p1 = P1.reserve(2), p2 = P2.reserve(2), c4 = col.reserve(4), hf = half.reserve(1);
					if (jf) { const o = jf.reserve(1); o[n] = 0; if (link && n) { o[n] = JF_PREV; o[n - 1] |= JF_NEXT; } jf.n++; }
					p1[n * 2] = alon; p1[n * 2 + 1] = alat; p2[n * 2] = blon; p2[n * 2 + 1] = blat;
					c4[n * 4] = cr; c4[n * 4 + 1] = cg; c4[n * 4 + 2] = cb; c4[n * 4 + 3] = ca; hf[n] = hw;
					P1.n += 2; P2.n += 2; col.n += 4; half.n++;
					if (off) { const o = off.reserve(3); o[off.n++] = ow; o[off.n++] = ta; o[off.n++] = tb; }
				};
				const emit = (ax: number, ay: number, bx: number, by: number, ta: number, tb: number, link: boolean): void => {
					llInto(ax, ay, extent, sc, 0); const alon = sc[0], alat = sc[1];
					llInto(bx, by, extent, sc, 0);
					seg(alon, alat, sc[0], sc[1], ta, tb, link);
				};
				// フラットgeom：coords([x,y,…]) を ends の区切りで線/リング毎に走査（添字直読み＝Point中間なし）
				const { coords, ends } = f.geom!;
				if (!dashPat) {   // 破線でない線（とシェーダで描く破線）＝地物ごとに一度だけ作った線分列（lineSegs）を写す＝ケーシングと本線など同じ地物を描く層の数だけ経緯度化・細分をやり直さない
					const g = lineSegs(f.geom!, extent), n = g.n;
					if (!n) continue;
					if (jf) {   // 端と継ぎ（S-P1-1）：長さ 0 の線分は書かない（MapLibre も重なった点を捨てる）＝継ぐ相手が並びのすぐ前後になる
						linkSegs(g);
						const pv = g.pv!, nx = g.nx!;
						for (let j = 0; j < n; j++) {
							if (g.p1[j * 2] === g.p2[j * 2] && g.p1[j * 2 + 1] === g.p2[j * 2 + 1]) continue;
							const k = half.n, a1 = P1.reserve(2), a2 = P2.reserve(2), c4 = col.reserve(4), o = jf.reserve(1);
							a1[k * 2] = g.p1[j * 2]; a1[k * 2 + 1] = g.p1[j * 2 + 1]; a2[k * 2] = g.p2[j * 2]; a2[k * 2 + 1] = g.p2[j * 2 + 1];
							c4[k * 4] = cr; c4[k * 4 + 1] = cg; c4[k * 4 + 2] = cb; c4[k * 4 + 3] = ca; half.reserve(1)[k] = hw;
							o[k] = (pv[j] < 0 ? 0 : pv[j] < j ? JF_PREV : JF_RING_START) | (nx[j] < 0 ? 0 : nx[j] > j ? JF_NEXT : JF_RING_END);   // 継ぐ相手は長さ 0 を飛ばしたすぐ前後＝書いた並びでも隣
							if (dist) dist.reserve(1)[dist.n++] = g.d[j] * dK;
							P1.n += 2; P2.n += 2; col.n += 4; half.n++; jf.n++;
						}
						continue;
					}
					if (dist) { const a = dist.reserve(n); for (let j = 0, dn = dist.n; j < n; j++) a[dn++] = g.d[j] * dK; dist.n += n; }
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
						let pi = 0, rem = cpu![1] * k;   // 模様の何番目か（偶数＝線・奇数＝間）とその残り。頂点をまたいで継続＝角でダッシュが割れない
						let cont = false;   // 前の線分の最後の片が頂点まで線のまま届いた＝この線分の最初の片はそれと継ぐ（S-P1-1）
						for (let i = ls; i + 3 < le; i += 2) {   // 線分＝点(i)→点(i+2)
							const Ax = coords[i], Ay = coords[i + 1];
							const dx = coords[i + 2] - Ax, dy = coords[i + 3] - Ay, len = Math.hypot(dx, dy);
							if (!len) continue;
							const hidden = outsideSameSide(Ax, Ay, coords[i + 2], coords[i + 3], extent);   // 余白だけの線分＝模様の位相は進めて描かない
							let pos = 0, c = false;
							while (pos < len - 1e-9) {
								const take = Math.min(rem, len - pos), on = !(pi & 1) && take > 0 && !hidden;
								if (on) { const k = (i - ls) >> 1; emit(Ax + dx * (pos / len), Ay + dy * (pos / len), Ax + dx * ((pos + take) / len), Ay + dy * ((pos + take) / len), pos === 0 ? tS[k] ?? 0 : 0, pos + take >= len - 1e-9 ? tE[k] ?? 0 : 0, pos === 0 && cont); }
								pos += take; rem -= take;
								c = on && pos >= len - 1e-9;
								if (rem <= 1e-9) { pi = (pi + 1) % dashPat.length; rem = dashPat[pi] * k; c = false; }
							}
							cont = c;
						}
						ls = le; continue;
					}
					ls = le;
				}
				}   // side
			}
			if (half.n) {
				const op: LineOp = { kind: "line", li, id: L.id, P1: P1.out(), P2: P2.out(), col: col.out(), half: half.out() };
				if (off) { let any = false; for (let i = 0; i < off.n; i += 3) if (off.a[i]) { any = true; break; } if (any) op.off = off.out(); }   // [off, tS, tE]×線分。ずらしが全部 0（式が今の z で 0）なら持たない
				if (jf) { op.jf = jf.out(); op.cj = cj; }
				if (dist) { op.dist = dist.out(); op.dash = gpuDash!; op.dz = z; }
				const fx = eo ? layerFx(L, z, eo) : null; if (fx) op.fx = fx;   // line-translate・line-blur（S-P1-4/5）＝外来の層だけ
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
export function buildEmptySeaOps(layers: TileData, { z, x, y }: TileXYZ, style: Style, origin: readonly number[]): DrawOp[] | null {
	const id = style.emptySea; if (!id || z < 8) return null;
	const base = style.layers.find(L => L.id === id); if (!base) return null;
	const src = base["source-layer"] as string;
	if (!(layers as EmptyTile).__empty && !waOnlyPartial(layers as DecodedTile, src)) return null;
	const idxs: number[] = [];
	style.layers.forEach((L, i) => { if (L.type === "fill" && L["source-layer"] === src) idxs.push(i); });
	if (!idxs.length) return null;
	const sq: DecodedTile = { [src]: { extent: 4096, features: [{ type: "Polygon", id: 0, props: (style.schema && style.schema.seaProps) || {},   // 申告された「海の名乗り」（色式が属性を見る style でも水色に転ぶ）
		geom: { coords: new Int32Array([0, 0, 4096, 0, 4096, 4096, 0, 4096, 0, 0]), ends: [10] } }] } };
	const dl = buildTileDrawList({ layers: sq, z, x, y }, { layers: idxs.map(i => style.layers[i]) }, origin);
	for (const op of dl.ops) { op.li = SEA_FB_BASE + idxs[op.li]; op.id = "empty-sea:" + op.id; }   // sub-style の li(0..)→実li→擬似帯
	return dl.ops.length ? dl.ops : null;
}
// 「WA しか無く、その WA が全面を覆っていない」＝図郭縁ダミーの判定（覆率 99.5% 未満）。穴は無い前提の |面積| 和。
function waOnlyPartial(layers: DecodedTile, src: string): boolean {
	const names = Object.keys(layers); if (names.length !== 1 || names[0] !== src) return false;
	const { extent, features } = layers[src];
	let area = 0;
	for (const f of features) {
		if (f.type !== "Polygon") continue;
		const { coords, ends } = f.geom!; let p = 0;
		for (const e of ends) { area += Math.abs(signedArea(coords, p, e)); p = e; }
	}
	return area < extent * extent * 0.995;
}

// 層の filter に通る地物を、sort-key 式があれば昇順に並べ替える（安定ソート）。無ければ元順のまま。
// filter が先＝落ちる地物の sort-key は評価も並べ替えもしない。並べる順は「全地物を並べてから filter」と同じ（比較＝(鍵, 元の添字)の全順序）。
// ただし鍵に NaN（数でない sort-key）が混ざる時だけは比較が全順序でなく、並べ替えの結果が集合の大きさに依る＝旧来の順（全地物を並べてから filter）で並べる＝絵を変えない
function filterSortFeatures(features: DecodedFeature[], filter: unknown, sortExpr: unknown, z: number, eo: "ml" | undefined, tile: GeoCtxTile | null = null): DecodedFeature[] {
	const ctx: ExprContext = { zoom: z, props: null, geom: null, vars: {}, origin: eo, state: undefined, feat: null, tile };   // ctx は 1 個を使い回す（compile 済み evalExpr は ctx を保持しない）。feat/tile＝within/distance（C2）
	const pass = (f: DecodedFeature): boolean => { ctx.props = f.props; ctx.geom = f.type; ctx.feat = f; return truthy(evalExpr(filter, ctx)); };
	if (!sortExpr) return filter ? features.filter(pass) : features;
	const src = filter ? features.filter(pass) : features;
	// {f,i,k} を feature 毎に作らず、キー配列＋インデックス配列で安定ソート（GC削減）
	const sorted = (list: DecodedFeature[]): DecodedFeature[] | null => {
		const n = list.length, keys: unknown[] = new Array(n), idx: number[] = new Array(n);
		let nan = false;
		for (let i = 0; i < n; i++) { const f = list[i]; ctx.props = f.props; ctx.geom = f.type; ctx.feat = f; const k = evalExpr(sortExpr, ctx); keys[i] = k; idx[i] = i; if (Number.isNaN((k as number) - 0)) nan = true; }
		if (nan) return null;
		idx.sort((a, b) => ((keys[a] as number) - (keys[b] as number)) || (a - b));
		const out: DecodedFeature[] = new Array(n);
		for (let i = 0; i < n; i++) out[i] = list[idx[i]];
		return out;
	};
	const out = sorted(src);
	if (out || !filter) return out ?? legacySort(features, sortExpr, ctx);
	return legacySort(features, sortExpr, ctx).filter(pass);
}
// 旧来の並べ替え（全順序でない鍵＝NaN を含む時の順をそのまま保つ）
function legacySort(features: DecodedFeature[], sortExpr: unknown, ctx: ExprContext): DecodedFeature[] {
	const n = features.length, keys: unknown[] = new Array(n), idx: number[] = new Array(n);
	for (let i = 0; i < n; i++) { const f = features[i]; ctx.props = f.props; ctx.geom = f.type; ctx.feat = f; keys[i] = evalExpr(sortExpr, ctx); idx[i] = i; }
	idx.sort((a, b) => ((keys[a] as number) - (keys[b] as number)) || (a - b));
	const out: DecodedFeature[] = new Array(n);
	for (let i = 0; i < n; i++) out[i] = features[idx[i]];
	return out;
}

