// The DataSourceDisplay of the facade: the engine's Entity objects (from entities.add, CzmlDataSource, GeoJsonDataSource, KmlDataSource…)
// evaluated at the clock's time and handed to the globe's drawing:
//   point / billboard / label / path → the czml overlay's tracks (time-sampled positions play on the globe's clock)
//   polyline → a 3D line (the overlay) or, clamped to ground, a GeoJSON line layer
//   box / cylinder / ellipsoid (constant, not on terrain) → Cesium's own geometry (the graphic's updater makes the fill and outline instances) drawn as a primitive is
//   polygon / rectangle / ellipse / corridor / wall / polylineVolume (and the time-varying solids) → GeoJSON fill, line and fill-extrusion layers
//   model → map.gadget.model (heading, and the full attitude as an ENU rotation when the orientation pitches or rolls)
// It also answers what the CesiumWidget asks of a display: update(time), getBoundingSphere(entity) for zoomTo / flyTo / trackedEntity,
// and picking (what is under a screen point).
import { BoundingSphere, Cartesian2, Cartesian3, Cartographic, Color, CorridorOutlineGeometry, Ellipsoid, FixedFrameTransforms, JulianDate, Math as CMath, PolygonHierarchy, PolylinePipeline, Quaternion, Matrix3, Matrix4, ArcType, ReferenceFrame, TimeInterval } from "@cesium/core";
import * as engine from "@cesium/engine";
import { CustomDataSource, HorizontalOrigin, LabelStyle, SceneTransforms, VerticalOrigin, HeightReference, Transforms, ClassificationType } from "@cesium/engine";
import { unsupported } from "./report.ts";
import { cesiumSphereOf } from "./spheres.ts";
import { gltfFailed, gltfSphere, modelSilOf, modelTintOf } from "./gltf.ts";
import { modelEnvSH } from "./lighting.ts";
import { Cesium3DTileset } from "./tileset.ts";
import { PrimitiveDrawer } from "./primitives.ts";
import { runClustering } from "./clusters.ts";
import type { ClusterState } from "./clusters.ts";
import { matKey, matOfProperty, paint } from "./materials.ts";
import type { MatDesc } from "./materials.ts";
import type { Host, OrthoScene } from "./scene.ts";
import { timed } from "./perf.ts";

type Any = any;
const { BoundingSphereState, Property, ColorGeometryInstanceAttribute } = engine as Any;   // runtime exports the d.ts leaves out (and Property's static helpers)
// the solids drawn with Cesium's own geometry: [graphic, its updater]
//   and the shapes off the ground (polygon, rectangle, ellipse, corridor at a height or extruded; wall; polylineVolume): Cesium's geometry gives
//   their per-position heights, rotation, cross-section and outline (only the corner and every-few vertical lines) as Cesium draws them
const E = engine as Any;
const SOLIDS: [string, Any][] = [["box", E.BoxGeometryUpdater], ["cylinder", E.CylinderGeometryUpdater], ["ellipsoid", E.EllipsoidGeometryUpdater],
	["polygon", E.PolygonGeometryUpdater], ["rectangle", E.RectangleGeometryUpdater], ["ellipse", E.EllipseGeometryUpdater], ["corridor", E.CorridorGeometryUpdater],
	["wall", E.WallGeometryUpdater], ["polylineVolume", E.PolylineVolumeGeometryUpdater], ["plane", E.PlaneGeometryUpdater]];
/** a height measured from the terrain (Cesium moves such geometry with the ground under it): the GeoJSON layers below draw it */
const isClamp = (h: number) => h === HeightReference.CLAMP_TO_GROUND || h === (HeightReference as Any).CLAMP_TO_TERRAIN || h === (HeightReference as Any).CLAMP_TO_3D_TILE;
const isRelative = (h: number) => h === HeightReference.RELATIVE_TO_GROUND || h === (HeightReference as Any).RELATIVE_TO_TERRAIN || h === (HeightReference as Any).RELATIVE_TO_3D_TILE;
/** a ground-referenced shape's absolute base and top (m): h/x = height/extrudedHeight, hr/xr their references, gh = the terrain at the shape's
 *  centre (off) and the lowest under its outline (min). A clamped height is 0 above the centre's ground, a relative one is measured from it,
 *  a clamped extrusion goes 50 m under the lowest ground (Cesium: ApproximateTerrainHeights' minimum) */
export function groundHeights(h: number, x: number | undefined, hr: number, xr: number, gh: { off: number; min: number }): { base: number; top: number } {
	const H = (isClamp(hr) ? 0 : h) + (hr !== HeightReference.NONE ? gh.off : 0);
	if (x == null) return { base: H - 0.5, top: H + 0.5 };
	const X = isClamp(xr) ? gh.min - 50 : x + (isRelative(xr) ? gh.off : 0);
	const lo = Math.min(H, X), hi = Math.max(H, X);
	return { base: lo, top: Math.max(hi, lo + 0.01) };
}
const onGround = (g: Any, t: JulianDate) => [g.heightReference, g.extrudedHeightReference].some(p => { const v = val(p, t, HeightReference.NONE); return v !== HeightReference.NONE; });
/** a polygon, rectangle, ellipse or corridor with neither height nor extrusion lies on the surface (the GeoJSON fill drapes it; Cesium's is a ground primitive) */
const SURFACE = new Set(["polygon", "rectangle", "ellipse", "corridor"]);
const onSurface = (name: string, g: Any, t: JulianDate) => SURFACE.has(name) && val(g.height, t) == null && val(g.extrudedHeight, t) == null && !val(g.perPositionHeight, t, false);
const R2D = 180 / Math.PI, D2R = Math.PI / 180, FAR = 8.64e15;
const SRC = "__cs-shapes";
const val = (p: Any, t: JulianDate, d?: Any) => { const v = Property.getValueOrUndefined(p, t); return v === undefined ? d : v; };
/** a time-varying plane (a CallbackProperty plane, as the clipping examples drag): what it is at t, or "" (constant, or nothing to draw) */
const movingPlane = (e: Any, t: JulianDate): string => {
	const g = e.plane;
	if (!g || (isConst(g.plane) && isConst(g.dimensions) && isConst(e.position) && Property.isConstant(e.orientation))) return "";
	const pl = val(g.plane, t), dm = val(g.dimensions, t), p = val(e.position, t), q = val(e.orientation, t);
	if (!pl?.normal || !dm || !p) return "";
	return [pl.normal.x, pl.normal.y, pl.normal.z, pl.distance, dm.x, dm.y, p.x, p.y, p.z, q?.x, q?.y, q?.z, q?.w].join();
};
// the solids whose shape is time-varying but whose place is not (a CallbackProperty radii: 3d-tiles-nga-gpm-visualization's anchor point ellipsoids):
// drawn with Cesium's geometry at the shape's current value, made again whenever that value changes (the sig)
const SHAPE_PROPS: Record<string, string[]> = { box: ["dimensions"], cylinder: ["length", "topRadius", "bottomRadius"], ellipsoid: ["radii", "innerRadii"] };
const movingShape = (e: Any, name: string, t: JulianDate): string | null => {
	const g = e[name], ps = SHAPE_PROPS[name];
	if (!g || !ps || !isConst(e.position) || !Property.isConstant(e.orientation) || ps.every(k => isConst(g[k]))) return null;
	return ps.map(k => { const v = val(g[k], t); return v == null ? "" : typeof v === "number" ? v : [v.x, v.y, v.z].join(" "); }).join();
};
/** a NearFarScalar → [near, nearValue, far, farValue] (the globe's marks scale and fade by the eye's distance as Cesium's billboards and labels) */
const nfOf = (v: Any): number[] | null => v && Number.isFinite(v.near) ? [v.near, v.nearValue, v.far, v.farValue] : null;
const isConst = (p: Any) => p == null || Property.isConstant(p);
const css = (c: Color | undefined, d = Color.WHITE) => (c ?? d).toCssColorString();
const rgbAlpha = (c: Color | undefined, d = Color.WHITE): [string, number] => { const k = c ?? d; return [Color.fromAlpha(k, 1).toCssColorString(), k.alpha]; };
/** the colour a material shows (ColorMaterialProperty, the polyline materials, stripe/grid/checker): its uniforms' color */
function materialColor(m: Any, t: JulianDate, d = Color.WHITE): Color {
	if (!m) return d;
	if (m instanceof Color) return m;
	const u = m.getValue ? m.getValue(t, {}) : null;
	const c = u?.color ?? u?.evenColor ?? (u?.image ? Color.WHITE : undefined);
	return c instanceof Color ? c : d;
}
const llOf = (p: Cartesian3): [number, number, number] | null => { const c = Ellipsoid.WGS84.cartesianToCartographic(p); return c ? [c.longitude * R2D, c.latitude * R2D, c.height] : null; };
const ecef = (lon: number, lat: number, h: number) => Cartesian3.fromDegrees(lon, lat, h);
const fontPx = (f: string | undefined): number => { const m = /([\d.]+)\s*(px|pt|em)/.exec(f || ""); if (!m) return 16; const v = +m[1]; return m[2] === "pt" ? v * 4 / 3 : m[2] === "em" ? v * 16 : v; };

/** an image source the overlay worker can fetch: absolute URL or data URI */
const imgMemo = new WeakMap<object, string>();
function imageSrc(im: Any): string | null {
	if (!im) return null;
	if (typeof im === "string") return /^(data:|blob:)/.test(im) ? im : new URL(im, location.href).href;
	if (im.url && typeof im.url === "string") return new URL(im.url, location.href).href;   // Resource
	if (typeof im === "object") {
		let s = imgMemo.get(im);
		if (s) return s;
		try {
			if (im instanceof HTMLCanvasElement) s = im.toDataURL();
			else if (im instanceof HTMLImageElement) s = im.src;
			else if (typeof ImageBitmap !== "undefined" && im instanceof ImageBitmap) { const c = document.createElement("canvas"); c.width = im.width; c.height = im.height; c.getContext("2d")!.drawImage(im, 0, 0); s = c.toDataURL(); }
		} catch { s = undefined; }
		if (s) { imgMemo.set(im, s); return s; }
	}
	return null;
}
/** the natural size of an image (loaded once, on the main thread) — the billboard's origins need it */
//   every caller while it loads is told when it has (旧＝最初の 1 件だけ＝同じ画像の他の billboard は width / height の縮尺が付かないまま・clustering 例の 64 px の施設アイコン)
const sizes = new Map<string, { w: number; h: number } | null>(), waiting = new Map<string, Array<() => void>>();
function imageSize(src: string, onLoad: () => void): { w: number; h: number } | null {
	if (sizes.get(src)) return sizes.get(src)!;
	const w = waiting.get(src);
	if (w) { w.push(onLoad); return null; }
	if (sizes.has(src)) return null;   // failed to load
	sizes.set(src, null); waiting.set(src, [onLoad]);
	const im = new Image(); im.crossOrigin = "anonymous";
	im.onload = () => { sizes.set(src, { w: im.naturalWidth, h: im.naturalHeight }); const cbs = waiting.get(src) ?? []; waiting.delete(src); for (const f of cbs) f(); };
	im.onerror = () => { waiting.delete(src); };
	im.src = src;
	return null;
}

/** ENU offsets (m) around a point → lon/lat ring */
function enuRing(center: Cartesian3, pts: Array<[number, number]>, h: number): number[][] {
	const m = FixedFrameTransforms.eastNorthUpToFixedFrame(center), out: number[][] = [];
	const c = Ellipsoid.WGS84.cartesianToCartographic(center);
	for (const [e, n] of pts) {
		const p = new Cartesian3(m[0] * e + m[4] * n + m[12], m[1] * e + m[5] * n + m[13], m[2] * e + m[6] * n + m[14]);
		const q = Ellipsoid.WGS84.cartesianToCartographic(p);
		if (q) out.push([q.longitude * R2D, q.latitude * R2D]);
	}
	if (out.length) out.push(out[0]);
	void c; void h;
	return out;
}
/** an ellipse's outline in local east/north metres: a = semi-major along east, b = semi-minor along north, then rot counter-clockwise (Cesium's
 *  EllipseGeometryLibrary: rotation 0 lays the major axis east-west; before 2026-10-31 it was north-south and every surface ellipse stood upright) */
export const ellipsePts = (a: number, b: number, rot: number, n = 64): Array<[number, number]> => {
	const out: Array<[number, number]> = [];
	for (let i = 0; i < n; i++) {
		const t = (i / n) * 2 * Math.PI, x = a * Math.cos(t), y = b * Math.sin(t);   // semi-major along east before rotation
		out.push([x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)]);
	}
	return out;
};
/** heading (deg) for the globe's model of an orientation quaternion at a point. Cesium's model +X is the glTF's front (+Z, forwardAxis Z);
 *  the globe's model at heading 0 has the glTF's +Z facing south, turning clockwise: heading = bearing of +X − 180 */
export function headingOf(q: Quaternion | undefined, at: Cartesian3): number {
	if (!q) return -90;   // no orientation: Cesium's model frame is the ENU frame (+X east)
	const m = Matrix3.fromQuaternion(q), x = new Cartesian3(m[0], m[1], m[2]);
	const enu = FixedFrameTransforms.eastNorthUpToFixedFrame(at), E = new Cartesian3(enu[0], enu[1], enu[2]), N = new Cartesian3(enu[4], enu[5], enu[6]);
	const bearing = Math.atan2(Cartesian3.dot(x, E), Cartesian3.dot(x, N)) * R2D;
	return bearing - 180;
}
/** the full attitude for the globe's model (ModelTransform.rot): the rotation in the ENU frame at the point (column-major) that turns the model
 *  placed at heading 0 (Cesium's +X south, +Z up) into the orientation. null when the model stands upright (heading alone says it all) */
export function enuRotOf(q: Quaternion | undefined, at: Cartesian3): number[] | null {
	if (!q) return null;
	const m = Matrix3.fromQuaternion(q), enu = FixedFrameTransforms.eastNorthUpToFixedFrame(at);
	const E = new Cartesian3(enu[0], enu[1], enu[2]), N = new Cartesian3(enu[4], enu[5], enu[6]), U = new Cartesian3(enu[8], enu[9], enu[10]);
	const inEnu = (j: number) => { const c = new Cartesian3(m[j * 3], m[j * 3 + 1], m[j * 3 + 2]); return [Cartesian3.dot(c, E), Cartesian3.dot(c, N), Cartesian3.dot(c, U)]; };
	const ax = inEnu(0), ay = inEnu(1), az = inEnu(2);
	if (az[2] > 1 - 1e-9) return null;   // upright: no pitch or roll
	// R·M0 = A with M0 = [X→south, Y→east, Z→up]: R's columns (the images of east, north, up) are A's Y, −X and Z
	return [...ay, -ax[0], -ax[1], -ax[2], ...az];
}
/** yaw (rad, clockwise from east) of an orientation's +X at a point: 0 without one (the ENU frame) */
const yawOf = (q: Quaternion | undefined, at: Cartesian3) => (headingOf(q, at) + 90) * D2R;
const ringOfPositions = (ps: Cartesian3[]): number[][] => {
	const r = ps.map(p => llOf(p)).filter((x): x is [number, number, number] => !!x).map(q => [q[0], q[1]]);
	if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0]);
	return r;
};
/** a PolygonHierarchy → GeoJSON polygons (outer + holes; holes' holes become polygons of their own) */
function polysOf(h: PolygonHierarchy, out: number[][][][] = []): number[][][][] {
	if (!h?.positions?.length) return out;
	const rings = [ringOfPositions(h.positions)];
	for (const hole of h.holes || []) { rings.push(ringOfPositions(hole.positions)); for (const hh of hole.holes || []) polysOf(hh, out); }
	out.push(rings);
	return out;
}
/** a corridor (centre line + width) → ring, offset in each vertex's ENU plane (mitred) */
function corridorRing(ps: Cartesian3[], width: number): number[][] {
	const ll = ps.map(p => llOf(p)).filter((x): x is [number, number, number] => !!x);
	if (ll.length < 2) return [];
	const left: number[][] = [], right: number[][] = [], w = width / 2;
	for (let i = 0; i < ll.length; i++) {
		const a = ll[Math.max(0, i - 1)], b = ll[Math.min(ll.length - 1, i + 1)], k = Math.cos(ll[i][1] * D2R);
		let dx = (b[0] - a[0]) * k, dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
		const off = (s: number) => { const e = -dy * w * s, n = dx * w * s; return [ll[i][0] + e / (111320 * k), ll[i][1] + n / 110540]; };
		left.push(off(1)); right.push(off(-1));
	}
	const ring = [...left, ...right.reverse()]; ring.push(ring[0]);
	return ring;
}

/** a polyline's material as the overlay draws it: outline = a wider line under, glow = fading wider lines, dash and arrow = the overlay's own */
function styledLines(p: number[], m: Any, t: JulianDate, col: Color, width: number): Desc["lines"] {
	const type = m?.getType?.(t), u = type ? m.getValue(t, {}) ?? {} : {};
	switch (type) {
		case "PolylineOutline": {
			const ow = u.outlineWidth ?? 1;   // the line's width takes in the outline (half of outlineWidth on each side, as the shots of Cesium show)
			return [{ p, color: css(u.outlineColor, Color.BLACK), width }, { p, color: css(col), width: Math.max(1, width - ow) }];
		}
		case "PolylineGlow": {   // Cesium fades the colour from the core (glowPower of the width) out to the edge
			const gp = Math.max(0.05, Math.min(1, u.glowPower ?? 0.25)), c = (col ?? Color.WHITE);
			return [1, 0.66, 0.4].map((k, i) => ({ p, color: css(Color.fromAlpha(c, c.alpha * [0.25, 0.45, 0.75][i])), width: Math.max(1, width * k) }))
				.concat([{ p, color: css(Color.lerp(c, Color.WHITE, 0.6, new Color())), width: Math.max(1, width * gp) }]);   // the core runs to white
		}
		case "PolylineDash": {
			const gap = u.gapColor;
			const dash = { p, color: css(col), width, dash: { len: u.dashLength ?? 16, pattern: u.dashPattern ?? 255 } };
			return gap && gap.alpha > 0 ? [{ p, color: css(gap), width }, dash] : [dash];
		}
		case "PolylineArrow": return [{ p, color: css(col), width, arrow: true }];
	}
	return [{ p, color: css(col), width }];
}

/** a ground polyline with its material → line features of the ground line layers: styledLines' lines (outline under, glow's fading widths, the
 *  core), dashes in a layer of their own per pattern (line-dasharray is in line widths and the same for a whole layer) */
function groundLineFeatures(id: string, coords: number[][], m: Any, t: JulianDate, col: Color, width: number): Any[] {
	return (styledLines([], m, t, col, width) ?? []).map((l: Any, k: number) => {
		const [lc, lo] = rgbAlpha(Color.fromCssColorString(l.color) ?? Color.WHITE), props: Any = { _id: k ? `${id}#${k}` : id, _k: "line", _lc: lc, _lo: lo, _lw: l.width };
		if (l.dash) { props._k = "dash"; props._dk = `${l.width}|${l.dash.len}|${l.dash.pattern}`; }
		return { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: props };
	});
}
/** Cesium's PolylineDash: 16 bits of the pattern along dashLength pixels, bit 0 first → line-dasharray in line widths (it starts with a dash) */
function dashArrayOf(key: string): number[] {
	const [w, len, pat] = key.split("|").map(Number), px = (len || 16) / 16 / Math.max(0.5, w || 1), runs: number[] = [];
	let on = true, n = 0;
	for (let i = 0; i < 16; i++) { const b = ((pat >> i) & 1) === 1; if (b === on) n++; else { runs.push(n * px); on = b; n = 1; } }
	runs.push(n * px);
	if (runs.length % 2) { if (runs.length > 1) { runs[0] += runs.pop()!; } else runs.push(0); }   // an odd count: the last run joins the first (same state)
	return runs;
}

/** a corridor's outline as Cesium makes it (CorridorOutlineGeometry: the corners rounded, mitered or beveled) → lon/lat ring; the simple ring if that fails */
function cesiumCorridorRing(ps: Cartesian3[], width: number, cornerType: number | undefined): number[][] {
	try {
		const g = CorridorOutlineGeometry.createGeometry(new CorridorOutlineGeometry({ positions: ps, width, cornerType, height: 0 }));
		const pv = g?.attributes?.position?.values, idx: Any = g?.indices;
		if (pv && idx?.length >= 6) {
			const next = new Map<number, number[]>();   // the segments make one loop: walk it
			for (let k = 0; k + 1 < idx.length; k += 2) for (const [a, b] of [[idx[k], idx[k + 1]], [idx[k + 1], idx[k]]]) { const l = next.get(a); if (l) l.push(b); else next.set(a, [b]); }
			const ring: number[][] = [], seen = new Set<number>();
			for (let i: number | undefined = idx[0], prev = -1; i !== undefined && !seen.has(i);) {
				seen.add(i);
				const q = llOf(new Cartesian3(pv[i * 3], pv[i * 3 + 1], pv[i * 3 + 2])); if (q) ring.push([q[0], q[1]]);
				const nb: number | undefined = (next.get(i) ?? []).find(j => j !== prev && !seen.has(j)); prev = i; i = nb;
			}
			if (ring.length > 2 && seen.size === next.size) { ring.push(ring[0]); return ring; }
		}
	} catch { /* below */ }
	return corridorRing(ps, width);
}

/** a surface rectangle's texture coordinates (Cesium's RectangleGeometryLibrary): the rectangle (degrees), its rotation and stRotation (radians) */
type RectSt = { rect: [number, number, number, number]; rot: number; str: number };

/** a ring of a rectangle (degrees) turned by `rot` (radians, counter-clockwise) about its centre in longitude/latitude, as RectangleGeometry turns it
 *  (its GeographicProjection scales longitude and latitude alike) */
export function rectRing([w, s, e, n]: [number, number, number, number], rot: number, N = 8): number[][] {
	const ring: number[][] = [];
	for (let i = 0; i <= N; i++) ring.push([w + (e - w) * i / N, s]);
	for (let i = 1; i <= N; i++) ring.push([e, s + (n - s) * i / N]);
	for (let i = 1; i <= N; i++) ring.push([e - (e - w) * i / N, n]);
	for (let i = 1; i <= N; i++) ring.push([w, n - (n - s) * i / N]);
	if (!rot) return ring;
	const cx = (w + e) / 2, cy = (s + n) / 2, c = Math.cos(rot), si = Math.sin(rot);
	return ring.map(([x, y]) => [cx + c * (x - cx) - si * (y - cy), cy + si * (x - cx) + c * (y - cy)]);
}

/** longitude/latitude (degrees) → st of a surface rectangle, as RectangleGeometryLibrary.computePosition gives it: without stRotation st runs over the
 *  turned rectangle's bounding box scaled by the rectangle's own size (a turned picture is cut off, as Cesium's is); with stRotation the st grid starts
 *  at the bounding box's north-west corner turned by rotation − stRotation (stRotation = rotation: the picture turns with the rectangle and fills it) */
export function rectStOf({ rect: [w, s, e, n], rot, str }: RectSt): (lon: number, lat: number) => [number, number] {
	const cx = (w + e) / 2, cy = (s + n) / 2, W = e - w, H = n - s;
	const turn = (a: number, x: number, y: number): [number, number] => { const c = Math.cos(a), si = Math.sin(a); return [cx + c * (x - cx) - si * (y - cy), cy + si * (x - cx) + c * (y - cy)]; };
	const corners = (a: number, x0: number, y0: number) => [turn(a, x0, y0), turn(a, x0 + W, y0), turn(a, x0, y0 - H), turn(a, x0 + W, y0 - H)];
	const bb = rot ? corners(rot, w, n) : [[w, n], [e, s]];   // the turned rectangle's bounding box
	const bw = Math.min(...bb.map(p => p[0])), bs = Math.min(...bb.map(p => p[1])), bn = Math.max(...bb.map(p => p[1]));
	if (!str) return (lon, lat) => [(lon - bw) / W, (lat - bs) / H];
	const a = rot - str, sc = corners(a, bw, bn), sw = Math.min(...sc.map(p => p[0])), ss = Math.min(...sc.map(p => p[1]));
	return (lon, lat) => {
		const [ux, uy] = turn(-rot, lon, lat);   // the point on the rectangle before it turned → its grid offset from the north-west corner
		const [sx, sy] = turn(a, bw + (ux - w), bn + (uy - n));
		return [(sx - sw) / W, (sy - ss) / H];
	};
}

/** what one entity shows at a time (JSON-comparable) */
interface Desc {
	track: { id: string; name: string | null; t: number[]; p: number[]; degree: number; style: Any; avail: number[][] | null } | null;
	shapes: Any[];
	/** shapes on the ground with a painted material (stripe, checkerboard, grid, image): an image layer over their box */
	patterns: Array<{ id: string; polys: number[][][][]; mat: MatDesc; z: number; st?: RectSt }>;
	lines: Array<{ p: number[]; color: string; width: number; dash?: { len: number; pattern: number }; arrow?: boolean }>;
	/** ground shapes and clamped polylines classifying the 3D Tiles and models (classificationType CESIUM_3D_TILE or BOTH): a classification volume in their colour
	 *  (the terrain part stays a fill / line layer); a polyline's width is its pixel width at the entity's distance, in metres */
	classify: Array<{ geom: Any; color: string; opacity: number; width?: number }>;
	model: { uri: string; scale: number; at: [number, number]; altitude: number; lift: boolean; heading: number; rot?: number[] | null; anim: boolean; tint?: ReturnType<typeof modelTintOf>; sil?: ReturnType<typeof modelSilOf>; minPx?: number; maxScale?: number | null; c?: number[] } | null;
	sphere: { c: number[]; r: number } | null;
	/** Cesium's geometry instances of the solids (fill triangles, outline lines and its width) */
	solids: { fill: Any[]; outline: Any[]; width: number; closed?: boolean } | null;
}
/** a mark's positions over time (ms, fixed-frame xyz) */
type MarkSamples = { t: number[]; p: number[]; dynamic: boolean; degree: number };
interface Rec { e: Any; desc: Desc | null; bsAsk?: { frame: number; time: JulianDate }; csSphere?: { desc: Desc; bs: BoundingSphere | null; dynamic: boolean }; key: string; dirty: boolean; dynamic: boolean; trackKey: string; samples: { t: number[]; p: number[]; degree: number } | null; icrf?: boolean; off: () => void; solids?: { d: Desc["solids"]; names: Set<string>; sig: string } }

export class EntityDisplay {
	readonly defaultDataSource = new CustomDataSource("default");
	readonly dataSources: Any;
	readonly scene: OrthoScene;
	readonly host: Host;
	#recs = new Map<Any, Rec>();
	#ov: Any = null; #layers = new Set<string>(); #models = new Map<Any, { h: Any; loading: boolean; uri: string; scale: number; dead?: boolean; tk?: string; sk?: string; env?: Float32Array | null }>();
	#lastTracks = ""; #lastLines = ""; #lastShapes = ""; #pats = new Map<string, { n: number; id: string; z: number; ready: boolean; stale: boolean }>(); #patGen = 0;
	#cls = new Map<string, Any>();   // classification volumes on the map (key = outline + colour → handle)
	#gsph = new Map<string, { center: number[]; radius: number } | null | "pending">();
	#needRedraw = false; #destroyed = false;
	#marks: Array<{ e: Any; x: number; y: number; r: number }> = [];
	#clusters = new Map<Any, ClusterState>(); #clusterSeq = 0; #clusterRecs = new Map<Any, Rec>();   // data source → its clustering now; the cluster entities' records (drawn and picked like entities)
	#solids: PrimitiveDrawer; #solidPrims = new Map<Any, { of: Desc["solids"]; ps: Any[] }>();
	/** what the scene's primitives draw through this display: 3D lines, and pickers ((x, y) → a pick result) */
	readonly extra = { lines: () => [] as Any[], pickers: [] as Array<(x: number, y: number) => Any>, sources: [] as Any[] };

	constructor(o: { scene: OrthoScene; dataSourceCollection: Any; host: Host }) {
		this.scene = o.scene; this.dataSources = o.dataSourceCollection; this.host = o.host;
		this.#solids = new PrimitiveDrawer(o.host);
	}
	get ready() { return true; }
	/** the globe's model handles of the entities (entity → ModelHandle | null while loading) */
	get orthoModels() { return new Map([...this.#models].map(([e, m]) => [e, m.h])); }
	isDestroyed() { return this.#destroyed; }
	destroy() {
		this.#destroyed = true;
		for (const r of this.#recs.values()) r.off();
		for (const m of this.#models.values()) m.h?.clear?.();
		this.#solids.destroy();
		for (const e of [...this.#tilesets.keys()]) this.#dropTileset(e);
		this.#ov?.remove?.(); this.#ov = null;
		const map = this.host.map;
		if (map) { for (const id of this.#layers) if (map.getLayer?.(id)) map.removeLayer(id); if (map.getSource?.(SRC)) map.removeSource(SRC); this.#setPatterns(map, []); this.#setClassify(map, []); }
		return undefined;
	}

	#entities(): Any[] {
		const out: Any[] = [...this.defaultDataSource.entities.values];
		for (const ds of this.extra.sources) for (const e of ds.entities.values) out.push(e);
		for (let i = 0; i < this.dataSources.length; i++) {
			const ds = this.dataSources.get(i);
			if (ds.show === false) continue;
			for (const e of ds.entities.values) out.push(e);
		}
		return out;
	}
	// ── clustering (a data source's EntityCluster: clusters.ts) ──
	/** the entities the clusters hide now; the cluster entities go to #clusterRecs. Clustered again when the view, the settings or the entities change */
	#cluster(time: JulianDate): Set<Any> {
		const hidden = new Set<Any>(), seen = new Set<Any>();
		const cam = (this.scene as Any).camera, cv = (this.scene as Any).canvas;
		const view = cam ? [cam.positionWC, cam.directionWC, cam.upWC].map((v: Any) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`).join("|") + `|${cv?.clientWidth}x${cv?.clientHeight}` : "";
		for (let i = 0; i < this.dataSources.length; i++) {
			const ds = this.dataSources.get(i), c = ds?.clustering;
			if (!c || ds.show === false || !c.enabled || !cam) continue;
			seen.add(ds);
			const ents = ds.entities.values;
			let st = this.#clusters.get(ds);
			if (!st) this.#clusters.set(ds, st = { key: "", prev: [], prevHeight: 0, hidden: new Set(), ents: [] });
			let waiting = false;
			const size = (im: Any) => { const src = imageSrc(im); if (!src) return null; const z = imageSize(src, () => {}); if (!z) waiting = true; return z; };
			const key = `${view}|${c.pixelRange}|${c.minimumClusterSize}|${c.clusterBillboards}${c.clusterLabels}${c.clusterPoints}|${ents.length}|${c.clusterEvent.numberOfListeners}`;
			if (key !== st.key) {
				runClustering(ds, ents, time, this.scene, st, size, () => ++this.#clusterSeq);
				st.key = waiting || st.ents.some((e: Any) => e.billboard && !size(val(e.billboard.image, time))) ? "" : key;   // an image still loading: its box and origin are not known yet (cluster again)
			}
			for (const e of st.hidden) hidden.add(e);
		}
		for (const ds of [...this.#clusters.keys()]) if (!seen.has(ds)) this.#clusters.delete(ds);
		// the cluster entities (kept while the same; a record each, like an entity's)
		const want = new Set<Any>();
		for (const st of this.#clusters.values()) for (const e of st.ents) want.add(e);
		for (const [e, r] of this.#clusterRecs) if (!want.has(e)) { r.off(); this.#clusterRecs.delete(e); this.#recs.delete(e); }
		for (const e of want) if (!this.#clusterRecs.has(e)) this.#clusterRecs.set(e, this.#rec(e));
		return hidden;
	}
	#rec(e: Any): Rec {
		let r = this.#recs.get(e);
		if (!r) {
			const rr: Rec = { e, desc: null, key: "", dirty: true, dynamic: false, trackKey: "", samples: null, off: () => {} };
			rr.off = e.definitionChanged.addEventListener(() => { rr.dirty = true; rr.samples = null; });
			this.#recs.set(e, rr); r = rr;
		}
		return r;
	}

	/** the CesiumWidget's per-tick update. true = everything is ready (the clock may animate) */
	// entity.tileset: the facade's tileset on the globe, one per entity (made when the uri is known, shown with the entity)
	#tilesets = new Map<Any, { uri: string; ts: Cesium3DTileset | null; failed: boolean }>();
	#placeTileset(e: Any, time: JulianDate, shown: boolean) {
		const uri = e.tileset ? val(e.tileset.uri, time) : undefined, url = uri == null ? undefined : String(uri?.url ?? uri);
		let t = this.#tilesets.get(e);
		if (t && t.uri !== url) { this.#dropTileset(e); t = undefined; }
		if (!url) return;
		if (!t) {
			const rec = { uri: url, ts: null as Cesium3DTileset | null, failed: false };
			this.#tilesets.set(e, rec);
			Cesium3DTileset.fromUrl(uri, { maximumScreenSpaceError: val(e.tileset.maximumScreenSpaceError, time, 16) }).then(ts => {
				if (this.#tilesets.get(e) !== rec) { ts.destroy(); return; }
				rec.ts = ts; (ts as Any).id = e; ts.__attach(this.host); ((this.scene as Any).__tilesets ??= []).push(ts);
			}, err => { rec.failed = true; console.warn("[csshim] entity.tileset", url, err); });
			if (e.position || e.orientation) unsupported("entity.tileset placed by position / orientation (drawn where the tileset says)");
			t = rec;
		}
		if (t.ts) t.ts.show = shown && val(e.tileset.show, time, true);
	}
	#dropTileset(e: Any) {
		const t = this.#tilesets.get(e); if (!t) return;
		this.#tilesets.delete(e);
		if (t.ts) { const list = (this.scene as Any).__tilesets ?? [], i = list.indexOf(t.ts); if (i >= 0) list.splice(i, 1); t.ts.destroy(); }
	}

	update(time: JulianDate): boolean { return timed("display", () => this.#update(time)); }   // timed＝?perf=1 の [csperf] 行（perf.ts）
	#update(time: JulianDate): boolean {
		if (this.#destroyed) return true;
		const map = this.host.map;
		const ents = this.#entities(), live = new Set(ents);
		for (const [e, r] of this.#recs) if (!live.has(e) && !this.#clusterRecs.has(e)) { r.off(); this.#recs.delete(e); }
		const hidden = this.#cluster(time);
		for (const e of this.#clusterRecs.keys()) { live.add(e); ents.push(e); }
		for (const e of [...this.#tilesets.keys()]) if (!live.has(e)) this.#dropTileset(e);
		const tracks: Any[] = [], lines: Any[] = [], shapes: Any[] = [], patterns: Desc["patterns"] = [], classes: Desc["classify"] = [], models = new Map<Any, NonNullable<Desc["model"]>>(), solids = new Map<Any, NonNullable<Desc["solids"]>>();
		for (const e of ents) {
			const r = this.#rec(e);
			if (r.dirty || r.dynamic || !r.desc) {
				if (r.dirty) r.solids = undefined;   // the definition changed: the solids are made again (a time-varying entity keeps its constant solids)
				r.dirty = false;
				try { r.desc = this.#describe(e, time, r); } catch (err) { console.warn("[csshim] entity", e.id, err); r.desc = null; }
			}
			const d = r.desc;
			if (!d) continue;
			const shown = e.isShowing && e.isAvailable(time) && !hidden.has(e);
			if (e.tileset || this.#tilesets.has(e)) this.#placeTileset(e, time, shown);
			if (d.track && shown) tracks.push(d.track);
			if (!shown) continue;
			for (const l of d.lines) lines.push(l);
			for (const s of d.shapes) shapes.push(s);
			for (const q of d.patterns) patterns.push(q);
			for (const q of d.classify) classes.push(q);
			if (d.model) models.set(e, d.model);
			if (d.solids) solids.set(e, d.solids);
		}
		this.#placeSolids(solids);
		for (const l of this.#solids.lines) lines.push(l);
		this.extra.lines().forEach((l: Any, i: number) => {
			if (!l.ground) { lines.push(l); return; }
			const c = Color.fromCssColorString(l.color) ?? Color.WHITE, coords: number[][] = [];
			for (let k = 0; k + 2 < l.p.length; k += 3) { const q = llOf(new Cartesian3(l.p[k], l.p[k + 1], l.p[k + 2])); if (q) coords.push([q[0], q[1]]); }
			const mt = l.material, mp = mt ? { getType: () => mt.type, getValue: () => mt.uniforms } : null;   // a Material as the MaterialProperty styledLines reads
			if (coords.length > 1) shapes.push(...groundLineFeatures(`cesium-ground-line:${i}`, coords, mp, time, mt?.uniforms?.color ?? c, l.width));
		});
		if (!map) return true;
		this.#ov ??= map.overlay({ builtin: "czml" }, { name: "cesium-entities" });
		const tk = tracksKey(tracks);
		if (tk !== this.#lastTracks) {
			this.#lastTracks = tk;
			this.#ov.post({ type: "tracks", tracks: tracks.map(t => ({ id: t.id, name: t.name, t: Float64Array.from(t.t), p: Float64Array.from(t.p), degree: t.degree, inertial: false, avail: t.avail, style: t.style, czml: {} })) });
		}
		const lk = JSON.stringify(lines);
		if (lk !== this.#lastLines) { this.#lastLines = lk; this.#ov.post({ type: "lines", lines: lines.map(l => ({ ...l, avail: null, show: true })) }); }
		shapes.sort((a, b) => (a.properties._z ?? 0) - (b.properties._z ?? 0));   // ground shapes in zIndex order (a stable sort: ties keep the entities' order)
		// the painted ground shapes are image layers, and those draw under the fills: a fill with a lower zIndex than a painted shape goes into the images too (in its colour)
		const zPat = patterns.length ? Math.max(...patterns.map(q => q.z)) : -Infinity;
		for (let i = shapes.length - 1; i >= 0; i--) {
			const f = shapes[i], pr = f.properties;
			if (pr._k !== "fill" || !(pr._z < zPat)) continue;
			patterns.push({ id: pr._id, polys: f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates], mat: { type: "Solid", u: { color: Color.fromCssColorString(pr._fc).withAlpha(pr._fo) } }, z: pr._z });
			shapes.splice(i, 1);
		}
		const sk = JSON.stringify(shapes);
		if (sk !== this.#lastShapes) { this.#lastShapes = sk; this.#setShapes(map, shapes); }
		this.#setPatterns(map, patterns);
		this.#setClassify(map, classes);
		this.#placeModels(map, models);
		// the globe's clock shows the Cesium clock's time (the overlay plays the tracks on it)
		const ms = JulianDate.toDate(time).getTime();
		if (map.clock && Math.abs((map.clock.time ?? 0) - ms) > 0.5) map.clock.setTime(ms);
		if (this.#needRedraw) { this.#needRedraw = false; this.#lastTracks = ""; }
		return true;
	}

	// the solids as primitives of their own (one for the fills, one for the outlines: the outline width is the primitive's line width)
	#placeSolids(solids: Map<Any, NonNullable<Desc["solids"]>>) {
		for (const [e, sp] of this.#solidPrims) if (solids.get(e) !== sp.of) { for (const p of sp.ps) this.#solids.remove(p); this.#solidPrims.delete(e); }
		for (const [e, g] of solids) {
			if (this.#solidPrims.has(e)) continue;
			const ps: Any[] = [];
			if (g.fill.length) ps.push({ geometryInstances: g.fill, appearance: { closed: !!g.closed }, modelMatrix: Matrix4.IDENTITY, show: true });
			if (g.outline.length) ps.push({ geometryInstances: g.outline, appearance: { renderState: { lineWidth: g.width } }, modelMatrix: Matrix4.IDENTITY, show: true });
			for (const p of ps) this.#solids.add(p);
			this.#solidPrims.set(e, { of: g, ps });
		}
		this.#solids.update();
	}
	/** the entity's constant solids as Cesium's geometry instances (into d.solids): the names done so (a time-varying or ground one is not: the shapes below draw it) */
	#solidsOf(e: Any, t: JulianDate, d: Desc, r: Rec): Set<string> {
		const sig = movingPlane(e, t) + "|" + Object.keys(SHAPE_PROPS).map(n => movingShape(e, n, t) ?? "").join("|");
		if (r.solids && r.solids.sig === sig) { d.solids = r.solids.d; return r.solids.names; }
		const done = new Set<string>();
		r.solids = { d: null, names: done, sig };
		for (const [name, U] of SOLIDS) {
			if (!U || !e[name]) continue;
			let u: Any;
			try { u = new U(e, this.scene); } catch { continue; }
			try {
				if (u.isDynamic && name === "plane" && sig) { u._options.plane = val(e.plane.plane, t); u._options.dimensions = val(e.plane.dimensions, t); }   // made again whenever it moves (the sig)
				else if (u.isDynamic && !u.onTerrain && movingShape(e, name, t) != null && !onGround(e[name], t)) { u._dynamic = false; u._setStaticOptions(e, e[name]); u._isClosed = u._getIsClosed?.(u._options) ?? true; }   // the shape now (made again when it changes: the sig)
				else if (u.isDynamic || u.onTerrain || onGround(e[name], t) || onSurface(name, e[name], t)) continue;
				done.add(name);
				const g = d.solids ??= r.solids.d = { fill: [], outline: [], width: 1 };
				if (u.fillEnabled) {
					const inst = u.createFillGeometryInstance(t);
					if (!inst.attributes?.color) {   // a material that is not a colour: painted (stripe, checkerboard, grid, image) or drawn in its colour
						const m = matOfProperty(u.fillMaterialProperty, t);
						if (m) inst.__mat = m;
						(inst.attributes ??= {}).color = ColorGeometryInstanceAttribute.fromColor(m ? Color.WHITE : materialColor(u.fillMaterialProperty, t));
					}
					g.fill.push(inst);
					g.closed = (g.closed ?? true) && !!u.isClosed;   // Cesium's fill appearance is closed when the updater's geometry is (back faces culled: a translucent cylinder shows one wall)
				}
				if (u.outlineEnabled) { g.outline.push(u.createOutlineGeometryInstance(t)); g.width = Math.max(g.width, u.outlineWidth ?? 1); }
			} catch (err) { done.delete(name); console.warn("[csshim] entity", name, err); }
			finally { u.destroy?.(); }
		}
		return done;
	}

	#describe(e: Any, t: JulianDate, r: Rec): Desc {
		const d: Desc = { track: null, shapes: [], patterns: [], lines: [], classify: [], model: null, sphere: null, solids: null };
		let dynamic = false;
		const dyn = (...ps: Any[]) => { for (const p of ps) if (!isConst(p)) dynamic = true; };
		const pos: Cartesian3 | undefined = e.position ? val(e.position, t) : undefined;
		const sphPts: Cartesian3[] = [];
		const ms = JulianDate.toDate(t).getTime();
		// ── marks (point, billboard, label, path) ──
		const pt = e.point, bb = e.billboard, lb = e.label, ph = e.path;
		const style: Any = {};
		if (pt && val(pt.show, t, true)) {
			dyn(pt.pixelSize, pt.color, pt.outlineColor, pt.outlineWidth, pt.show);
			const ow = val(pt.outlineWidth, t, 0);
			style.point = { size: val(pt.pixelSize, t, 1), color: css(val(pt.color, t)), outline: ow > 0 ? css(val(pt.outlineColor, t), Color.BLACK) : null, outlineWidth: ow, show: true };
		}
		if (bb && val(bb.show, t, true)) {
			dyn(bb.image, bb.scale, bb.pixelOffset, bb.show, bb.verticalOrigin, bb.horizontalOrigin, bb.width, bb.height, bb.scaleByDistance, bb.translucencyByDistance);
			const src = imageSrc(val(bb.image, t));
			if (src) {
				let scale = val(bb.scale, t, 1);
				const off: Cartesian2 = val(bb.pixelOffset, t, Cartesian2.ZERO);
				let ox = off.x, oy = off.y;
				const sz = imageSize(src, () => { r.dirty = true; });
				if (sz) {
					const w = val(bb.width, t), h = val(bb.height, t);
					if (w || h) scale *= (w ? w / sz.w : h / sz.h);
					const vo = val(bb.verticalOrigin, t, VerticalOrigin.CENTER), ho = val(bb.horizontalOrigin, t, HorizontalOrigin.CENTER);
					if (vo === VerticalOrigin.BOTTOM || vo === VerticalOrigin.BASELINE) oy -= sz.h * scale / 2; else if (vo === VerticalOrigin.TOP) oy += sz.h * scale / 2;
					if (ho === HorizontalOrigin.LEFT) ox += sz.w * scale / 2; else if (ho === HorizontalOrigin.RIGHT) ox -= sz.w * scale / 2;
				}
				style.image = { src, scale, offset: [ox, oy], show: true, sbd: nfOf(val(bb.scaleByDistance, t)), tbd: nfOf(val(bb.translucencyByDistance, t)) };
			}
		}
		if (lb && val(lb.show, t, true)) {
			dyn(lb.text, lb.font, lb.fillColor, lb.outlineColor, lb.pixelOffset, lb.scale, lb.show, lb.style, lb.horizontalOrigin, lb.verticalOrigin, lb.scaleByDistance, lb.translucencyByDistance, lb.showBackground, lb.backgroundColor, lb.backgroundPadding);
			const text = val(lb.text, t);
			if (text != null && text !== "") {
				const px = fontPx(val(lb.font, t, "30px sans-serif")) * val(lb.scale, t, 1);
				const st = val(lb.style, t, LabelStyle.FILL), off: Cartesian2 = val(lb.pixelOffset, t, Cartesian2.ZERO);
				const ho = val(lb.horizontalOrigin, t, HorizontalOrigin.CENTER), vo = val(lb.verticalOrigin, t, VerticalOrigin.BASELINE);
				const oy = off.y + (vo === VerticalOrigin.BOTTOM || vo === VerticalOrigin.BASELINE ? -px / 2 : vo === VerticalOrigin.TOP ? px / 2 : 0);
				style.label = {
					sbd: nfOf(val(lb.scaleByDistance, t)), tbd: nfOf(val(lb.translucencyByDistance, t)),
					text: String(text), px, offset: [off.x, oy], align: ho === HorizontalOrigin.LEFT ? "left" : ho === HorizontalOrigin.RIGHT ? "right" : "center", show: true,
					color: st === LabelStyle.OUTLINE ? "rgba(0,0,0,0)" : css(val(lb.fillColor, t)),
					outline: st === LabelStyle.FILL ? "rgba(0,0,0,0)" : css(val(lb.outlineColor, t), Color.BLACK),
					// showBackground: Cesium fills a box behind the text (backgroundColor, default 0.165/0.165/0.165/0.8; backgroundPadding, default 7×5 px)
					bg: val(lb.showBackground, t, false) ? css(val(lb.backgroundColor, t, new Color(0.165, 0.165, 0.165, 0.8))) : null,
					bgPad: (() => { const bp = val(lb.backgroundPadding, t); return bp ? [bp.x, bp.y] : [7, 5]; })(),
				};
			}
		}
		if (ph && val(ph.show, t, true)) {
			dyn(ph.width, ph.material, ph.leadTime, ph.trailTime, ph.relativeTo);
			// the frame the path is drawn in (Cesium's PathVisualizer): relativeTo "FIXED" / "INERTIAL" / an entity id (the VVLH frame of that entity), else the position's own frame (inertial = the orbit's ellipse)
			const rel = val(ph.relativeTo, t, null), own = e.position?.referenceFrame === ReferenceFrame.INERTIAL ? "inertial" : "fixed";
			style.path = { show: true, width: val(ph.width, t, 1), color: css(materialColor(ph.material, t)), lead: val(ph.leadTime, t, null), trail: val(ph.trailTime, t, null), resolution: val(ph.resolution, t, 60), relativeTo: rel == null || rel === "FIXED" || rel === "INERTIAL" ? null : String(rel), frame: rel === "FIXED" ? "fixed" : rel === "INERTIAL" ? "inertial" : own };
		}
		if (e.position && (style.point || style.image || style.label || style.path)) {
			const s = this.#clampMarks(e, t, r, this.#samples(e, t, r));
			if (s) {
				const avail = e.availability ? intervalsOf(e.availability) : null;
				d.track = { id: String(e.id), name: e.name ?? null, t: s.t, p: s.p, degree: s.degree, style, avail };
				if (s.dynamic) dynamic = true;
			}
			if (pos) sphPts.push(pos);
		}
		// ── model ──
		const mo = e.model;
		if (mo && pos && val(mo.show, t, true)) {
			dyn(mo.uri, mo.scale, e.orientation, mo.show);
			if (!isConst(e.position)) dynamic = true;
			const uri = val(mo.uri, t);
			const u = typeof uri === "string" ? new URL(uri, location.href).href : uri?.url ? new URL(uri.url, location.href).href : null;
			const ll = llOf(pos);
			if (u && ll) {
				// NONE = the position's own (ellipsoid) height, absolute: the globe places it without lifting onto the terrain (lift:false), so the
				// terrain arriving later cannot move it. CLAMP_TO_GROUND = on the terrain; RELATIVE_TO_GROUND = the terrain plus the height
				const href = val(mo.heightReference, t, HeightReference.NONE);
				d.model = { uri: u, scale: val(mo.scale, t, 1), at: [ll[0], ll[1]], altitude: href === HeightReference.CLAMP_TO_GROUND ? 0 : ll[2], lift: href !== HeightReference.NONE, heading: headingOf(val(e.orientation, t), pos), rot: enuRotOf(val(e.orientation, t), pos), anim: val(mo.runAnimations, t, true),
					minPx: val(mo.minimumPixelSize, t, 0), maxScale: val(mo.maximumScale, t, null), c: [pos.x, pos.y, pos.z],
					tint: modelTintOf(val(mo.color, t), val(mo.colorBlendMode, t), val(mo.colorBlendAmount, t)), sil: modelSilOf(val(mo.silhouetteColor, t), val(mo.silhouetteSize, t, 0)) };
				dyn(mo.minimumPixelSize, mo.maximumScale, mo.color, mo.colorBlendMode, mo.colorBlendAmount, mo.silhouetteColor, mo.silhouetteSize);
				sphPts.push(pos);
			}
		}
		// ── shapes ──
		const id = String(e.id);
		const addShape = (rings: number[][][] | number[][][][], o: { fill: boolean; color: Color; mat?: MatDesc | null; z?: number; outline: boolean; outlineColor: Color; outlineWidth: number; base?: number; top?: number; abs?: boolean; cls?: number; st?: RectSt }, multi = false) => {
			const geom = multi ? { type: "MultiPolygon", coordinates: rings } : { type: "Polygon", coordinates: rings };
			const polys = (multi ? rings : [rings]) as number[][][][];
			if (!polys.length || !polys[0]?.[0]?.length) return;
			const ext = o.top != null;
			// classificationType set to CESIUM_3D_TILE or BOTH on a ground shape: it also paints the 3D Tiles and models inside its outline (Cesium's
			// classification; the globe's fill only drapes the terrain). CESIUM_3D_TILE alone leaves the terrain unpainted. Unset (Cesium's default BOTH)
			// stays a plain fill: every GeoJSON polygon would otherwise become a volume
			const onTiles = o.fill && !ext && (o.cls === ClassificationType.CESIUM_3D_TILE || o.cls === ClassificationType.BOTH);
			if (onTiles) { const [cc, co] = rgbAlpha(o.color); d.classify.push({ geom: { type: "MultiPolygon", coordinates: polys }, color: cc, opacity: co }); }
			if (o.fill && o.mat && !ext) { if (o.cls !== ClassificationType.CESIUM_3D_TILE) d.patterns.push({ id, polys, mat: o.mat, z: o.z ?? 0, ...(o.st ? { st: o.st } : {}) }); }
			else if (o.fill && o.cls !== ClassificationType.CESIUM_3D_TILE) {
				const [fc, fo] = rgbAlpha(o.color);
				d.shapes.push({ type: "Feature", geometry: geom, properties: { _id: id, _k: ext ? (o.abs ? "exta" : "ext") : "fill", _fc: fc, _fo: fo, _b: o.base ?? 0, _h: o.top ?? 0, _z: o.z ?? 0 } });
			}
			if (o.outline) {
				const [lc, lo] = rgbAlpha(o.outlineColor, Color.BLACK);
				if (!ext || !o.top) {
					for (const p of polys) for (const ring of p) d.shapes.push({ type: "Feature", geometry: { type: "LineString", coordinates: ring }, properties: { _id: id, _k: "line", _lc: lc, _lo: lo, _lw: Math.max(1, o.outlineWidth) } });
				} else {
					for (const p of polys) for (const ring of p) {
						for (const hh of [o.base ?? 0, o.top]) d.lines.push({ p: ring.flatMap(([x, y]) => { const q = ecef(x, y, hh); return [q.x, q.y, q.z]; }), color: css(o.outlineColor, Color.BLACK), width: Math.max(1, o.outlineWidth) });
						for (const [x, y] of ring.slice(0, -1)) { const a = ecef(x, y, o.base ?? 0), b = ecef(x, y, o.top); d.lines.push({ p: [a.x, a.y, a.z, b.x, b.y, b.z], color: css(o.outlineColor, Color.BLACK), width: Math.max(1, o.outlineWidth) }); }
					}
				}
			}
			for (const p of polys) for (const ring of p) for (const [x, y] of ring) { sphPts.push(ecef(x, y, o.base ?? 0)); if (o.top) sphPts.push(ecef(x, y, o.top)); }
		};
		const common = (g: Any) => {
			dyn(g.material, g.fill, g.outline, g.outlineColor, g.height, g.extrudedHeight, g.show, g.classificationType);
			return { fill: val(g.fill, t, true), color: materialColor(g.material, t), mat: matOfProperty(g.material, t), z: val(g.zIndex, t, 0), outline: val(g.outline, t, false), outlineColor: val(g.outlineColor, t, Color.BLACK), outlineWidth: val(g.outlineWidth, t, 1), cls: val(g.classificationType, t, undefined) as number | undefined };
		};
		const vertical = (h: number | undefined, x: number | undefined, perPos?: number) => {
			const hh = perPos ?? h ?? 0;   // per-position heights: their mean (the globe's extrusions are flat-topped)
			if (x != null) return { base: Math.min(hh, x), top: Math.max(hh, x) };
			return Math.abs(hh) > 0.01 ? { base: hh - 0.5, top: hh + 0.5 } : {};   // a polygon in the air: a 1 m slab
		};
		// heights measured from the terrain (heightReference / extrudedHeightReference), as Cesium's GroundGeometryUpdater and TerrainOffsetProperty
		// place them: a clamped height is 0 and a clamped extrusion goes down to the lowest ground under the shape; the terrain height at the shape's
		// centre is added to the top (one of the two heights relative) or to both (both relative), so each shape keeps a flat top at its own height
		// (geometry-height-reference: 16 boxes stepping down a slope, not one sheet following the ground). The heights are absolute (the layer is
		// not lifted again); until the terrain is sampled the globe grounds each vertex instead (2026-10-31)
		const groundVertical = (g: Any, h: number | undefined, x: number | undefined, perPos: number | undefined, ring: number[][] | undefined) => {
			const v = vertical(h, x, perPos);
			const hr = h == null ? HeightReference.NONE : val(g.heightReference, t, HeightReference.NONE), xr = x == null ? HeightReference.NONE : val(g.extrudedHeightReference, t, HeightReference.NONE);
			if ((hr === HeightReference.NONE && xr === HeightReference.NONE) || perPos != null || !ring?.length) return v;
			const gh = this.#groundOf(ring, r);
			if (!gh) return v;
			return { ...groundHeights(h!, x, hr, xr, gh), abs: true };
		};
		const solid = this.#solidsOf(e, t, d, r);
		if (r.solids?.sig) dynamic = true;
		const pg = e.polygon;
		if (pg && val(pg.show, t, true) && !solid.has("polygon")) {
			dyn(pg.hierarchy, pg.perPositionHeight);
			let hi = val(pg.hierarchy, t);
			if (Array.isArray(hi)) hi = new PolygonHierarchy(hi);
			if (hi) {
				const polys = polysOf(hi), c = common(pg);
				let perPos: number | undefined;
				if (val(pg.perPositionHeight, t, false)) { const hs = hi.positions.map((p: Cartesian3) => llOf(p)?.[2] ?? 0); perPos = hs.reduce((a: number, b: number) => a + b, 0) / Math.max(1, hs.length); }
				addShape(polys, { ...c, ...groundVertical(pg, val(pg.height, t), val(pg.extrudedHeight, t), perPos, polys[0]?.[0]) }, true);
			}
		}
		const re = e.rectangle;
		if (re && val(re.show, t, true) && !solid.has("rectangle")) {
			dyn(re.coordinates, re.rotation, re.stRotation);
			const rc = val(re.coordinates, t);
			if (rc) {
				// rotation turns the surface rectangle and stRotation its picture, as Cesium's ground primitive does (rectangle: the Cesium logo turning
				// over the south-east US; it was drawn unturned before 2026-10-31)
				const rect: [number, number, number, number] = [rc.west * R2D, rc.south * R2D, rc.east * R2D, rc.north * R2D];
				const rot = +val(re.rotation, t, 0) || 0, str = +val(re.stRotation, t, 0) || 0;
				const ring = rectRing(rect, rot);
				addShape([ring], { ...common(re), ...groundVertical(re, val(re.height, t), val(re.extrudedHeight, t), undefined, ring), ...(rot || str ? { st: { rect, rot: +rot.toFixed(4), str: +str.toFixed(4) } } : {}) });
			}
		}
		const el = e.ellipse;
		if (el && pos && val(el.show, t, true) && !solid.has("ellipse")) {
			dyn(el.semiMajorAxis, el.semiMinorAxis, el.rotation); if (!isConst(e.position)) dynamic = true;
			const a = val(el.semiMajorAxis, t), b = val(el.semiMinorAxis, t);
			if (a > 0 && b > 0) { const ring = enuRing(pos, ellipsePts(a, b, val(el.rotation, t, 0)), 0); addShape([ring], { ...common(el), ...groundVertical(el, val(el.height, t), val(el.extrudedHeight, t), undefined, ring) }); }
		}
		const bx = e.box;
		if (bx && pos && val(bx.show, t, true) && !solid.has("box")) {
			dyn(bx.dimensions, e.orientation); if (!isConst(e.position)) dynamic = true;
			const dm: Cartesian3 = val(bx.dimensions, t), ll = llOf(pos);
			if (dm && ll) {
				const hd = yawOf(val(e.orientation, t), pos), cx = dm.x / 2, cy = dm.y / 2;
				const pts: Array<[number, number]> = [[-cx, -cy], [cx, -cy], [cx, cy], [-cx, cy]].map(([x, y]) => [x * Math.cos(-hd) - y * Math.sin(-hd), x * Math.sin(-hd) + y * Math.cos(-hd)]);
				addShape([enuRing(ecef(ll[0], ll[1], 0), pts, 0)], { ...common(bx), base: ll[2] - dm.z / 2, top: ll[2] + dm.z / 2 });
			}
		}
		const cy = e.cylinder;
		if (cy && pos && val(cy.show, t, true) && !solid.has("cylinder")) {
			dyn(cy.length, cy.topRadius, cy.bottomRadius); if (!isConst(e.position)) dynamic = true;
			const L = val(cy.length, t, 0), rr = Math.max(val(cy.topRadius, t, 0), val(cy.bottomRadius, t, 0)), ll = llOf(pos);
			if (L > 0 && rr > 0 && ll) addShape([enuRing(ecef(ll[0], ll[1], 0), ellipsePts(rr, rr, 0, 48), 0)], { ...common(cy), base: ll[2] - L / 2, top: ll[2] + L / 2 });
		}
		const es = e.ellipsoid;
		if (es && pos && val(es.show, t, true) && !solid.has("ellipsoid")) {
			dyn(es.radii); if (!isConst(e.position)) dynamic = true;
			const rad: Cartesian3 = val(es.radii, t), ll = llOf(pos);
			if (rad && ll) {
				const c = common(es), K = 10;   // a stack of discs
				for (let i = 0; i < K; i++) {
					const z0 = -rad.z + (2 * rad.z * i) / K, z1 = z0 + (2 * rad.z) / K, zm = (z0 + z1) / 2, k = Math.sqrt(Math.max(0, 1 - (zm / rad.z) ** 2));
					addShape([enuRing(ecef(ll[0], ll[1], 0), ellipsePts(rad.x * k, rad.y * k, 0, 40), 0)], { ...c, outline: false, base: ll[2] + z0, top: ll[2] + z1 });
				}
			}
		}
		const co = e.corridor;
		if (co && val(co.show, t, true) && !solid.has("corridor")) {
			dyn(co.positions, co.width);
			const ps = val(co.positions, t), w = val(co.width, t, 0);
			if (ps?.length > 1 && w > 0) { const ring = cesiumCorridorRing(ps, w, val(co.cornerType, t)); addShape([ring], { ...common(co), ...groundVertical(co, val(co.height, t), val(co.extrudedHeight, t), undefined, ring) }); }
		}
		const wa = e.wall;
		if (wa && val(wa.show, t, true) && !solid.has("wall")) {
			dyn(wa.positions, wa.maximumHeights, wa.minimumHeights);
			const ps: Cartesian3[] = val(wa.positions, t) || [], mx: number[] | undefined = val(wa.maximumHeights, t), mn: number[] | undefined = val(wa.minimumHeights, t), c = common(wa);
			for (let i = 0; i + 1 < ps.length; i++) {
				const a = llOf(ps[i]), b = llOf(ps[i + 1]);
				if (!a || !b) continue;
				const top = (mx ? (mx[i] + mx[i + 1]) / 2 : (a[2] + b[2]) / 2), base = mn ? (mn[i] + mn[i + 1]) / 2 : 0;
				addShape([corridorRing([ps[i], ps[i + 1]], 1)], { ...c, base, top });
			}
		}
		const pv = e.polylineVolume;
		if (pv && val(pv.show, t, true) && !solid.has("polylineVolume")) {
			dyn(pv.positions, pv.shape);
			const ps = val(pv.positions, t), sh: Cartesian2[] = val(pv.shape, t) || [];
			if (ps?.length > 1 && sh.length) {
				const xs = sh.map(p => p.x), ys = sh.map(p => p.y), w = Math.max(...xs) - Math.min(...xs), hh = llOf(ps[0])?.[2] ?? 0;
				addShape([corridorRing(ps, w)], { ...common(pv), base: hh + Math.min(...ys), top: hh + Math.max(...ys) });
			}
		}
		if (e.plane && val(e.plane.show, t, true) && !solid.has("plane")) unsupported("entity.plane (time-varying)");
		// ── polyline ──
		const pl = e.polyline;
		if (pl && val(pl.show, t, true)) {
			dyn(pl.positions, pl.width, pl.material, pl.clampToGround, pl.arcType, pl.classificationType);
			const ps: Cartesian3[] = (val(pl.positions, t) || []).filter(Boolean);
			if (ps.length > 1) {
				const col = materialColor(pl.material, t), width = val(pl.width, t, 1);
				if (val(pl.clampToGround, t, false)) {
					const [lc, lo] = rgbAlpha(col), cls = val(pl.classificationType, t, undefined) as number | undefined;
					const coords = ps.map(p => llOf(p)).filter(Boolean).map(q => [q![0], q![1]]);
					// on the 3D Tiles too (classificationType CESIUM_3D_TILE / BOTH): a band of the line's pixel width at its distance (Cesium's ground polyline keeps its pixel width)
					if (cls === ClassificationType.CESIUM_3D_TILE || cls === ClassificationType.BOTH) d.classify.push({ geom: { type: "LineString", coordinates: coords }, color: lc, opacity: lo, width: Math.max(0.5, width * this.#metresPerPixel(ps)) });
					if (cls !== ClassificationType.CESIUM_3D_TILE) d.shapes.push(...groundLineFeatures(id, coords, pl.material, t, col, width));
				} else {
					const at = val(pl.arcType, t, ArcType.GEODESIC);
					const pts = at === ArcType.NONE ? ps : at === ArcType.RHUMB ? PolylinePipeline.generateCartesianRhumbArc({ positions: ps, height: (PolylinePipeline as Any).extractHeights(ps, Ellipsoid.WGS84) }) : PolylinePipeline.generateCartesianArc({ positions: ps, height: (PolylinePipeline as Any).extractHeights(ps, Ellipsoid.WGS84) });   // the heights go along (Cesium's PolylineGeometry passes them so)
					const flat: number[] = [];
					for (let i = 0; i < pts.length; i++) { const q: Any = pts[i]; if (q instanceof Cartesian3) flat.push(q.x, q.y, q.z); else if (typeof q === "number") flat.push(q); }
					d.lines.push(...styledLines(flat, pl.material, t, col, width));
				}
				sphPts.push(...ps);
			}
		}
		if (sphPts.length) { const bs = BoundingSphere.fromPoints(sphPts); d.sphere = { c: [bs.center.x, bs.center.y, bs.center.z], r: bs.radius }; }
		r.dynamic = dynamic;
		void ms;
		return d;
	}

	/** the samples (ms, ECEF) of an entity's position: once for a time-sampled position, now for anything else */
	#samples(e: Any, t: JulianDate, r: Rec): MarkSamples | null {
		const prop = e.position;
		if (isConst(prop)) {
			const p = val(prop, t);
			return p ? { t: [-FAR, FAR], p: [p.x, p.y, p.z, p.x, p.y, p.z], dynamic: false, degree: 1 } : null;
		}
		const span = spanOf(prop);
		if (span) {
			if (!r.samples) {
				const [a, b] = span, times = new Set<number>(sampleTimes(prop));
				const n = Math.min(4000, Math.max(2, Math.ceil((b - a) / 30000)));   // every 30 s (at most 4000)
				for (let i = 0; i <= n; i++) times.add(a + (b - a) * i / n);
				const ts = [...times].filter(x => x >= a && x <= b).sort((x, y) => x - y), tt: number[] = [], pp: number[] = [];
				const jd = new JulianDate();
				for (const ms of ts) { JulianDate.fromDate(new Date(ms), jd); const p = prop.getValue(jd); if (p) { tt.push(ms); pp.push(p.x, p.y, p.z); } }
				r.samples = { t: tt, p: pp, degree: Math.max(1, Math.min(5, Math.round(+prop.interpolationDegree || 1))) };   // the overlay interpolates the 30 s samples with the property's Lagrange degree (linear = 900 m off on an orbit, degree 5 = 7 m)
				// inertial positions (CZML satellites): until the IAU 2006 XYS data has loaded, Cesium's getValue converts with the TEME approximation (~35 km off in 2023) → sample again once it is in.
				// (sampled in the fixed frame with Cesium's own transform so the marks sit where Cesium's camera tracks them; the overlay's own transform differs by ~60 m)
				if (prop.referenceFrame === ReferenceFrame.INERTIAL && !r.icrf) {
					const j0 = JulianDate.fromDate(new Date(a)), j1 = JulianDate.fromDate(new Date(b));
					if (!Transforms.computeIcrfToFixedMatrix(j0) || !Transforms.computeIcrfToFixedMatrix(j1)) {
						r.icrf = true;
						Transforms.preloadIcrfFixed(new TimeInterval({ start: j0, stop: j1 })).then(() => { if (!this.#destroyed) { r.samples = null; r.dirty = true; this.invalidate(); } }, () => {});
					}
				}
			}
			return r.samples.t.length ? { ...r.samples, dynamic: false } : null;
		}
		const p = val(prop, t);   // CallbackProperty and the like: where it is now, every frame
		if (!p) return null;
		// a path on it (callback-position-property): Cesium's PathVisualizer samples the property every `resolution` seconds from trailTime
		// before now to leadTime after (the availability's ends when one is unset), every frame
		const ph = e.path, av = e.availability;
		if (ph && val(ph.show, t, true)) {
			const lead = val(ph.leadTime, t, null), trail = val(ph.trailTime, t, null), now = JulianDate.toDate(t).getTime();
			const a = trail != null ? now - trail * 1000 : av?.start ? JulianDate.toDate(av.start).getTime() : NaN;
			const b = lead != null ? now + lead * 1000 : av?.stop ? JulianDate.toDate(av.stop).getTime() : NaN;
			if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
				const step = Math.max(val(ph.resolution, t, 60) * 1000, (b - a) / 1000), tt: number[] = [], pp: number[] = [], jd = new JulianDate();
				for (let ms = a; ; ms = Math.min(b, ms + step)) {
					const q = ms === now ? p : prop.getValue(JulianDate.fromDate(new Date(ms), jd));
					if (q) { tt.push(ms); pp.push(q.x, q.y, q.z); }
					if (ms < now && ms + step > now) { tt.push(now); pp.push(p.x, p.y, p.z); }   // now itself: the marks sit where the entity is
					if (ms >= b) break;
				}
				if (tt.length > 1) return { t: tt, p: pp, dynamic: true, degree: 1 };
			}
		}
		return { t: [-FAR, FAR], p: [p.x, p.y, p.z, p.x, p.y, p.z], dynamic: true, degree: 1 };
	}

	#setShapes(map: Any, shapes: Any[]) {
		const fc = { type: "FeatureCollection", features: shapes };
		const src = map.getSource?.(SRC);
		if (src) src.setData(fc); else map.addSource(SRC, { type: "geojson", data: fc });
		const want = new Set<string>(["__cs-fill", "__cs-line"]);
		const ops = new Set<number>();
		for (const s of shapes) if (s.properties._k === "ext") ops.add(Math.round(s.properties._fo * 10) / 10);
		for (const o of ops) want.add(`__cs-ext-${o}`);
		const opsA = new Set<number>();
		for (const s of shapes) if (s.properties._k === "exta") opsA.add(Math.round(s.properties._fo * 10) / 10);
		for (const o of opsA) want.add(`__cs-exta-${o}`);
		for (const s of shapes) if (s.properties._k === "dash") want.add(`__cs-dash-${s.properties._dk}`);
		for (const id of want) {
			if (this.#layers.has(id)) continue;
			if (id === "__cs-fill") map.addLayer({ id, type: "fill", source: SRC, filter: ["==", ["get", "_k"], "fill"], paint: { "fill-color": ["get", "_fc"], "fill-opacity": ["get", "_fo"] } });
			else if (id.startsWith("__cs-dash-")) { const k = id.slice(10); map.addLayer({ id, type: "line", source: SRC, filter: ["all", ["==", ["get", "_k"], "dash"], ["==", ["get", "_dk"], k]], paint: { "line-color": ["get", "_lc"], "line-opacity": ["get", "_lo"], "line-width": ["get", "_lw"], "line-dasharray": dashArrayOf(k) } }); }
			else if (id === "__cs-line") map.addLayer({ id, type: "line", source: SRC, filter: ["==", ["get", "_k"], "line"], paint: { "line-color": ["get", "_lc"], "line-opacity": ["get", "_lo"], "line-width": ["get", "_lw"] } });
			else if (id.startsWith("__cs-exta-")) { const o = +id.slice(10); map.addLayer({ id, type: "fill-extrusion", source: SRC, bottom: 0, lighting: "phong", filter: ["all", ["==", ["get", "_k"], "exta"], [">=", ["get", "_fo"], o - 0.05], ["<", ["get", "_fo"], o + 0.05]], paint: { "fill-extrusion-color": ["get", "_fc"], "fill-extrusion-opacity": Math.max(0.05, o), "fill-extrusion-height": ["get", "_h"], "fill-extrusion-base": ["get", "_b"] } }); }   // absolute heights (bottom 0 = a plane at sea level, not lifted onto the terrain)
			else { const o = +id.slice(9); map.addLayer({ id, type: "fill-extrusion", source: SRC, lighting: "phong", filter: ["all", ["==", ["get", "_k"], "ext"], [">=", ["get", "_fo"], o - 0.05], ["<", ["get", "_fo"], o + 0.05]], paint: { "fill-extrusion-color": ["get", "_fc"], "fill-extrusion-opacity": Math.max(0.05, o), "fill-extrusion-height": ["get", "_h"], "fill-extrusion-base": ["get", "_b"] } }); }
			this.#layers.add(id);
		}
	}

	/** metres per pixel at the points' distance (a ground polyline's pixel width as a band on the tiles); 1 without a camera, and quantised to ±25 % so a camera drift does not rebuild the volume */
	#metresPerPixel(ps: Cartesian3[]): number {
		const cam = this.scene.camera;
		if (!cam?.getPixelSize) return 1;
		const bs = BoundingSphere.fromPoints(ps), mpp = cam.getPixelSize(bs, this.scene.drawingBufferWidth, this.scene.drawingBufferHeight);
		if (!(mpp > 0) || !Number.isFinite(mpp)) return 1;
		return Math.pow(1.5, Math.round(Math.log(mpp) / Math.log(1.5)));
	}
	/** the ground shapes and lines that classify 3D Tiles and models: one classification volume each (type "tiles3d": the terrain part is the fill / line layer), kept while the geometry and colour stay */
	#setClassify(map: Any, cls: Desc["classify"]) {
		const want = new Map<string, Desc["classify"][number]>();
		for (const q of cls) want.set(JSON.stringify(q.geom) + "|" + q.color + "|" + q.opacity + "|" + (q.width ?? ""), q);
		for (const [k, h] of this.#cls) if (!want.has(k)) { try { h.remove(); } catch { /* gone with the map */ } this.#cls.delete(k); }
		if (!map.addClassification) return;
		for (const [k, q] of want) {
			if (this.#cls.has(k)) continue;
			try { this.#cls.set(k, map.addClassification(q.geom, { color: q.color, opacity: q.opacity, type: "tiles3d", ...(q.width != null ? { width: q.width } : {}) })); }
			catch (err) { console.warn("[csshim] classification", err); }
		}
	}

	/** each patterned ground shape: its material painted over its longitude/latitude box (st across the box, as Cesium's rectangles map it),
	 *  clipped to the shape, as an image layer under the outlines */
	#setPatterns(map: Any, pats: Desc["patterns"]) {
		const want = new Map<string, Desc["patterns"][number]>();
		for (const q of pats) want.set(JSON.stringify(q.polys) + matKey(q.mat) + (q.st ? JSON.stringify(q.st) : ""), q);
		const drop = (k: string, pt: { n: number }) => { const id = `__cs-pat-${pt.n}`; if (map.getLayer?.(id)) map.removeLayer(id); if (map.getSource?.(id)) map.removeSource(id); this.#pats.delete(k); };
		// a shape that changes (a turning rectangle: a new picture every frame) keeps its last picture until the next one is painted, and paints one
		// picture at a time (a paint started every frame would be dropped every frame and never show)
		const ids = new Set(pats.map(q => q.id));
		for (const [k, pt] of this.#pats) {
			if (want.has(k)) pt.stale = false;
			else if (ids.has(pt.id)) pt.stale = true;   // replaced once a newer picture of that shape is painted
			else drop(k, pt);
		}
		for (const [k, q] of want) {
			if (this.#pats.has(k)) continue;
			if ([...this.#pats.values()].some(x => x.id === q.id && !x.ready)) continue;   // that shape's previous picture is still being painted
			const n = ++this.#patGen, pt = { n, id: q.id, z: q.z, ready: false, stale: false }; this.#pats.set(k, pt);
			let w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity;
			for (const p of q.polys) for (const r of p) for (const [x, y] of r) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); nn = Math.max(nn, y); }
			if (!(e > w && nn > s)) continue;
			const k0 = Math.cos(((s + nn) / 2) * D2R), aspect = ((e - w) * k0) / (nn - s), W = Math.round(aspect >= 1 ? 1024 : Math.max(16, 1024 * aspect)), H = Math.round(aspect >= 1 ? Math.max(16, 1024 / aspect) : 1024);
			const rst = q.st ? rectStOf(q.st) : null;
			void paint(q.mat, W, H, rst ? (x, y) => rst(w + (x / W) * (e - w), nn - (y / H) * (nn - s)) : (x, y) => [x / W, 1 - y / H]).then(cv => {
				if (!cv || this.#pats.get(k) !== pt || this.#destroyed) return;
				const ctx = cv.getContext("2d")!;
				ctx.globalCompositeOperation = "destination-in"; ctx.beginPath();
				for (const p of q.polys) for (const r of p) r.forEach(([x, y], i) => { const px = ((x - w) / (e - w)) * W, py = ((nn - y) / (nn - s)) * H; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
				ctx.fill("evenodd");
				const id = `__cs-pat-${n}`;
				map.addSource(id, { type: "image", url: cv.toDataURL(), coordinates: [[w, nn], [e, nn], [e, s], [w, s]] });
				pt.ready = true;
				for (const [k2, x] of this.#pats) if (x !== pt && x.id === pt.id && x.stale) drop(k2, x);   // the pictures it replaces
				if (pt.stale) this.invalidate();   // the shape moved on while it was painted: paint the shape as it is now
				// stack the image layers in zIndex order (each paint lands in its own time: lay them all again)
				const ready = [...this.#pats.values()].filter(x => x.ready).sort((a, b) => a.z - b.z || a.n - b.n);
				for (const x of ready) if (map.getLayer?.(`__cs-pat-${x.n}`)) map.removeLayer(`__cs-pat-${x.n}`);
				for (const x of ready) map.addLayer({ id: `__cs-pat-${x.n}`, type: "raster", source: `__cs-pat-${x.n}`, paint: { "raster-fade-duration": 0 } });
			});
		}
	}

	/** a model's scale as Cesium draws it: minimumPixelSize enlarges a far model to that many pixels across (Model's scaleInPixels), maximumScale caps it */
	#modelScale(d: NonNullable<Desc["model"]>): number {
		if (!(d.minPx! > 0) || !d.c) return d.scale;
		const g = this.#gsph.get(d.uri);
		if (g === undefined) { this.#gsph.set(d.uri, "pending"); void gltfSphere(d.uri).then(v => { this.#gsph.set(d.uri, v); this.invalidate(); }); }
		if (!g || g === "pending" || !(g.radius > 0)) return d.scale;
		const r = g.radius * d.scale, bs = new BoundingSphere(new Cartesian3(d.c[0], d.c[1], d.c[2]), r);
		const mpp = this.scene.camera.getPixelSize(bs, this.scene.drawingBufferWidth, this.scene.drawingBufferHeight);
		let k = d.scale;
		if (Number.isFinite(mpp) && mpp > 0 && (2 * r) / mpp < d.minPx!) k = (d.minPx! * mpp) / (2 * g.radius);
		return d.maxScale != null ? Math.min(k, d.maxScale) : k;
	}
	#placeModels(map: Any, models: Map<Any, NonNullable<Desc["model"]>>) {
		for (const [e, m] of this.#models) if (!models.has(e)) { m.dead = true; m.h?.clear?.(); this.#models.delete(e); }
		// model animations follow the viewer's clock, as Cesium's do: they run while clock.shouldAnimate, at clock.multiplier, and freeze when the clock is paused
		const ck = this.host.clock, playing = ck ? !!ck.shouldAnimate : true, speed = ck && Number.isFinite(ck.multiplier) ? ck.multiplier : 1;
		for (const [e, d0] of models) {
			const d = { ...d0, scale: this.#modelScale(d0) };
			let m = this.#models.get(e);
			if (m && (m.uri !== d.uri)) { m.dead = true; m.h?.clear?.(); this.#models.delete(e); m = undefined; }
			if (!m) {
				const mm = { h: null as Any, loading: true, uri: d.uri, scale: d.scale, dead: false };
				this.#models.set(e, mm);
				map.gadget.model(d.uri, { at: d.at, altitude: d.altitude, lift: d.lift, ground: "origin", heading: d.heading, rot: d.rot, scale: d.scale, slot: `cesium:${e.id}`, name: String(e.name ?? e.id), fit: false, gizmo: false })
					.then((h: Any) => { mm.loading = false; if (mm.dead) { h.clear(); return; } mm.h = h; this.#syncAnim(h, d.anim); this.invalidate(); }, (err: unknown) => { mm.loading = false; console.warn("[csshim] model", d.uri, err); });
				continue;
			}
			if (m.h) { m.h.setTransform({ at: d.at, altitude: d.altitude, heading: d.heading, rot: d.rot ?? null, scale: d.scale }); this.#syncAnim(m.h, d.anim); const tk = JSON.stringify(d.tint ?? null); if (m.tk !== tk) { m.tk = tk; m.h.setColor?.(d.tint ?? null); }
				const sk = JSON.stringify(d.sil ?? null); if (m.sk !== sk) { m.sk = sk; m.h.setSilhouette?.(d.sil ?? null); }
				const env = d.c ? modelEnvSH(this.scene, d.c) : null; if (m.env !== env) { m.env = env; m.h.setEnvironment?.(env); } }   // Cesium lights each model by the environment around its own position   // the model's scale (absolute: the globe keeps the scale it loaded with as the base)
		}
	}
	/** a model's animation ⇄ the clock: play (keeping its time) while the clock animates and the entity runs animations, stop otherwise */
	#syncAnim(h: Any, run: boolean) {
		if (!h.animations?.length) return;
		const ck = this.host.clock, playing = run && (ck ? !!ck.shouldAnimate : true), speed = ck && Number.isFinite(ck.multiplier) ? ck.multiplier : 1;
		const cur = h.getAnimation?.();
		if (!playing) { if (cur?.playing) h.stop(); return; }
		if (!cur?.playing || cur.speed !== speed) h.play({ ...(cur || {}), speed });
	}

	/** the CesiumWidget asks for an entity's bounding sphere (zoomTo, flyTo, trackedEntity) */
	getBoundingSphere(entity: Any, _allowPartial: boolean, result: BoundingSphere): number {
		const tsr = this.#tilesets.get(entity);
		if (tsr) {   // Cesium frames an entity's tileset by the tileset's own sphere
			if (tsr.failed) return BoundingSphereState.FAILED;
			if (!tsr.ts?.boundingSphere) return BoundingSphereState.PENDING;
			BoundingSphere.clone(tsr.ts.boundingSphere, result); return BoundingSphereState.DONE;
		}
		const r = this.#recs.get(entity);
		if (!r || !r.desc) {
			if (!this.#recs.has(entity)) {   // not drawn yet: wait for the next update, as Cesium's visualizers do (entities of no collection fail)
				if (entity.entityCollection) return BoundingSphereState.PENDING;
				const pos = entity.position ? val(entity.position, this.scene.frameState.time ?? JulianDate.now()) : undefined;
				if (pos) { BoundingSphere.clone(new BoundingSphere(pos, 0), result); return BoundingSphereState.DONE; }
			}
			return r && r.dirty ? BoundingSphereState.PENDING : BoundingSphereState.FAILED;
		}
		let s = r.desc.sphere;
		const t = this.scene.frameState.time ?? JulianDate.now();
		if (r.desc.model) {   // Cesium frames a model by the glTF's own bounding sphere (gltf.ts)
			const uri = r.desc.model.uri, g = this.#gsph.get(uri);
			if (g === undefined) { this.#gsph.set(uri, "pending"); void gltfSphere(uri).then(v => this.#gsph.set(uri, v)); return BoundingSphereState.PENDING; }
			if (g === "pending") return BoundingSphereState.PENDING;
			if (!g && gltfFailed(uri)) return BoundingSphereState.FAILED;   // the glTF did not load: Cesium's ModelVisualizer answers FAILED (trackedEntity then takes EntityView's default offset)
			const pos = val(entity.position, t);
			if (g && pos) {
				const k = r.desc.model.scale, q = val(entity.orientation, t);
				const R = q ? Matrix3.fromQuaternion(q) : Matrix4.getMatrix3(FixedFrameTransforms.eastNorthUpToFixedFrame(pos), new Matrix3());
				const c = Matrix3.multiplyByVector(R, new Cartesian3(g.center[0] * k, g.center[1] * k, g.center[2] * k), new Cartesian3());
				result.center = Cartesian3.add(pos, c, new Cartesian3()); result.radius = g.radius * k;
				return BoundingSphereState.DONE;
			}
		}
		if (!r.desc.model) {   // geometry: measured as Cesium does (spheres.ts), once per description; a mark's position (now) joins it
			// Cesium builds a geometry's primitive over the next frames and answers PENDING until then: a zoomTo right after the load frames what the
			// example set in its load's .then too, measured at the time of the first ask (czml-custom-properties: a time-varying extrudedHeight;
			// framed flat before = 27 km low, framed at the time two slow frames later = the next interval's height, 15 km high)
			const fn = this.scene.frameState.frameNumber;
			const ask = r.bsAsk ??= { frame: fn, time: JulianDate.clone(t) };
			if (fn - ask.frame < 2) return BoundingSphereState.PENDING;
			if (r.csSphere?.desc !== r.desc || r.csSphere.dynamic) {
				let cs: ReturnType<typeof cesiumSphereOf> = null;
				try { cs = cesiumSphereOf(entity, this.scene, r.csSphere ? t : ask.time); } catch { cs = null; }
				if (cs === "pending") return BoundingSphereState.PENDING;
				r.csSphere = { desc: r.desc, bs: cs?.bs ?? null, dynamic: !!cs?.dynamic };
			}
			if (r.csSphere.bs) {
				BoundingSphere.clone(r.csSphere.bs, result);
				const mark = (entity.point || entity.billboard || entity.label) && val(entity.position, t);
				if (mark) { const m = new BoundingSphere(Cartesian3.clone(mark), 0); this.#clampMark(entity, m, t); BoundingSphere.union(result, m, result); }
				return BoundingSphereState.DONE;
			}
		}
		if (!s) return BoundingSphereState.FAILED;
		result.center = new Cartesian3(s.c[0], s.c[1], s.c[2]); result.radius = s.r;
		// a moving entity: the sphere is where it is now
		if (entity.position && !isConst(entity.position)) { const p = val(entity.position, t); if (p) Cartesian3.clone(p, result.center); }
		if (result.radius === 0) this.#clampMark(entity, result, t);
		return BoundingSphereState.DONE;
	}
	/** a still mark with heightReference CLAMP_* / RELATIVE_* (point, billboard or label): Cesium draws it on the ground under it (plus its height
	 *  for RELATIVE_*); the globe's overlay draws the position as given, so a clamped point at 0 m sat 2.5 km under Mount St. Helens and out of
	 *  the tracked view (clamp-entities-to-ground). The terrain comes from the same sampled memo as the ground shapes; until it is in, as given */
	#clampMarks(e: Any, t: JulianDate, r: Rec, s: MarkSamples | null): MarkSamples | null {
		if (!s || s.dynamic || s.p.length < 3) return s;
		const g = e.point ?? e.billboard ?? e.label, href = g ? val(g.heightReference, t, HeightReference.NONE) : HeightReference.NONE;
		if (href === HeightReference.NONE) return s;
		const c = Cartographic.fromCartesian(new Cartesian3(s.p[0], s.p[1], s.p[2]));
		if (!c) return s;
		const gh = this.#groundOf([[c.longitude * R2D, c.latitude * R2D]], r);
		if (!gh) return s;
		const q = Cartesian3.fromRadians(c.longitude, c.latitude, gh.off + (isRelative(href) ? c.height : 0));
		return { ...s, p: s.p.map((_v: number, i: number) => [q.x, q.y, q.z][i % 3]) };
	}
	/** a mark on the ground: Cesium frames its clamped position (the terrain height, plus the height for RELATIVE_*) */
	#clampMark(entity: Any, s: BoundingSphere, t: Any) {
		const g = entity.billboard ?? entity.point ?? entity.label, href = g ? val(g.heightReference, t, HeightReference.NONE) : HeightReference.NONE;
		if (href === HeightReference.NONE) return;
		const c = Cartographic.fromCartesian(s.center), th = c && this.host.map?.queryTerrainElevation?.(c.longitude * 180 / Math.PI, c.latitude * 180 / Math.PI);
		if (c && Number.isFinite(th)) s.center = Cartesian3.fromRadians(c.longitude, c.latitude, th + (href % 2 === 0 ? c.height : 0));
	}

	// ── picking: marks (projected now), models, then ground shapes under the point ──
	#candidates(x: number, y: number): Any[] {
		const t = this.scene.frameState.time ?? JulianDate.now(), out: Array<{ e: Any; d: number }> = [];
		const map = this.host.map;
		for (const [e, r] of this.#recs) {
			const d = r.desc;
			if (!d || !e.isShowing || !e.isAvailable(t) || this.#isClustered(e)) continue;
			if (d.track || d.model) {
				const p = val(e.position, t);
				const w = p && SceneTransforms.worldToWindowCoordinates(this.scene as never, p);
				if (w) {
					const st = d.track?.style || {}, rad = Math.max(6, (st.point?.size ?? 0) / 2 + 2, st.image ? 16 * (st.image.scale || 1) : 0, d.model ? 24 : 0);
					const dd = Math.hypot(w.x - x, w.y - y);
					if (dd <= rad) { out.push({ e, d: dd }); continue; }
				}
			}
			if (d.shapes.length && map) {
				const ll = map.unproject([x, y]);
				if (ll && d.shapes.some((s: Any) => s.properties._k !== "line" && inShape(s.geometry, ll.lng, ll.lat))) out.push({ e, d: 1e6 });
			}
		}
		return out.sort((a, b) => a.d - b.d).map(c => c.e);
	}
	#isClustered(e: Any) { for (const st of this.#clusters.values()) if (st.hidden.has(e)) return true; return false; }
	pick(x: number, y: number): Any {
		const e = this.#candidates(x, y)[0];
		if (e) return e.__csPick?.() ?? { id: e, primitive: { id: e }, collection: undefined };
		const sp = this.#solids.pick(x, y);
		if (sp?.id) return sp.id.__csPick?.() ?? { id: sp.id, primitive: { id: sp.id }, collection: undefined };
		for (const f of this.extra.pickers) { const r = f(x, y); if (r) return r; }
		for (const ts of (this.scene as Any).__tilesets ?? []) { const f = ts.__pick?.(x, y); if (f) return f; }
		return undefined;
	}
	drillPick(x: number, y: number, limit?: number): Any[] {
		const out: Any[] = this.#candidates(x, y).map(e => e.__csPick?.() ?? { id: e, primitive: { id: e } });
		for (const f of this.extra.pickers) { const r = f(x, y); if (r) out.push(r); }
		for (const ts of (this.scene as Any).__tilesets ?? []) { const f = ts.__pick?.(x, y); if (f) out.push(f); }
		return limit ? out.slice(0, limit) : out;
	}
	/** forget what was sent (the overlay or the layers were lost) */
	// the terrain under a shape: its height at the centre of the outline (Cesium's TerrainOffsetProperty) and the lowest of the outline's points,
	// from map.sampleTerrain into a memo (shared by the shapes, dropped when the terrain changes); null while a point is still being sampled
	#gh = new Map<string, number>(); #ghWant = new Set<string>(); #ghWaiting = new Set<Rec>(); #ghTerr: Any = null;
	#groundOf(ring: number[][], r: Rec): { off: number; min: number } | null {
		const map = this.host.map, terr = map?.getTerrain?.()?.source ?? null;
		if (!terr || typeof map.sampleTerrain !== "function") return null;
		if (terr !== this.#ghTerr) { this.#ghTerr = terr; this.#gh.clear(); this.#ghWant.clear(); }
		const n = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.length - 1 : ring.length;
		const step = Math.max(1, Math.ceil(n / 64));
		let cx = 0, cy = 0;
		for (let i = 0; i < n; i++) { cx += ring[i][0]; cy += ring[i][1]; }
		const pts: [number, number][] = [[cx / n, cy / n]];
		for (let i = 0; i < n; i += step) pts.push([ring[i][0], ring[i][1]]);
		const key = (p: [number, number]) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
		const hs: number[] = [], miss: [number, number][] = [];
		for (const p of pts) { const v = this.#gh.get(key(p)); if (v === undefined) { if (!this.#ghWant.has(key(p))) miss.push(p); } else hs.push(v); }
		if (hs.length === pts.length) return { off: hs[0], min: Math.min(...hs) };
		this.#ghWaiting.add(r);
		if (miss.length) {
			for (const p of miss) this.#ghWant.add(key(p));
			const gen = terr;
			Promise.resolve(map.sampleTerrain(miss)).then((rs: Array<{ height: number }>) => {
				if (this.#destroyed || gen !== this.#ghTerr) return;
				miss.forEach((p, i) => { const h = rs?.[i]?.height; this.#gh.set(key(p), Number.isFinite(h) ? h : 0); this.#ghWant.delete(key(p)); });
				for (const w of this.#ghWaiting) w.dirty = true;
				this.#ghWaiting.clear(); this.invalidate();
			}, () => { for (const p of miss) this.#ghWant.delete(key(p)); });
		}
		return null;
	}
	invalidate() { this.#lastTracks = this.#lastLines = this.#lastShapes = ""; this.#needRedraw = true; }
}

function inRing(r: number[][], x: number, y: number): boolean {
	let c = false;
	for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
	return c;
}
function inShape(g: Any, x: number, y: number): boolean {
	const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
	return polys.some((p: number[][][]) => inRing(p[0], x, y) && !p.slice(1).some(h => inRing(h, x, y)));
}
const tracksKey = (tracks: Any[]) => JSON.stringify(tracks.map(t => [t.id, t.t.length, t.t[0], t.t[t.t.length - 1], t.p[0], t.p[1], t.p[2], t.p[t.p.length - 1], t.degree, t.style, t.avail]));
function intervalsOf(c: Any): number[][] | null {
	const out: number[][] = [];
	for (let i = 0; i < c.length; i++) {
		const iv = c.get(i);
		out.push([toMs(iv.start, -FAR), toMs(iv.stop, FAR)]);
	}
	return out.length ? out : null;
}
const toMs = (j: JulianDate, d: number) => { try { const v = JulianDate.toDate(j).getTime(); return Number.isFinite(v) ? v : d; } catch { return d; } };
/** the time span a time-varying position covers (ms), when it can tell */
function spanOf(p: Any): [number, number] | null {
	const s = p?._property ?? p;   // SampledPositionProperty keeps a SampledProperty
	const times: JulianDate[] | undefined = s?._times;
	if (times?.length) return [toMs(times[0], 0), toMs(times[times.length - 1], 0)];
	const iv = p?._intervals ?? p?.intervals ?? p?._composite?._intervals;
	if (iv?.length) {
		let a = Infinity, b = -Infinity;
		for (let i = 0; i < iv.length; i++) { const x = iv.get(i); const sa = toMs(x.start, -FAR), sb = toMs(x.stop, FAR); if (sa > -FAR) a = Math.min(a, sa); if (sb < FAR) b = Math.max(b, sb); }
		if (Number.isFinite(a) && Number.isFinite(b) && b > a) return [a, b];
	}
	return null;
}
function sampleTimes(p: Any): number[] {
	const times: JulianDate[] | undefined = (p?._property ?? p)?._times;
	return times ? times.map(j => toMs(j, 0)) : [];
}
export { Cartographic, CMath };
