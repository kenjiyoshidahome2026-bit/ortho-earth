// The DataSourceDisplay of the facade: the engine's Entity objects (from entities.add, CzmlDataSource, GeoJsonDataSource, KmlDataSource…)
// evaluated at the clock's time and handed to the globe's drawing:
//   point / billboard / label / path → the czml overlay's tracks (time-sampled positions play on the globe's clock)
//   polyline → a 3D line (the overlay) or, clamped to ground, a GeoJSON line layer
//   box / cylinder / ellipsoid (constant, not on terrain) → Cesium's own geometry (the graphic's updater makes the fill and outline instances) drawn as a primitive is
//   polygon / rectangle / ellipse / corridor / wall / polylineVolume (and the time-varying solids) → GeoJSON fill, line and fill-extrusion layers
//   model → map.gadget.model (heading only: the globe's models do not pitch or roll)
// It also answers what the CesiumWidget asks of a display: update(time), getBoundingSphere(entity) for zoomTo / flyTo / trackedEntity,
// and picking (what is under a screen point).
import { BoundingSphere, Cartesian2, Cartesian3, Cartographic, Color, Ellipsoid, FixedFrameTransforms, JulianDate, Math as CMath, PolygonHierarchy, PolylinePipeline, Quaternion, Matrix3, Matrix4, ArcType } from "@cesium/core";
import * as engine from "@cesium/engine";
import { CustomDataSource, HorizontalOrigin, LabelStyle, SceneTransforms, VerticalOrigin, HeightReference } from "@cesium/engine";
import { unsupported } from "./report.ts";
import { cesiumSphereOf } from "./spheres.ts";
import { gltfSphere } from "./gltf.ts";
import { Cesium3DTileset } from "./tileset.ts";
import { PrimitiveDrawer } from "./primitives.ts";
import type { Host, OrthoScene } from "./scene.ts";

type Any = any;
const { BoundingSphereState, Property, ColorGeometryInstanceAttribute } = engine as Any;   // runtime exports the d.ts leaves out (and Property's static helpers)
// the solids drawn with Cesium's own geometry: [graphic, its updater]
const SOLIDS: [string, Any][] = [["box", (engine as Any).BoxGeometryUpdater], ["cylinder", (engine as Any).CylinderGeometryUpdater], ["ellipsoid", (engine as Any).EllipsoidGeometryUpdater]];
const R2D = 180 / Math.PI, D2R = Math.PI / 180, FAR = 8.64e15;
const SRC = "__cs-shapes";
const val = (p: Any, t: JulianDate, d?: Any) => { const v = Property.getValueOrUndefined(p, t); return v === undefined ? d : v; };
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
const sizes = new Map<string, { w: number; h: number } | null>();
function imageSize(src: string, onLoad: () => void): { w: number; h: number } | null {
	if (sizes.has(src)) return sizes.get(src)!;
	sizes.set(src, null);
	const im = new Image(); im.crossOrigin = "anonymous";
	im.onload = () => { sizes.set(src, { w: im.naturalWidth, h: im.naturalHeight }); onLoad(); };
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
const ellipsePts = (a: number, b: number, rot: number, n = 64): Array<[number, number]> => {
	const out: Array<[number, number]> = [];
	for (let i = 0; i < n; i++) {
		const t = (i / n) * 2 * Math.PI, x = b * Math.cos(t), y = a * Math.sin(t);   // semi-major along north before rotation
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

/** what one entity shows at a time (JSON-comparable) */
interface Desc {
	track: { id: string; name: string | null; t: number[]; p: number[]; style: Any; avail: number[][] | null } | null;
	shapes: Any[];
	lines: Array<{ p: number[]; color: string; width: number }>;
	model: { uri: string; scale: number; at: [number, number]; altitude: number; heading: number; anim: boolean } | null;
	sphere: { c: number[]; r: number } | null;
	/** Cesium's geometry instances of the solids (fill triangles, outline lines and its width) */
	solids: { fill: Any[]; outline: Any[]; width: number } | null;
}
interface Rec { e: Any; desc: Desc | null; csSphere?: { desc: Desc; bs: BoundingSphere | null; dynamic: boolean }; key: string; dirty: boolean; dynamic: boolean; trackKey: string; samples: { t: number[]; p: number[] } | null; off: () => void; solids?: { d: Desc["solids"]; names: Set<string> } }

export class EntityDisplay {
	readonly defaultDataSource = new CustomDataSource("default");
	readonly dataSources: Any;
	readonly scene: OrthoScene;
	readonly host: Host;
	#recs = new Map<Any, Rec>();
	#ov: Any = null; #layers = new Set<string>(); #models = new Map<Any, { h: Any; loading: boolean; uri: string; scale: number; dead?: boolean }>();
	#lastTracks = ""; #lastLines = ""; #lastShapes = "";
	#gsph = new Map<string, { center: number[]; radius: number } | null | "pending">();
	#needRedraw = false; #destroyed = false;
	#marks: Array<{ e: Any; x: number; y: number; r: number }> = [];
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
		if (map) { for (const id of this.#layers) if (map.getLayer?.(id)) map.removeLayer(id); if (map.getSource?.(SRC)) map.removeSource(SRC); }
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

	update(time: JulianDate): boolean {
		if (this.#destroyed) return true;
		const map = this.host.map;
		const ents = this.#entities(), live = new Set(ents);
		for (const [e, r] of this.#recs) if (!live.has(e)) { r.off(); this.#recs.delete(e); }
		for (const e of [...this.#tilesets.keys()]) if (!live.has(e)) this.#dropTileset(e);
		const tracks: Any[] = [], lines: Any[] = [], shapes: Any[] = [], models = new Map<Any, NonNullable<Desc["model"]>>(), solids = new Map<Any, NonNullable<Desc["solids"]>>();
		for (const e of ents) {
			const r = this.#rec(e);
			if (r.dirty || r.dynamic || !r.desc) {
				if (r.dirty) r.solids = undefined;   // the definition changed: the solids are made again (a time-varying entity keeps its constant solids)
				r.dirty = false;
				try { r.desc = this.#describe(e, time, r); } catch (err) { console.warn("[csshim] entity", e.id, err); r.desc = null; }
			}
			const d = r.desc;
			if (!d) continue;
			const shown = e.isShowing && e.isAvailable(time);
			if (e.tileset || this.#tilesets.has(e)) this.#placeTileset(e, time, shown);
			if (d.track && shown) tracks.push(d.track);
			if (!shown) continue;
			for (const l of d.lines) lines.push(l);
			for (const s of d.shapes) shapes.push(s);
			if (d.model) models.set(e, d.model);
			if (d.solids) solids.set(e, d.solids);
		}
		this.#placeSolids(solids);
		for (const l of this.#solids.lines) lines.push(l);
		for (const l of this.extra.lines()) lines.push(l);
		if (!map) return true;
		this.#ov ??= map.overlay({ builtin: "czml" }, { name: "cesium-entities" });
		const tk = tracksKey(tracks);
		if (tk !== this.#lastTracks) {
			this.#lastTracks = tk;
			this.#ov.post({ type: "tracks", tracks: tracks.map(t => ({ id: t.id, name: t.name, t: Float64Array.from(t.t), p: Float64Array.from(t.p), degree: 1, inertial: false, avail: t.avail, style: t.style, czml: {} })) });
		}
		const lk = JSON.stringify(lines);
		if (lk !== this.#lastLines) { this.#lastLines = lk; this.#ov.post({ type: "lines", lines: lines.map(l => ({ ...l, avail: null, show: true })) }); }
		const sk = JSON.stringify(shapes);
		if (sk !== this.#lastShapes) { this.#lastShapes = sk; this.#setShapes(map, shapes); }
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
			if (g.fill.length) ps.push({ geometryInstances: g.fill, appearance: {}, modelMatrix: Matrix4.IDENTITY, show: true });
			if (g.outline.length) ps.push({ geometryInstances: g.outline, appearance: { renderState: { lineWidth: g.width } }, modelMatrix: Matrix4.IDENTITY, show: true });
			for (const p of ps) this.#solids.add(p);
			this.#solidPrims.set(e, { of: g, ps });
		}
		this.#solids.update();
	}
	/** the entity's constant solids as Cesium's geometry instances (into d.solids): the names done so (a time-varying or ground one is not: the shapes below draw it) */
	#solidsOf(e: Any, t: JulianDate, d: Desc, r: Rec): Set<string> {
		if (r.solids) { d.solids = r.solids.d; return r.solids.names; }
		const done = new Set<string>();
		r.solids = { d: null, names: done };
		for (const [name, U] of SOLIDS) {
			if (!U || !e[name]) continue;
			let u: Any;
			try { u = new U(e, this.scene); } catch { continue; }
			try {
				if (u.isDynamic || u.onTerrain) continue;
				done.add(name);
				const g = d.solids ??= r.solids.d = { fill: [], outline: [], width: 1 };
				if (u.fillEnabled) {
					const inst = u.createFillGeometryInstance(t);
					if (!inst.attributes?.color) (inst.attributes ??= {}).color = ColorGeometryInstanceAttribute.fromColor(materialColor(u.fillMaterialProperty, t));   // a material that is not a colour: drawn in its colour
					g.fill.push(inst);
				}
				if (u.outlineEnabled) { g.outline.push(u.createOutlineGeometryInstance(t)); g.width = Math.max(g.width, u.outlineWidth ?? 1); }
			} catch (err) { done.delete(name); console.warn("[csshim] entity", name, err); }
			finally { u.destroy?.(); }
		}
		return done;
	}

	#describe(e: Any, t: JulianDate, r: Rec): Desc {
		const d: Desc = { track: null, shapes: [], lines: [], model: null, sphere: null, solids: null };
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
			dyn(bb.image, bb.scale, bb.pixelOffset, bb.show, bb.verticalOrigin, bb.horizontalOrigin, bb.width, bb.height);
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
				style.image = { src, scale, offset: [ox, oy], show: true };
			}
		}
		if (lb && val(lb.show, t, true)) {
			dyn(lb.text, lb.font, lb.fillColor, lb.outlineColor, lb.pixelOffset, lb.scale, lb.show, lb.style, lb.horizontalOrigin, lb.verticalOrigin);
			const text = val(lb.text, t);
			if (text != null && text !== "") {
				const px = fontPx(val(lb.font, t, "30px sans-serif")) * val(lb.scale, t, 1);
				const st = val(lb.style, t, LabelStyle.FILL), off: Cartesian2 = val(lb.pixelOffset, t, Cartesian2.ZERO);
				const ho = val(lb.horizontalOrigin, t, HorizontalOrigin.CENTER), vo = val(lb.verticalOrigin, t, VerticalOrigin.BASELINE);
				const oy = off.y + (vo === VerticalOrigin.BOTTOM || vo === VerticalOrigin.BASELINE ? -px / 2 : vo === VerticalOrigin.TOP ? px / 2 : 0);
				style.label = {
					text: String(text), px, offset: [off.x, oy], align: ho === HorizontalOrigin.LEFT ? "left" : ho === HorizontalOrigin.RIGHT ? "right" : "center", show: true,
					color: st === LabelStyle.OUTLINE ? "rgba(0,0,0,0)" : css(val(lb.fillColor, t)),
					outline: st === LabelStyle.FILL ? "rgba(0,0,0,0)" : css(val(lb.outlineColor, t), Color.BLACK),
				};
			}
		}
		if (ph && val(ph.show, t, true)) {
			dyn(ph.width, ph.material, ph.leadTime, ph.trailTime);
			style.path = { show: true, width: val(ph.width, t, 1), color: css(materialColor(ph.material, t)), lead: val(ph.leadTime, t, null), trail: val(ph.trailTime, t, null), resolution: val(ph.resolution, t, 60) };
		}
		if (e.position && (style.point || style.image || style.label || style.path)) {
			const s = this.#samples(e, t, r);
			if (s) {
				const avail = e.availability ? intervalsOf(e.availability) : null;
				d.track = { id: String(e.id), name: e.name ?? null, t: s.t, p: s.p, style, avail };
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
				const href = val(mo.heightReference, t, HeightReference.NONE);
				const ground = href === HeightReference.NONE ? (this.host.map?.queryTerrainElevation?.(ll[0], ll[1]) ?? 0) : 0;
				d.model = { uri: u, scale: val(mo.scale, t, 1), at: [ll[0], ll[1]], altitude: href === HeightReference.CLAMP_TO_GROUND ? 0 : ll[2] - (Number.isFinite(ground) ? ground : 0), heading: headingOf(val(e.orientation, t), pos), anim: val(mo.runAnimations, t, true) };
				sphPts.push(pos);
			}
		}
		// ── shapes ──
		const id = String(e.id);
		const addShape = (rings: number[][][] | number[][][][], o: { fill: boolean; color: Color; outline: boolean; outlineColor: Color; outlineWidth: number; base?: number; top?: number }, multi = false) => {
			const geom = multi ? { type: "MultiPolygon", coordinates: rings } : { type: "Polygon", coordinates: rings };
			const polys = (multi ? rings : [rings]) as number[][][][];
			if (!polys.length || !polys[0]?.[0]?.length) return;
			const ext = o.top != null;
			if (o.fill) {
				const [fc, fo] = rgbAlpha(o.color);
				d.shapes.push({ type: "Feature", geometry: geom, properties: { _id: id, _k: ext ? "ext" : "fill", _fc: fc, _fo: fo, _b: o.base ?? 0, _h: o.top ?? 0 } });
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
			dyn(g.material, g.fill, g.outline, g.outlineColor, g.height, g.extrudedHeight, g.show);
			return { fill: val(g.fill, t, true), color: materialColor(g.material, t), outline: val(g.outline, t, false), outlineColor: val(g.outlineColor, t, Color.BLACK), outlineWidth: val(g.outlineWidth, t, 1) };
		};
		const vertical = (h: number | undefined, x: number | undefined, perPos?: number) => {
			const hh = perPos ?? h ?? 0;   // per-position heights: their mean (the globe's extrusions are flat-topped)
			if (x != null) return { base: Math.min(hh, x), top: Math.max(hh, x) };
			return Math.abs(hh) > 0.01 ? { base: hh - 0.5, top: hh + 0.5 } : {};   // a polygon in the air: a 1 m slab
		};
		const pg = e.polygon;
		if (pg && val(pg.show, t, true)) {
			dyn(pg.hierarchy, pg.perPositionHeight);
			let hi = val(pg.hierarchy, t);
			if (Array.isArray(hi)) hi = new PolygonHierarchy(hi);
			if (hi) {
				const polys = polysOf(hi), c = common(pg);
				let perPos: number | undefined;
				if (val(pg.perPositionHeight, t, false)) { const hs = hi.positions.map((p: Cartesian3) => llOf(p)?.[2] ?? 0); perPos = hs.reduce((a: number, b: number) => a + b, 0) / Math.max(1, hs.length); }
				addShape(polys, { ...c, ...vertical(val(pg.height, t), val(pg.extrudedHeight, t), perPos) }, true);
			}
		}
		const re = e.rectangle;
		if (re && val(re.show, t, true)) {
			dyn(re.coordinates, re.rotation);
			const rc = val(re.coordinates, t);
			if (rc) {
				const w = rc.west * R2D, s = rc.south * R2D, ea = rc.east * R2D, n = rc.north * R2D, ring: number[][] = [];
				const N = 8;
				for (let i = 0; i <= N; i++) ring.push([w + (ea - w) * i / N, s]);
				for (let i = 1; i <= N; i++) ring.push([ea, s + (n - s) * i / N]);
				for (let i = 1; i <= N; i++) ring.push([ea - (ea - w) * i / N, n]);
				for (let i = 1; i <= N; i++) ring.push([w, n - (n - s) * i / N]);
				addShape([ring], { ...common(re), ...vertical(val(re.height, t), val(re.extrudedHeight, t)) });
			}
		}
		const el = e.ellipse;
		if (el && pos && val(el.show, t, true)) {
			dyn(el.semiMajorAxis, el.semiMinorAxis, el.rotation); if (!isConst(e.position)) dynamic = true;
			const a = val(el.semiMajorAxis, t), b = val(el.semiMinorAxis, t);
			if (a > 0 && b > 0) addShape([enuRing(pos, ellipsePts(a, b, val(el.rotation, t, 0)), 0)], { ...common(el), ...vertical(val(el.height, t), val(el.extrudedHeight, t)) });
		}
		const solid = this.#solidsOf(e, t, d, r);
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
					addShape([enuRing(ecef(ll[0], ll[1], 0), ellipsePts(rad.y * k, rad.x * k, 0, 40), 0)], { ...c, outline: false, base: ll[2] + z0, top: ll[2] + z1 });
				}
			}
		}
		const co = e.corridor;
		if (co && val(co.show, t, true)) {
			dyn(co.positions, co.width);
			const ps = val(co.positions, t), w = val(co.width, t, 0);
			if (ps?.length > 1 && w > 0) addShape([corridorRing(ps, w)], { ...common(co), ...vertical(val(co.height, t), val(co.extrudedHeight, t)) });
		}
		const wa = e.wall;
		if (wa && val(wa.show, t, true)) {
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
		if (pv && val(pv.show, t, true)) {
			dyn(pv.positions, pv.shape);
			const ps = val(pv.positions, t), sh: Cartesian2[] = val(pv.shape, t) || [];
			if (ps?.length > 1 && sh.length) {
				const xs = sh.map(p => p.x), ys = sh.map(p => p.y), w = Math.max(...xs) - Math.min(...xs), hh = llOf(ps[0])?.[2] ?? 0;
				addShape([corridorRing(ps, w)], { ...common(pv), base: hh + Math.min(...ys), top: hh + Math.max(...ys) });
			}
		}
		if (e.plane && val(e.plane.show, t, true)) unsupported("entity.plane");
		// ── polyline ──
		const pl = e.polyline;
		if (pl && val(pl.show, t, true)) {
			dyn(pl.positions, pl.width, pl.material, pl.clampToGround, pl.arcType);
			const ps: Cartesian3[] = (val(pl.positions, t) || []).filter(Boolean);
			if (ps.length > 1) {
				const col = materialColor(pl.material, t), width = val(pl.width, t, 1);
				if (val(pl.clampToGround, t, false)) {
					const [lc, lo] = rgbAlpha(col);
					d.shapes.push({ type: "Feature", geometry: { type: "LineString", coordinates: ps.map(p => llOf(p)).filter(Boolean).map(q => [q![0], q![1]]) }, properties: { _id: id, _k: "line", _lc: lc, _lo: lo, _lw: width } });
				} else {
					const at = val(pl.arcType, t, ArcType.GEODESIC);
					const pts = at === ArcType.NONE ? ps : at === ArcType.RHUMB ? PolylinePipeline.generateCartesianRhumbArc({ positions: ps }) : PolylinePipeline.generateCartesianArc({ positions: ps });
					const flat: number[] = [];
					for (let i = 0; i < pts.length; i++) { const q: Any = pts[i]; if (q instanceof Cartesian3) flat.push(q.x, q.y, q.z); else if (typeof q === "number") flat.push(q); }
					d.lines.push({ p: flat, color: css(col), width });
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
	#samples(e: Any, t: JulianDate, r: Rec): { t: number[]; p: number[]; dynamic: boolean } | null {
		const prop = e.position;
		if (isConst(prop)) {
			const p = val(prop, t);
			return p ? { t: [-FAR, FAR], p: [p.x, p.y, p.z, p.x, p.y, p.z], dynamic: false } : null;
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
				r.samples = { t: tt, p: pp };
			}
			return r.samples.t.length ? { ...r.samples, dynamic: false } : null;
		}
		const p = val(prop, t);   // CallbackProperty and the like: where it is now, every frame
		return p ? { t: [-FAR, FAR], p: [p.x, p.y, p.z, p.x, p.y, p.z], dynamic: true } : null;
	}

	#setShapes(map: Any, shapes: Any[]) {
		const fc = { type: "FeatureCollection", features: shapes };
		const src = map.getSource?.(SRC);
		if (src) src.setData(fc); else map.addSource(SRC, { type: "geojson", data: fc });
		const want = new Set<string>(["__cs-fill", "__cs-line"]);
		const ops = new Set<number>();
		for (const s of shapes) if (s.properties._k === "ext") ops.add(Math.round(s.properties._fo * 10) / 10);
		for (const o of ops) want.add(`__cs-ext-${o}`);
		for (const id of want) {
			if (this.#layers.has(id)) continue;
			if (id === "__cs-fill") map.addLayer({ id, type: "fill", source: SRC, filter: ["==", ["get", "_k"], "fill"], paint: { "fill-color": ["get", "_fc"], "fill-opacity": ["get", "_fo"] } });
			else if (id === "__cs-line") map.addLayer({ id, type: "line", source: SRC, filter: ["==", ["get", "_k"], "line"], paint: { "line-color": ["get", "_lc"], "line-opacity": ["get", "_lo"], "line-width": ["get", "_lw"] } });
			else { const o = +id.slice(9); map.addLayer({ id, type: "fill-extrusion", source: SRC, filter: ["all", ["==", ["get", "_k"], "ext"], [">=", ["get", "_fo"], o - 0.05], ["<", ["get", "_fo"], o + 0.05]], paint: { "fill-extrusion-color": ["get", "_fc"], "fill-extrusion-opacity": Math.max(0.05, o), "fill-extrusion-height": ["get", "_h"], "fill-extrusion-base": ["get", "_b"] } }); }
			this.#layers.add(id);
		}
	}

	#placeModels(map: Any, models: Map<Any, NonNullable<Desc["model"]>>) {
		for (const [e, m] of this.#models) if (!models.has(e)) { m.dead = true; m.h?.clear?.(); this.#models.delete(e); }
		for (const [e, d] of models) {
			let m = this.#models.get(e);
			if (m && (m.uri !== d.uri)) { m.dead = true; m.h?.clear?.(); this.#models.delete(e); m = undefined; }
			if (!m) {
				const mm = { h: null as Any, loading: true, uri: d.uri, scale: d.scale, dead: false };
				this.#models.set(e, mm);
				map.gadget.model(d.uri, { at: d.at, altitude: d.altitude, heading: d.heading, scale: d.scale, slot: `cesium:${e.id}`, name: String(e.name ?? e.id), fit: false, gizmo: false })
					.then((h: Any) => { mm.loading = false; if (mm.dead) { h.clear(); return; } mm.h = h; if (d.anim && h.animations?.length) h.play(); }, (err: unknown) => { mm.loading = false; console.warn("[csshim] model", d.uri, err); });
				continue;
			}
			if (m.h) m.h.setTransform({ at: d.at, altitude: d.altitude, heading: d.heading, scale: d.scale / m.scale });
		}
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
			if (r.csSphere?.desc !== r.desc || r.csSphere.dynamic) {
				let cs: ReturnType<typeof cesiumSphereOf> = null;
				try { cs = cesiumSphereOf(entity, this.scene, t); } catch { cs = null; }
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
			if (!d || !e.isShowing || !e.isAvailable(t)) continue;
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
const tracksKey = (tracks: Any[]) => JSON.stringify(tracks.map(t => [t.id, t.t.length, t.t[0], t.t[t.t.length - 1], t.p[0], t.p[1], t.p[2], t.p[t.p.length - 1], t.style, t.avail]));
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
