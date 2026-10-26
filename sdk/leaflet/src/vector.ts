// Vector layers: L.Path, Polyline, Polygon, Rectangle, CircleMarker, Circle, and the renderer they draw through.
//   Leaflet draws all paths of a pane into one SVG / Canvas renderer; here a renderer is one GeoJSON source with fill / line / circle layers,
//   each path a feature whose style is written into its properties (MapLibre reads them with ["get", …]). Changes are batched to one setData
//   per microtask, so adding 10,000 GeoJSON features costs one upload. Hit-testing is done by the map (queryRenderedFeatures → the path).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { define, extend, setOptions, stamp, unsupported } from "./core.ts";
import { LatLng, LatLngBounds, Point, SphericalMercator, toLatLng, toLatLngBounds, isFlat, latLngToCoords, latLngsToCoords, getFeature } from "./geo.ts";
import { Layer } from "./layer.ts";

let rseq = 0;
const ll2c = (p: LatLng): number[] => [p.lng, p.lat];
/** a closed ring of [lng, lat] (null when it has under 3 points) */
const ring = (pts: LatLng[]): number[][] | null => { if (pts.length < 3) return null; const r = pts.map(ll2c); const a = r[0], b = r[r.length - 1]; if (a[0] !== b[0] || a[1] !== b[1]) r.push(a.slice()); return r; };

/** the renderer of a pane (L.SVG / L.Canvas): one GeoJSON source, layers fill < line (< dashed lines) < circle */
export class Renderer extends Layer {
	initialize(options?: any): void {
		setOptions(this, options);
		stamp(this);
		this._paths = new Map<number, any>();
		this._id = `lf-r${++rseq}`;
		this._dash = new Map<string, number>();   // dash key → layer number
		this._interactive = 0;
	}
	onAdd(map: any): void { map._renderers.add(this); map._glAttach(this); }
	onRemove(map: any): void { map._renderers.delete(this); map._glDetach(this); }
	getEvents(): Record<string, unknown> { return {}; }
	// ── the map's GL stack ──
	_subZ(): number { return 0; }
	_layerIds(): string[] { const id = this._id; return [`${id}-fill`, `${id}-line`, ...[...this._dash.values()].map(n => `${id}-dash${n}`), `${id}-circle`]; }
	_layerDefs(): any[] {
		const id = this._id, g = (k: string): unknown[] => ["get", k];
		const lineFilter = (d: string): unknown[] => ["all", ["!=", g("_g"), "c"], ["==", g("_s"), 1], ["==", g("_d"), d]];
		const linePaint = { "line-color": g("_c"), "line-opacity": g("_o"), "line-width": g("_w") };
		return [
			{ id: `${id}-fill`, type: "fill", source: id, filter: ["all", ["==", g("_g"), "p"], ["==", g("_f"), 1]], paint: { "fill-color": g("_fc"), "fill-opacity": g("_fo") } },
			{ id: `${id}-line`, type: "line", source: id, filter: lineFilter(""), paint: linePaint, layout: { "line-join": "round", "line-cap": "round" } },
			...[...this._dash].map(([key, n]) => { const [dash, w, cap] = key.split("|"); return { id: `${id}-dash${n}`, type: "line", source: id, filter: lineFilter(key), paint: { ...linePaint, "line-dasharray": dashArray(dash, +w) }, layout: { "line-join": "round", "line-cap": cap || "round" } }; }),
			{ id: `${id}-circle`, type: "circle", source: id, filter: ["==", g("_g"), "c"], paint: { "circle-radius": g("_r"), "circle-color": g("_fc"), "circle-opacity": g("_fo"), "circle-stroke-color": g("_c"), "circle-stroke-width": g("_sw"), "circle-stroke-opacity": g("_o") } },
		];
	}
	_glInstall(ml: any, before?: string): void {
		this._ml = ml;
		if (!ml.getSource(this._id)) ml.addSource(this._id, { type: "geojson", data: this._collection() });
		for (const l of this._layerDefs()) if (!ml.getLayer(l.id)) ml.addLayer(l, before);
	}
	_glUninstall(ml: any): void {
		for (const id of this._layerIds()) if (ml.getLayer(id)) ml.removeLayer(id);
		if (ml.getSource(this._id)) ml.removeSource(this._id);
		this._ml = null;
	}
	// ── paths ──
	_addPath(p: any): void { this._paths.set(stamp(p), p); p._feat = p._buildFeature(); if (p.options.interactive) this._interactive++; this._map?._pathById.set(stamp(p), p); this._update(); }
	_removePath(p: any): void { if (!this._paths.delete(stamp(p))) return; if (p.options.interactive) this._interactive--; this._map?._pathById.delete(stamp(p)); this._update(); }
	_updatePath(p: any): void { if (!this._paths.has(stamp(p))) return; p._feat = p._buildFeature(); this._update(); }
	_bringToFront(p: any): void { const id = stamp(p); if (!this._paths.delete(id)) return; this._paths.set(id, p); this._update(); }
	_bringToBack(p: any): void { const id = stamp(p); if (!this._paths.has(id)) return; this._paths = new Map([[id, p], ...[...this._paths].filter(([k]) => k !== id)]); this._update(); }
	_update(): void {
		if (this._pending) return;
		this._pending = true;
		queueMicrotask(() => { this._pending = false; this._flush(); });
	}
	_flush(): void {
		let n = 0, newDash = false;
		for (const p of this._paths.values()) {
			if (p.options.interactive) n++;
			const d = p._feat?.properties._d;
			if (d && !this._dash.has(d)) { this._dash.set(d, this._dash.size + 1); newDash = true; }
		}
		this._interactive = n;
		const ml = this._ml;
		if (!ml) return;
		if (newDash) { const before = `${this._id}-circle`; for (const l of this._layerDefs()) if (!ml.getLayer(l.id)) ml.addLayer(l, ml.getLayer(before) ? before : undefined); }
		ml.getSource(this._id)?.setData(this._collection());
	}
	_collection(): any { const features: any[] = []; for (const p of this._paths.values()) if (p._feat) features.push(p._feat); return { type: "FeatureCollection", features }; }
}
define(Renderer, { options: { padding: 0.1, tolerance: 0 } });
/** Leaflet's dashArray ("5, 10" in pixels) → MapLibre line-dasharray (in line widths) */
function dashArray(s: string, w: number): number[] { const a = s.split(/[\s,]+/).filter(Boolean).map(Number).map(v => v / Math.max(w, 1)); return a.length % 2 ? [...a, ...a] : a; }

export class SVG extends Renderer {}
export class Canvas extends Renderer {}
export const svg = (o?: any): SVG => new SVG(o);
export const canvas = (o?: any): Canvas => new Canvas(o);

/** L.Path: the style options shared by every vector layer */
export class Path extends Layer {
	beforeAdd(map: any): void { this._renderer = map.getRenderer(this); }
	onAdd(): void { this._renderer._addPath(this); }
	onRemove(): void { this._renderer._removePath(this); }
	redraw(): this { if (this._map) this._renderer?._updatePath(this); return this; }
	setStyle(style: any): this { setOptions(this, style); if (this._map) this._renderer?._updatePath(this); return this; }
	bringToFront(): this { this._renderer?._bringToFront(this); return this; }
	bringToBack(): this { this._renderer?._bringToBack(this); return this; }
	getElement(): null { unsupported("Path.getElement (paths are features of a MapLibre source, not SVG elements)"); return null; }
	_clickTolerance(): number { return (this.options.stroke ? this.options.weight / 2 : 0) + (this._renderer?.options.tolerance || 0); }
	/** the MapLibre feature: geometry and the style as properties */
	_buildFeature(): any {
		const geometry = this._geom();
		if (!geometry) return null;
		const o = this.options, w = +o.weight || 0, stroke = !!o.stroke && w > 0;
		return {
			type: "Feature", id: stamp(this), geometry,
			properties: {
				_lid: stamp(this), _g: this._kind(), _i: o.interactive ? 1 : 0,
				_s: stroke ? 1 : 0, _c: o.color, _w: w, _o: +o.opacity, _sw: stroke ? w : 0,
				_f: o.fill ? 1 : 0, _fc: o.fillColor || o.color, _fo: o.fill ? +o.fillOpacity : 0,
				_d: stroke && o.dashArray ? `${o.dashArray}|${w}|${o.lineCap === "butt" || o.lineCap === "square" ? o.lineCap : "round"}` : "",
				...this._extraProps(),
			},
		};
	}
	_kind(): string { return "l"; }
	_extraProps(): Record<string, unknown> { return {}; }
	_geom(): any { return null; }
}
define(Path, { options: { stroke: true, color: "#3388ff", weight: 3, opacity: 1, lineCap: "round", lineJoin: "round", dashArray: null, dashOffset: null, fill: false, fillColor: null, fillOpacity: 0.2, fillRule: "evenodd", interactive: true, bubblingMouseEvents: true }, _isPath: true });

/** L.Polyline (a flat array of latlngs, or an array of them = MultiLineString) */
export class Polyline extends Path {
	initialize(latlngs: any[], options?: any): void { setOptions(this, options); this._setLatLngs(latlngs || []); }
	getLatLngs(): any[] { return this._latlngs; }
	setLatLngs(latlngs: any[]): this { this._setLatLngs(latlngs); return this.redraw(); }
	isEmpty(): boolean { return !this._latlngs.length; }
	addLatLng(latlng: any, latlngs?: any[]): this { latlngs = latlngs || this._defaultShape(); const p = toLatLng(latlng)!; latlngs!.push(p); this._bounds.extend(p); return this.redraw(); }
	getBounds(): LatLngBounds { return this._bounds; }
	/** the midpoint along the line (computed in Web Mercator, as Leaflet does in projected pixels) */
	getCenter(): LatLng { return polylineCenter(this._defaultShape()); }
	/** the point of the line closest to a layer (= container) point */
	closestLayerPoint(p: Point): Point | null {
		if (!this._map) return null;
		let best: Point | null = null, min = Infinity;
		const parts = isFlat(this._latlngs) ? [this._latlngs] : this._latlngs.map((r: any) => isFlat(r) ? r : r.flat());
		for (const part of parts) {
			const pts = part.map((q: LatLng) => this._map.latLngToContainerPoint(q));
			if (this._kind() === "p" && pts.length) pts.push(pts[0]);
			for (let i = 1; i < pts.length; i++) { const c = closestOnSegment(p, pts[i - 1], pts[i]), d = c.distanceTo(p); if (d < min) { min = d; best = c; } }
		}
		if (best) (best as any).distance = min;
		return best;
	}
	toGeoJSON(precision?: number | false): any {
		const multi = !isFlat(this._latlngs);
		return getFeature(this, { type: `${multi ? "Multi" : ""}LineString`, coordinates: latLngsToCoords(this._latlngs, multi ? 1 : 0, false, precision) });
	}
	_setLatLngs(latlngs: any[]): void { this._bounds = new LatLngBounds(); this._latlngs = this._convertLatLngs(latlngs); }
	_defaultShape(): LatLng[] { return isFlat(this._latlngs) ? this._latlngs : this._latlngs[0]; }
	_convertLatLngs(latlngs: any[]): any[] {
		const flat = isFlat(latlngs);
		return latlngs.map(l => { if (!flat) return this._convertLatLngs(l); const p = toLatLng(l)!; this._bounds.extend(p); return p; });
	}
	_geom(): any {
		const ll = this._latlngs;
		if (isFlat(ll)) return ll.length > 1 ? { type: "LineString", coordinates: ll.map(ll2c) } : null;
		const lines = ll.filter((l: LatLng[]) => l.length > 1).map((l: LatLng[]) => l.map(ll2c));
		return lines.length ? { type: "MultiLineString", coordinates: lines } : null;
	}
}
define(Polyline, { options: { smoothFactor: 1, noClip: false } });

/** L.Polygon: rings (the first is the outer one, the rest holes), or an array of polygons (MultiPolygon) */
export class Polygon extends Polyline {
	isEmpty(): boolean { return !this._latlngs.length || !this._latlngs[0].length; }
	/** the area centroid of the outer ring (in Web Mercator) */
	getCenter(): LatLng { return polygonCenter(this._defaultShape()); }
	toGeoJSON(precision?: number | false): any {
		const holes = !isFlat(this._latlngs), multi = holes && !isFlat(this._latlngs[0]);
		let coords = latLngsToCoords(this._latlngs, multi ? 2 : holes ? 1 : 0, true, precision);
		if (!holes) coords = [coords];
		return getFeature(this, { type: `${multi ? "Multi" : ""}Polygon`, coordinates: coords });
	}
	_setLatLngs(latlngs: any[]): void { super._setLatLngs(latlngs); if (isFlat(this._latlngs)) this._latlngs = [this._latlngs]; }
	_defaultShape(): LatLng[] { return isFlat(this._latlngs[0]) ? this._latlngs[0] : this._latlngs[0][0]; }
	_convertLatLngs(latlngs: any[]): any[] {
		const r = super._convertLatLngs(latlngs), n = r.length;
		if (n >= 2 && r[0] instanceof LatLng && r[0].equals(r[n - 1])) r.pop();
		return r;
	}
	_kind(): string { return "p"; }
	_geom(): any {
		const ll = this._latlngs;
		if (!ll.length) return null;
		const poly = (rings: LatLng[][]): number[][][] | null => { const out = rings.map(ring).filter(Boolean) as number[][][]; return out.length && ring(rings[0]) ? out : null; };
		if (isFlat(ll[0])) { const c = poly(ll); return c && { type: "Polygon", coordinates: c }; }
		const polys = ll.map(poly).filter(Boolean);
		return polys.length ? { type: "MultiPolygon", coordinates: polys } : null;
	}
}
define(Polygon, { options: { fill: true } });

/** L.Rectangle(latLngBounds) */
export class Rectangle extends Polygon {
	initialize(bounds: any, options?: any): void { super.initialize(this._boundsToLatLngs(bounds), options); }
	setBounds(bounds: any): this { return this.setLatLngs(this._boundsToLatLngs(bounds)); }
	_boundsToLatLngs(b: any): LatLng[] { b = toLatLngBounds(b); return [b.getSouthWest(), b.getNorthWest(), b.getNorthEast(), b.getSouthEast()]; }
}

/** L.CircleMarker: a circle of a fixed radius in pixels (a MapLibre circle layer) */
export class CircleMarker extends Path {
	initialize(latlng: any, options?: any): void { setOptions(this, options); this._latlng = toLatLng(latlng); this._radius = this.options.radius; }
	setLatLng(latlng: any): this { const old = this._latlng; this._latlng = toLatLng(latlng); this.redraw(); return this.fire("move", { oldLatLng: old, latlng: this._latlng }); }
	getLatLng(): LatLng { return this._latlng; }
	setRadius(r: number): this { this.options.radius = this._radius = r; return this.redraw(); }
	getRadius(): number { return this._radius; }
	setStyle(options: any): this { const r = (options && options.radius) || this._radius; super.setStyle(options); this.setRadius(r); return this; }
	toGeoJSON(precision?: number | false): any { return getFeature(this, { type: "Point", coordinates: latLngToCoords(this.getLatLng(), precision) }); }
	_kind(): string { return "c"; }
	// Leaflet's stroke straddles the radius; MapLibre's circle stroke is drawn outside it
	_extraProps(): Record<string, unknown> { const o = this.options; return { _r: Math.max(0, this._radius - (o.stroke ? (+o.weight || 0) / 2 : 0)) }; }
	_geom(): any { return this._latlng ? { type: "Point", coordinates: ll2c(this._latlng) } : null; }
}
define(CircleMarker, { options: { fill: true, radius: 10 } });

/** L.Circle: radius in meters, drawn as a 64-gon on the sphere */
export class Circle extends CircleMarker {
	initialize(latlng: any, options?: any, legacyOptions?: any): void {
		if (typeof options === "number") options = extend({}, legacyOptions, { radius: options });
		setOptions(this, options);
		this._latlng = toLatLng(latlng);
		if (isNaN(this.options.radius)) throw new Error("Circle radius cannot be NaN");
		this._mRadius = this.options.radius;
	}
	setRadius(r: number): this { this._mRadius = r; return this.redraw(); }
	getRadius(): number { return this._mRadius; }
	setStyle(style: any): this { return Path.prototype.setStyle.call(this, style) as this; }
	getBounds(): LatLngBounds { return this._latlng.toBounds(this._mRadius * 2); }
	_kind(): string { return "p"; }
	_extraProps(): Record<string, unknown> { return {}; }
	_geom(): any {
		const c = this._latlng; if (!c) return null;
		const pts: LatLng[] = []; for (let i = 0; i < 64; i++) pts.push(offset(c, this._mRadius, i * 360 / 64));
		return { type: "Polygon", coordinates: [ring(pts)] };
	}
}

// ── geometry helpers ──
const D = Math.PI / 180, EARTH_R = 6371000;
/** the point at distance d (m) and bearing h (°) from c on Leaflet's 6,371 km sphere */
function offset(c: LatLng, d: number, h: number): LatLng {
	const r = d / EARTH_R, lat = c.lat * D, lng = c.lng * D, b = h * D;
	const lat2 = Math.asin(Math.sin(lat) * Math.cos(r) + Math.cos(lat) * Math.sin(r) * Math.cos(b));
	const lng2 = lng + Math.atan2(Math.sin(b) * Math.sin(r) * Math.cos(lat), Math.cos(r) - Math.sin(lat) * Math.sin(lat2));
	return new LatLng(lat2 / D, lng2 / D);
}
function closestOnSegment(p: Point, a: Point, b: Point): Point {
	const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
	const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
	return new Point(a.x + t * dx, a.y + t * dy);
}
export function polylineCenter(latlngs: LatLng[]): LatLng {
	if (!latlngs?.length) throw new Error("latlngs not passed");
	const pts = latlngs.map(p => SphericalMercator.project(p));
	let half = 0; for (let i = 1; i < pts.length; i++) half += pts[i].distanceTo(pts[i - 1]) / 2;
	if (half === 0) return latlngs[0];
	for (let i = 1, dist = 0; i < pts.length; i++) {
		const a = pts[i - 1], b = pts[i], seg = a.distanceTo(b);
		dist += seg;
		if (dist > half) { const r = (dist - half) / seg; return SphericalMercator.unproject(new Point(b.x - r * (b.x - a.x), b.y - r * (b.y - a.y))); }
	}
	return latlngs[latlngs.length - 1];
}
export function polygonCenter(latlngs: LatLng[]): LatLng {
	if (!latlngs?.length) throw new Error("latlngs not passed");
	const pts = latlngs.map(p => SphericalMercator.project(p)), o = pts[0];
	let area = 0, x = 0, y = 0;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const p1 = pts[i].subtract(o), p2 = pts[j].subtract(o), f = p1.y * p2.x - p2.y * p1.x;
		x += (p1.x + p2.x) * f; y += (p1.y + p2.y) * f; area += f * 3;
	}
	return area === 0 ? latlngs[0] : SphericalMercator.unproject(new Point(x / area + o.x, y / area + o.y));
}
