// geojson を vector のタイルに切る（geojson vt plan G-1・2026-10-22）＝MapLibre の geojson-vt と同じ考え方の純関数。
// 出口は decodeMVT と同じ中間表現（DecodedTile）＝下流（vtdraw の filter・buildTileDrawList・labels）はタイルの出どころを知らない。
//   座標＝ウェブメルカトルのタイルの extent（既定 4096）・枠の外に buffer（既定 64＝geojson-vt と同じ）まで残す・整数へ丸める。
//   面＝輪ごとに Sutherland–Hodgman で枠に切る・外周は signedArea > 0（y 下向き＝decode.ts の polygons と同じ向き）・穴は < 0 に揃える・輪は先頭の点を複製して閉じる（decodeMVT と同じ）。
//   線＝線分ごとに Liang–Barsky で切り、続いている所はつなぐ。点＝枠（＋buffer）の中だけ。
//   日付変更線＝MapLibre（geojson-vt）と同じく座標をそのまま読む（170→−170 は世界を西へ回る）。±180 を越えた座標（190 など）で書いた地物は、
//   外接矩形が世界の外へはみ出す分を ±1 周ずらして同じタイルに切る（またぐ線・面はこの書き方で渡す）。
//   id＝Feature.id が数の時だけ（MVT と同じ）・promoteId は下流（vtdraw）が属性から引く。gt＝元の型（式の ["geometry-type"]・labels の §4g と同じ）。
//   線の進み（G-3・line-gradient の ["line-progress"]・MapLibre の lineMetrics）＝線（MultiLineString は 1 本ずつ）の頭からの長さの割合を頂点ごとに geom.prog へ。
//   長さはメルカトルの平面で測る（geojson-vt の lineMetrics と同じ尺）。切った端の点は切った線分の上で割合を補う＝タイルをまたいでも続く。
// 簡略化はしない（初版）。索引は外接矩形の素朴な走査＝模様・飾りの層（数千地物まで）向け。大きい source を流す時は格子を足す。
import type { DecodedFeature, DecodedGeomType, DecodedTile } from "./tileformat.ts";

/** 切った物の source-layer 名（geojson source の層は source-layer を持たない＝vtdraw がこの名で引く） */
export const GEOJSON_LAYER = "_geojson";
export interface GeojsonVtOptions { extent?: number; buffer?: number; layer?: string }
type Props = Record<string, unknown>;
/** 下ごしらえ済みの地物（座標＝メルカトルの [0,1]・x は世界の外へはみ出してよい） */
interface Prep { type: DecodedGeomType; gt: string; props: Props; id: number | undefined; parts: Float64Array[][]; bbox: [number, number, number, number]; prog?: Float64Array[] }
export interface GeojsonIndex { readonly count: number; tile(z: number, x: number, y: number): DecodedTile }

const MAXLAT = 85.05112878;
const mx = (lon: number) => (lon + 180) / 360;
const my = (lat: number) => { const s = Math.sin(Math.max(-MAXLAT, Math.min(MAXLAT, lat)) * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
// 経緯度の列 → メルカトルの平たい列
function project(coords: number[][]): Float64Array {
	const out = new Float64Array(coords.length * 2);
	for (let i = 0; i < coords.length; i++) { out[i * 2] = mx(coords[i][0]); out[i * 2 + 1] = my(coords[i][1]); }
	return out;
}
type Geom = { type: string; coordinates?: unknown; geometries?: Geom[] } | null | undefined;
type Feat = { type?: string; id?: unknown; properties?: Props | null; geometry?: Geom };
function prepGeom(g: Geom, props: Props, id: number | undefined, out: Prep[]): void {
	if (!g) return;
	if (g.type === "GeometryCollection") { for (const s of g.geometries || []) prepGeom(s, props, id, out); return; }
	const c = g.coordinates as unknown;
	let type: DecodedGeomType, parts: Float64Array[][];
	if (g.type === "Point") { type = "Point"; parts = [[project([c as number[]])]]; }
	else if (g.type === "MultiPoint") { type = "Point"; parts = [[project(c as number[][])]]; }
	else if (g.type === "LineString") { type = "LineString"; parts = [[project(c as number[][])]]; }
	else if (g.type === "MultiLineString") { type = "LineString"; parts = [(c as number[][][]).map(l => project(l))]; }
	else if (g.type === "Polygon") { type = "Polygon"; parts = [(c as number[][][]).map(r => project(r))]; }
	else if (g.type === "MultiPolygon") { type = "Polygon"; parts = (c as number[][][][]).map(p => p.map(r => project(r))); }
	else return;
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const p of parts) for (const a of p) for (let i = 0; i < a.length; i += 2) { const x = a[i], y = a[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
	if (!(x0 <= x1)) return;
	out.push({ type, gt: g.type, props, id, parts, bbox: [x0, y0, x1, y1], ...(type === "LineString" ? { prog: parts[0].map(lineProg) } : {}) });
}

// 線の頂点ごとの進み（頭からの長さ÷全長・メルカトルの平面）。長さ 0 の線は全部 0
function lineProg(a: Float64Array): Float64Array {
	const n = a.length >> 1, p = new Float64Array(n);
	for (let i = 1; i < n; i++) p[i] = p[i - 1] + Math.hypot(a[i * 2] - a[i * 2 - 2], a[i * 2 + 1] - a[i * 2 - 1]);
	const L = p[n - 1]; if (L > 0) for (let i = 1; i < n; i++) p[i] /= L;
	return p;
}
// 線分を [lo, hi]² に切る（Liang–Barsky）＝[ax, ay, bx, by, t0, t1]（t＝元の線分の上の位置）か null
function clipSeg(ax: number, ay: number, bx: number, by: number, lo: number, hi: number): number[] | null {
	const dx = bx - ax, dy = by - ay;
	let t0 = 0, t1 = 1;
	for (const [p, q] of [[-dx, ax - lo], [dx, hi - ax], [-dy, ay - lo], [dy, hi - ay]]) {
		if (p === 0) { if (q < 0) return null; continue; }
		const r = q / p;
		if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
	}
	return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy, t0, t1];
}
// 輪を [lo, hi]² に切る（Sutherland–Hodgman・4 辺）＝閉じていない平たい列
function clipRing(r: number[], lo: number, hi: number): number[] {
	let cur = r;
	for (let e = 0; e < 4 && cur.length >= 6; e++) {
		const ax = e >> 1 === 0, keepHi = (e & 1) === 1, lim = keepHi ? hi : lo;   // e＝0:x≥lo 1:x≤hi 2:y≥lo 3:y≤hi
		const inside = (x: number, y: number) => { const v = ax ? x : y; return keepHi ? v <= lim : v >= lim; };
		const out: number[] = [], n = cur.length >> 1;
		for (let i = 0; i < n; i++) {
			const px = cur[((i + n - 1) % n) * 2], py = cur[((i + n - 1) % n) * 2 + 1], qx = cur[i * 2], qy = cur[i * 2 + 1];
			const pin = inside(px, py), qin = inside(qx, qy);
			if (pin !== qin) { const t = ((ax ? px : py) - lim) / ((ax ? px : py) - (ax ? qx : qy)); out.push(px + (qx - px) * t, py + (qy - py) * t); }
			if (qin) out.push(qx, qy);
		}
		cur = out;
	}
	return cur;
}
const ringArea = (c: number[]) => { let s = 0; const n = c.length >> 1; for (let i = 0; i < n; i++) { const j = (i + 1) % n; s += c[i * 2] * c[j * 2 + 1] - c[j * 2] * c[i * 2 + 1]; } return s / 2; };
const reverseRing = (c: number[]) => { const o: number[] = []; for (let i = c.length - 2; i >= 0; i -= 2) o.push(c[i], c[i + 1]); return o; };

export function createGeojsonIndex(data: unknown, { extent = 4096, buffer = 64, layer = GEOJSON_LAYER }: GeojsonVtOptions = {}): GeojsonIndex {
	const d = data as { type?: string; features?: Feat[]; geometry?: Geom } | Feat[] | null;
	const feats: Feat[] = Array.isArray(d) ? d : d?.type === "FeatureCollection" ? d.features || [] : d?.type === "Feature" ? [d as Feat] : d?.type ? [{ type: "Feature", properties: {}, geometry: d as Geom }] : [];
	const prep: Prep[] = [];
	for (const f of feats) if (f) prepGeom(f.geometry, f.properties || {}, typeof f.id === "number" ? f.id : undefined, prep);
	return {
		get count() { return prep.length; },
		tile(z, x, y) {
			const n = 2 ** z, b = buffer / extent, X0 = x / n, Y0 = y / n, W = 1 / n, lo = -buffer, hi = extent + buffer;
			const bx0 = X0 - b * W, bx1 = X0 + W + b * W, by0 = Y0 - b * W, by1 = Y0 + W + b * W;
			const features: DecodedFeature[] = [];
			for (const p of prep) {
				if (p.bbox[1] > by1 || p.bbox[3] < by0) continue;
				for (const k of [0, -1, 1]) {   // 世界をずらした写し（日付変更線をまたぐ地物・タイルの x は [0, n)）
					if (p.bbox[0] + k > bx1 || p.bbox[2] + k < bx0) continue;
					const tx = (v: number) => ((v + k) - X0) * n * extent, ty = (v: number) => (v - Y0) * n * extent;
					const out: number[] = [], ends: number[] = [], prog: number[] = [];
					if (p.type === "Point") {
						for (const a of p.parts[0]) for (let i = 0; i < a.length; i += 2) { const px = tx(a[i]), py = ty(a[i + 1]); if (px >= lo && px <= hi && py >= lo && py <= hi) { out.push(Math.round(px), Math.round(py)); ends.push(out.length); } }
					} else if (p.type === "LineString") {
						p.parts[0].forEach((a, li) => {
							const pr = p.prog![li];
							let cur: number[] = [], cp: number[] = [];
							const flush = () => { if (cur.length >= 4) { for (const v of cur) out.push(Math.round(v)); for (const v of cp) prog.push(v); ends.push(out.length); } cur = []; cp = []; };
							for (let i = 0; i + 3 < a.length; i += 2) {
								const s = clipSeg(tx(a[i]), ty(a[i + 1]), tx(a[i + 2]), ty(a[i + 3]), lo, hi);
								if (!s) { flush(); continue; }
								const m = cur.length, p0 = pr[i >> 1], dp = pr[(i >> 1) + 1] - p0;
								if (!m || cur[m - 2] !== s[0] || cur[m - 1] !== s[1]) { flush(); cur.push(s[0], s[1]); cp.push(p0 + dp * s[4]); }
								cur.push(s[2], s[3]); cp.push(p0 + dp * s[5]);
							}
							flush();
						});
					} else {
						for (const poly of p.parts) {
							let first = true, start = out.length, startEnds = ends.length;
							for (const a of poly) {
								const r: number[] = []; for (let i = 0; i < a.length; i += 2) r.push(tx(a[i]), ty(a[i + 1]));
								if (r.length >= 4 && r[0] === r[r.length - 2] && r[1] === r[r.length - 1]) r.length -= 2;   // 閉じの重複を外して切る
								let c = clipRing(r, lo, hi).map(Math.round);
								const ar = c.length >= 6 ? ringArea(c) : 0;
								if (!ar) { if (first) break; continue; }   // 外周が消えた＝この面はタイルに無い（穴だけ残さない）
								if ((first && ar < 0) || (!first && ar > 0)) c = reverseRing(c);
								for (const v of c) out.push(v);
								out.push(c[0], c[1]); ends.push(out.length);
								first = false;
							}
							if (first) { out.length = start; ends.length = startEnds; }
						}
					}
					if (ends.length) features.push({ type: p.type, props: p.props, geom: { coords: Int32Array.from(out), ends, ...(prog.length ? { prog: Float32Array.from(prog) } : {}) }, id: p.id, gt: p.gt });
				}
			}
			return features.length ? { [layer]: { extent, features } } : {};
		},
	};
}
