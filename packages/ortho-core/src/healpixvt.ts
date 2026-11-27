// ベクタ（点・線・多角形）を HEALPix のタイルに切る純関数（2026-11-27・規約＝docs/design/healpix.md §5）。
// タイルの中の座標＝面ごとの (x, y)（x＝ix の向き＝北東・y＝iy の向き＝北西・標高タイルの列と行と同じ）を 0..extent の整数にした物。番地は標高と同じ NESTED。
// 切り方：面 1 つは「経緯度の矩形の窓」に収まり、その窓の中では面の座標が途切れなく伸びる（冠の面＝経度 90° 幅×緯度 0..±90°・赤道の面＝経度 ±45°×緯度 ±41.8°）。
//   ① 輪を経度で巻き戻す（180° 線をまたぐ輪を連続に）。極を一周する輪は極の点を足して閉じる
//   ② 面ごとに、窓（経緯度の矩形）で切る → 面の座標へ写す（曲がりが tol を超える辺は途中に点を足す）→ 面の正方形 [0,1]² で切る
//   ③ 面の中を四分木で order まで刻み、タイルの中の整数へ丸める
// 窓で切った切り口は面の外（か面の角）にある＝②の正方形で落ちる＝面の中に余計な継ぎ目を残さない。軸に平行な直線で切るだけ＝メルカトルの XYZ と同じ算法。
// 辺は「経緯度でまっすぐ」と読む（GeoJSON・MVT と同じ）。面積は面の座標で保たれる（HEALPix は等積）＝検定 tests/healpix-vt.mjs の物差し。
import { lonLatToXYF, xyfToLonLat, nestOf, cellOf } from "./healpix.ts";

export type Pt = [number, number];
/** 経緯度の図形：point＝点の並び・line＝折れ線の並び・polygon＝輪の並び（外周と穴を区別しない＝向きで分かる・閉じの重複点は有っても無くてもよい） */
export interface LLGeom { type: "point" | "line" | "polygon"; coords: Pt[][] }
/** 面の座標の図形（x, y ∈ [0,1]）。polygon の輪は閉じの重複点なし */
export interface FaceGeom { face: number; type: LLGeom["type"]; parts: Pt[][] }
/** タイルの中の図形（0..extent の整数・y は上向き＝iy の向き） */
export interface TileGeom { order: number; npix: number; type: LLGeom["type"]; parts: Pt[][] }

const D2R = Math.PI / 180, LAT0 = Math.asin(2 / 3) / D2R;   // 冠と赤道帯の境＝41.81°

// ── 軸に平行な直線で切る（axis 0＝x・1＝y、keep＝+1 なら v 以上を残す・−1 なら v 以下）──
function clipRing(ring: Pt[], axis: 0 | 1, v: number, keep: 1 | -1): Pt[] {   // Sutherland–Hodgman（凹の輪は縁に幅 0 の橋が残る＝面積は変わらない）
	const out: Pt[] = [], n = ring.length;
	for (let i = 0; i < n; i++) {
		const a = ring[i], b = ring[(i + 1) % n], ia = (a[axis] - v) * keep >= 0, ib = (b[axis] - v) * keep >= 0;
		if (ia) out.push(a);
		if (ia !== ib) { const t = (v - a[axis]) / (b[axis] - a[axis]), p: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; p[axis] = v; out.push(p); }
	}
	return out;
}
function clipLine(line: Pt[], axis: 0 | 1, v: number, keep: 1 | -1): Pt[][] {
	const out: Pt[][] = []; let cur: Pt[] = [];
	for (let i = 0; i < line.length; i++) {
		const b = line[i], ib = (b[axis] - v) * keep >= 0;
		if (i > 0) {
			const a = line[i - 1], ia = (a[axis] - v) * keep >= 0;
			if (ia !== ib) { const t = (v - a[axis]) / (b[axis] - a[axis]), p: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; p[axis] = v; cur.push(p); if (!ib) { if (cur.length > 1) out.push(cur); cur = []; } }
		}
		if (ib) cur.push(b);
	}
	if (cur.length > 1) out.push(cur);
	return out;
}
function clipBox(type: LLGeom["type"], parts: Pt[][], x0: number, y0: number, x1: number, y1: number): Pt[][] {
	if (type === "point") return parts.map(p => p.filter(q => q[0] >= x0 && q[0] <= x1 && q[1] >= y0 && q[1] <= y1)).filter(p => p.length);
	const cuts: [0 | 1, number, 1 | -1][] = [[0, x0, 1], [0, x1, -1], [1, y0, 1], [1, y1, -1]];
	let cur = parts;
	for (const [axis, v, keep] of cuts) {
		const next: Pt[][] = [];
		for (const p of cur) {
			if (type === "polygon") { const r = clipRing(p, axis, v, keep); if (r.length >= 3) next.push(r); }
			else for (const l of clipLine(p, axis, v, keep)) next.push(l);
		}
		cur = next; if (!cur.length) break;
	}
	return cur;
}
const ringArea = (r: Pt[]): number => { let a = 0; for (let i = 0; i < r.length; i++) { const u = r[i], v = r[(i + 1) % r.length]; a += u[0] * v[1] - v[0] * u[1]; } return a / 2; };
const bbox = (p: Pt[]): [number, number, number, number] => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const q of p) { if (q[0] < a) a = q[0]; if (q[0] > c) c = q[0]; if (q[1] < b) b = q[1]; if (q[1] > d) d = q[1]; } return [a, b, c, d]; };

// ── ① 経度の巻き戻しと、極を一周する輪の閉じ ──
function unwrap(pts: Pt[], closed: boolean): Pt[] {
	const out: Pt[] = []; let off = 0;
	for (let i = 0; i < pts.length; i++) {
		if (i > 0) { const d = pts[i][0] - pts[i - 1][0]; if (d > 180 && d < 360) off -= 360; else if (d < -180 && d > -360) off += 360; }   // 180° を超える進み＝180° 線をまたいだ書き方。ちょうど 360°（−180→180）は全周の辺として通す
		out.push([pts[i][0] + off, Math.max(-90, Math.min(90, pts[i][1]))]);
	}
	if (closed && out.length > 2) {
		const f = out[0], l = out[out.length - 1];
		if (Math.abs(l[0] - f[0]) < 1e-12 && Math.abs(l[1] - f[1]) < 1e-12) out.pop();   // 閉じの重複点
		const last = out[out.length - 1]; let d = out[0][0] - last[0]; if (Math.abs(d) !== 360) d -= Math.round(d / 360) * 360;   // 閉じる辺の経度の進み
		const turn = last[0] + d - out[0][0];   // 一周ぶんの経度（0 か ±360）
		if (Math.abs(turn) > 180) {   // 極を一周する輪＝極の点を足して、巻き戻した平面の上で閉じる。どちらの極かは輪の緯度の平均で決める
			let m = 0; for (const p of out) m += p[1];
			const pole = m >= 0 ? 90 : -90;
			out.push([out[0][0] + turn, out[0][1]], [out[0][0] + turn, pole], [out[0][0], pole]);
		}
	}
	return out;
}

// ── ② 面の窓と、窓の中で途切れない面の座標 ──
/** 面の窓＝[西, 南, 東, 北]（度・経度は面 4 だけ −45..45） */
export function hpxFaceWindow(face: number): [number, number, number, number] {
	const k = face & 3;
	return face < 4 ? [k * 90, 0, k * 90 + 90, 90] : face < 8 ? [k * 90 - 45, -LAT0, k * 90 + 45, LAT0] : [k * 90, -90, k * 90 + 90, 0];
}
// 窓の中の点 → その面の座標（面の外は [0,1] をはみ出す）。healpix.ts の locToXYF を「面を決め打ち」にした版
function toFace(face: number, lon: number, lat: number): Pt {
	const k = face & 3, z = Math.sin(lat * D2R), tt = lon / 90;
	if (face >= 4 && face < 8 || Math.abs(z) <= 2 / 3) {
		const jP = 0.5 + tt - 0.75 * z, jM = 0.5 + tt + 0.75 * z;
		return face < 4 ? [jM - (k + 1), 1 - (jP - k)] : face < 8 ? [jM - k, 1 - (jP - k)] : [jM - k, k + 2 - jP];
	}
	const tp = tt - k, tmp = Math.sqrt(3 * (1 - Math.abs(z)));
	return face < 4 ? [1 - (1 - tp) * tmp, 1 - tp * tmp] : [tp * tmp, (1 - tp) * tmp];
}
// 辺を面の座標へ写す：経緯度の中点の写し先が、写した両端の中点から tol を超えて外れる間は 2 つに割る
function mapEdge(face: number, a: Pt, b: Pt, fa: Pt, fb: Pt, tol: number, depth: number, out: Pt[]): void {
	if (depth < 14) {
		const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], fm = toFace(face, m[0], m[1]);
		if (Math.abs(fm[0] - (fa[0] + fb[0]) / 2) > tol || Math.abs(fm[1] - (fa[1] + fb[1]) / 2) > tol) { mapEdge(face, a, m, fa, fm, tol, depth + 1, out); mapEdge(face, m, b, fm, fb, tol, depth + 1, out); return; }
	}
	out.push(fb);
}
function mapPath(face: number, pts: Pt[], closed: boolean, tol: number): Pt[] {
	const f = pts.map(p => toFace(face, p[0], p[1])), out: Pt[] = [f[0]], n = pts.length;
	for (let i = 1; i < n; i++) mapEdge(face, pts[i - 1], pts[i], f[i - 1], f[i], tol, 0, out);
	if (closed) { mapEdge(face, pts[n - 1], pts[0], f[n - 1], f[0], tol, 0, out); out.pop(); }
	return out;
}

/** 経緯度の図形を面ごとに切り、面の座標へ写す。tol＝辺の曲がりの許し（面の一辺＝1 の単位・既定＝order 12 の 4096 刻みの 1/4） */
export function hpxSplitFaces(g: LLGeom, tol = 1 / (4096 * 4096 * 4)): FaceGeom[] {
	const out: FaceGeom[] = [];
	if (g.type === "point") {
		const by = new Map<number, Pt[]>(), f = { face: 0, x: 0, y: 0 };
		for (const part of g.coords) for (const p of part) { lonLatToXYF(p[0], p[1], f); (by.get(f.face) ?? by.set(f.face, []).get(f.face)!).push([f.x, f.y]); }
		for (const [face, pts] of by) out.push({ face, type: "point", parts: [pts] });
		return out;
	}
	const closed = g.type === "polygon", paths = g.coords.map(c => unwrap(c, closed)).filter(c => c.length >= (closed ? 3 : 2)), boxes = paths.map(bbox);
	for (let face = 0; face < 12; face++) {
		const [w, s, e, n] = hpxFaceWindow(face), parts: Pt[][] = [];
		for (let i = 0; i < paths.length; i++) {
			const [x0, y0, x1, y1] = boxes[i];
			if (y1 < s || y0 > n) continue;
			for (let sh = Math.ceil((w - x1) / 360) * 360; x0 + sh <= e; sh += 360) {   // 窓に重なる 360° ずらしの分だけ
				const moved = sh ? paths[i].map(p => [p[0] + sh, p[1]] as Pt) : paths[i];
				for (const piece of clipBox(g.type, [moved], w, s, e, n)) for (const q of clipBox(g.type, [mapPath(face, piece, closed, tol)], 0, 0, 1, 1)) if (!closed || Math.abs(ringArea(q)) > 1e-14) parts.push(q);   // 窓の縁に触れただけの潰れた輪は捨てる
			}
		}
		if (parts.length) out.push({ face, type: g.type, parts });
	}
	return out;
}

// ── ③ 面の中を四分木で刻み、タイルの中の整数へ ──
function quantize(type: LLGeom["type"], p: Pt[], n: number, ix: number, iy: number, extent: number): Pt[] | null {
	const out: Pt[] = [];
	for (const q of p) {
		const x = Math.max(0, Math.min(extent, Math.round((q[0] * n - ix) * extent))), y = Math.max(0, Math.min(extent, Math.round((q[1] * n - iy) * extent)));
		const l = out[out.length - 1];
		if (type !== "point" && l && l[0] === x && l[1] === y) continue;   // 同じ刻みに落ちた続きの点
		out.push([x, y]);
	}
	if (type === "polygon") {
		while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
		let a = 0; for (let i = 0; i < out.length; i++) { const u = out[i], v = out[(i + 1) % out.length]; a += u[0] * v[1] - v[0] * u[1]; }
		return out.length >= 3 && a !== 0 ? out : null;   // 潰れた輪（面積 0）は捨てる
	}
	return out.length >= (type === "line" ? 2 : 1) ? out : null;
}
/** 面の図形を order のタイルへ刻む。extent＝タイルの刻み（MVT の既定 4096） */
export function hpxSliceFace(fg: FaceGeom, order: number, extent = 4096): TileGeom[] {
	const out: TileGeom[] = [], N = 2 ** order;
	if (fg.type === "point") {   // 点は切らずに、その点を含むタイルへ直に（縁ちょうどの点が 2 枚に入らない）
		const by = new Map<number, Pt[]>();
		for (const part of fg.parts) for (const q of part) {
			const ix = Math.min(N - 1, Math.floor(q[0] * N)), iy = Math.min(N - 1, Math.floor(q[1] * N)), np = nestOf(order, fg.face, ix, iy);
			(by.get(np) ?? by.set(np, []).get(np)!).push(quantize("point", [q], N, ix, iy, extent)![0]);
		}
		for (const [npix, pts] of by) out.push({ order, npix, type: "point", parts: [pts] });
		return out;
	}
	const rec = (parts: Pt[][], k: number, ix: number, iy: number): void => {
		if (!parts.length) return;
		if (k === order) {
			const q = parts.map(p => quantize(fg.type, p, N, ix, iy, extent)).filter((p): p is Pt[] => !!p);
			if (q.length) out.push({ order, npix: nestOf(order, fg.face, ix, iy), type: fg.type, parts: q });
			return;
		}
		const n = 2 ** (k + 1);
		for (let c = 0; c < 4; c++) { const cx = ix * 2 + (c & 1), cy = iy * 2 + (c >> 1); rec(clipBox(fg.type, parts, cx / n, cy / n, (cx + 1) / n, (cy + 1) / n), k + 1, cx, cy); }
	};
	rec(fg.parts, 0, 0, 0);
	return out;
}
/** タイルの中の図形を間引く（Douglas–Peucker・tol＝刻みの単位）。線の両端と、タイルの縁に乗る点は動かさない＝隣のタイルとの継ぎを保つ。
 *  多角形は minArea（刻み²）より小さい輪を捨てる。粗い段で頂点を減らすための物（最も細かい段には使わない） */
export function hpxSimplify(t: TileGeom, tol: number, minArea = 0, extent = 4096): TileGeom | null {
	if (t.type === "point") return t;
	const onEdge = (q: Pt): boolean => q[0] === 0 || q[1] === 0 || q[0] === extent || q[1] === extent;
	const dp = (p: Pt[], keep: Uint8Array, a: number, b: number): void => {
		const st: [number, number][] = [[a, b]];
		while (st.length) {
			const [i, j] = st.pop()!; if (j - i < 2) continue;
			const dx = p[j][0] - p[i][0], dy = p[j][1] - p[i][1], L = Math.hypot(dx, dy) || 1; let m = -1, md = tol;
			for (let k = i + 1; k < j; k++) { const d = L === 1 && !dx && !dy ? Math.hypot(p[k][0] - p[i][0], p[k][1] - p[i][1]) : Math.abs((p[k][0] - p[i][0]) * dy - (p[k][1] - p[i][1]) * dx) / L; if (d > md) { md = d; m = k; } }
			if (m >= 0) { keep[m] = 1; st.push([i, m], [m, j]); }
		}
	};
	const parts: Pt[][] = [];
	for (const p0 of t.parts) {
		const closed = t.type === "polygon";
		if (closed && Math.abs(ringArea(p0)) < minArea) continue;
		const p = closed ? [...p0, p0[0]] : p0, keep = new Uint8Array(p.length); keep[0] = keep[p.length - 1] = 1;
		for (let i = 0; i < p.length; i++) if (onEdge(p[i])) keep[i] = 1;
		let last = 0; for (let i = 1; i < p.length; i++) if (keep[i]) { dp(p, keep, last, i); last = i; }
		const q = p.filter((_, i) => keep[i]); if (closed) q.pop();
		if (closed ? q.length >= 3 && ringArea(q) !== 0 : q.length >= 2) parts.push(q);
		else if (closed && Math.abs(ringArea(p0)) >= Math.max(minArea, 1)) parts.push(p0);   // 間引くと潰れる輪は元のまま
	}
	return parts.length ? { ...t, parts } : null;
}
/** 経緯度の図形 → order のタイルごとの図形（①〜③ を通す）。曲がりの許しは刻みの 1/4 */
export function hpxTileGeoms(g: LLGeom, order: number, extent = 4096): TileGeom[] {
	return hpxSplitFaces(g, 1 / (2 ** order * extent * 4)).flatMap(f => hpxSliceFace(f, order, extent));
}
/** タイルの中の座標 → [経度, 緯度]（読む側の組み立ての入口と同じ計算） */
export function hpxTilePointLonLat(order: number, npix: number, x: number, y: number, extent = 4096, out: { [i: number]: number } = [0, 0]): { [i: number]: number } {
	const c = cellOf(order, npix), n = 2 ** order;
	return xyfToLonLat(c.face, Math.min(1, (c.ix + x / extent) / n), Math.min(1, (c.iy + y / extent) / n), out);
}

// ── MVT に詰める（Mapbox Vector Tile 2.1 の器をそのまま・座標の意味だけが面の (x, y)・y は上向き）──
export type VtValue = string | number | boolean;
export interface VtFeature { id?: number; type: LLGeom["type"]; parts: Pt[][]; props?: Record<string, VtValue> }
export interface VtLayer { name: string; extent?: number; features: VtFeature[] }
class Pbf {
	buf: number[] = [];
	varint(v: number): void { while (v > 0x7f) { this.buf.push((v % 128) | 0x80); v = Math.floor(v / 128); } this.buf.push(v); }
	tag(field: number, wire: number): void { this.varint(field * 8 + wire); }
	bytes(field: number, b: ArrayLike<number>): void { this.tag(field, 2); this.varint(b.length); for (let i = 0; i < b.length; i++) this.buf.push(b[i]); }
	str(field: number, s: string): void { this.bytes(field, new TextEncoder().encode(s)); }
	uint(field: number, v: number): void { this.tag(field, 0); this.varint(v); }
}
const zig = (v: number): number => v < 0 ? -v * 2 - 1 : v * 2;
/** 層の並び → MVT のバイト列。多角形の輪の向き（外周と穴）は渡された物のまま（y が上向き＝外周は反時計回りが正の面積） */
export function encodeHpxVt(layers: VtLayer[]): Uint8Array {
	const tile = new Pbf();
	for (const L of layers) {
		const lay = new Pbf(), keys = new Map<string, number>(), vals = new Map<string, number>(), valList: VtValue[] = [];
		lay.uint(15, 2); lay.str(1, L.name);
		for (const f of L.features) {
			const fe = new Pbf(), tags: number[] = [], geom: number[] = [];
			if (f.id !== undefined) fe.uint(1, f.id);
			for (const [k, v] of Object.entries(f.props ?? {})) {
				if (!keys.has(k)) keys.set(k, keys.size);
				const vk = typeof v + ":" + v; if (!vals.has(vk)) { vals.set(vk, valList.length); valList.push(v); }
				tags.push(keys.get(k)!, vals.get(vk)!);
			}
			let cx = 0, cy = 0;
			const move = (p: Pt): void => { geom.push(zig(p[0] - cx), zig(p[1] - cy)); cx = p[0]; cy = p[1]; };
			if (f.type === "point") { const pts = f.parts.flat(); geom.push(1 | (pts.length << 3)); pts.forEach(move); }
			else for (const p of f.parts) {
				geom.push(1 | (1 << 3)); move(p[0]);
				geom.push(2 | ((p.length - 1) << 3)); for (let i = 1; i < p.length; i++) move(p[i]);
				if (f.type === "polygon") geom.push(7 | (1 << 3));
			}
			const pk = (a: number[]): number[] => { const w = new Pbf(); a.forEach(v => w.varint(v)); return w.buf; };
			if (tags.length) fe.bytes(2, pk(tags));
			fe.uint(3, f.type === "point" ? 1 : f.type === "line" ? 2 : 3);
			fe.bytes(4, pk(geom));
			lay.bytes(2, fe.buf);
		}
		for (const k of keys.keys()) lay.str(3, k);
		for (const v of valList) {
			const w = new Pbf();
			if (typeof v === "string") w.str(1, v);
			else if (typeof v === "boolean") w.uint(7, v ? 1 : 0);
			else if (Number.isInteger(v) && v >= 0) w.uint(5, v);
			else if (Number.isInteger(v)) w.uint(6, zig(v));
			else { w.tag(3, 1); const b = new Uint8Array(new Float64Array([v]).buffer); for (const x of b) w.buf.push(x); }
			lay.bytes(4, w.buf);
		}
		lay.uint(5, L.extent ?? 4096);
		tile.bytes(3, lay.buf);
	}
	return Uint8Array.from(tile.buf);
}
