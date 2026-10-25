// google.maps.Data: GeoJSON features with a style (object or function), drawn as one GeoJSON source and fill / line / circle layers.
//   The style of each feature is evaluated here and written into its properties (_gm_*), so MapLibre reads it with ["get", …].
import { MVCObject, LatLng, LatLngBounds, event, unsupported, toLngLat, fromLngLat, type LatLngLike } from "./core.ts";
import { mouseEvent, type GMap, type LayerOverlay } from "./map.ts";

type Geo = { type: string; coordinates?: any; geometries?: Geo[] };
type Style = Record<string, any>;
let seq = 0;

// ── geometries (Data.Point, Data.LineString, …) ──
class Geometry {
	readonly _geo: Geo;
	constructor(geo: Geo) { this._geo = geo; }
	getType(): string { return this._geo.type; }
	forEachLatLng(f: (ll: LatLng) => void): void {
		const walk = (c: any): void => { if (typeof c[0] === "number") f(fromLngLat(c)); else for (const x of c) walk(x); };
		if (this._geo.geometries) for (const g of this._geo.geometries) new Geometry(g).forEachLatLng(f); else walk(this._geo.coordinates);
	}
	/** Point: its LatLng; others: their parts as LatLng arrays */
	get(): any { const c = this._geo.coordinates; return this._geo.type === "Point" ? fromLngLat(c) : undefined; }
	getArray(): any[] {
		const conv = (c: any): any => typeof c[0] === "number" ? fromLngLat(c) : c.map(conv);
		return this._geo.geometries ? this._geo.geometries.map(g => new Geometry(g)) : this._geo.type === "Point" ? [fromLngLat(this._geo.coordinates)] : this._geo.coordinates.map(conv);
	}
	getLength(): number { return this.getArray().length; }
	getAt(i: number): any { return this.getArray()[i]; }
}
const ll = (p: LatLngLike): number[] => toLngLat(p);
const lls = (a: any): any => Array.isArray(a) ? a.map(x => Array.isArray(x) || (x && x._geo) ? lls(x) : ll(x)) : a?._geo ? a._geo.coordinates : a;
const closed = (r: number[][]): number[][] => r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r;
export const DataGeometries = {
	Point: class extends Geometry { constructor(p: LatLngLike) { super({ type: "Point", coordinates: ll(p) }); } },
	MultiPoint: class extends Geometry { constructor(a: LatLngLike[]) { super({ type: "MultiPoint", coordinates: a.map(ll) }); } },
	LineString: class extends Geometry { constructor(a: LatLngLike[]) { super({ type: "LineString", coordinates: a.map(ll) }); } },
	LinearRing: class extends Geometry { constructor(a: LatLngLike[]) { super({ type: "LinearRing", coordinates: closed(a.map(ll)) }); } },
	MultiLineString: class extends Geometry { constructor(a: any[]) { super({ type: "MultiLineString", coordinates: a.map(lls) }); } },
	Polygon: class extends Geometry { constructor(a: any[]) { super({ type: "Polygon", coordinates: a.map(r => closed(lls(r))) }); } },
	MultiPolygon: class extends Geometry { constructor(a: any[]) { super({ type: "MultiPolygon", coordinates: a.map(p => (p._geo ? p._geo.coordinates : p.map((r: any) => closed(lls(r))))) }); } },
	GeometryCollection: class extends Geometry { constructor(a: Geometry[]) { super({ type: "GeometryCollection", geometries: a.map(g => g._geo) }); } },
};
const toGeometry = (g: any): Geometry | null => g == null ? null : g instanceof Geometry ? g : g.type ? new Geometry(g) : new DataGeometries.Point(g);

/** google.maps.Data.Feature */
export class Feature {
	#id: string | number | undefined; #props: Record<string, unknown>; #geo: Geometry | null; _owner: Data | null = null;
	constructor(o: { id?: string | number; geometry?: any; properties?: Record<string, unknown> | null } = {}) { this.#id = o.id; this.#geo = toGeometry(o.geometry); this.#props = { ...o.properties }; }
	getId(): string | number | undefined { return this.#id; }
	getGeometry(): Geometry | null { return this.#geo; }
	setGeometry(g: any): void { const old = this.#geo; this.#geo = toGeometry(g); this._owner?._changed(this, "setgeometry", { feature: this, newGeometry: this.#geo, oldGeometry: old }); }
	getProperty(k: string): unknown { return this.#props[k]; }
	setProperty(k: string, v: unknown): void {
		if (v === undefined) { this.removeProperty(k); return; }
		const old = this.#props[k]; this.#props[k] = v;
		this._owner?._changed(this, "setproperty", { feature: this, name: k, newValue: v, oldValue: old });
	}
	removeProperty(k: string): void { if (!(k in this.#props)) return; const old = this.#props[k]; delete this.#props[k]; this._owner?._changed(this, "removeproperty", { feature: this, name: k, oldValue: old }); }
	forEachProperty(f: (v: unknown, k: string) => void): void { for (const [k, v] of Object.entries(this.#props)) f(v, k); }
	toGeoJson(cb: (o: object) => void): void { cb(this._json()); }
	_json(): { type: "Feature"; id?: string | number; properties: Record<string, unknown>; geometry: Geo | null } { return { type: "Feature", ...(this.#id !== undefined && { id: this.#id }), properties: { ...this.#props }, geometry: this.#geo?._geo ?? null }; }
}

const DEFAULT: Style = { fillColor: "#000000", fillOpacity: 0.3, strokeColor: "#000000", strokeOpacity: 1, strokeWeight: 3, visible: true, clickable: true };

/** google.maps.Data */
export class Data extends MVCObject implements LayerOverlay {
	#f = new Set<Feature>(); #byId = new Map<string | number, Feature>(); #style: Style | ((f: Feature) => Style | null | undefined) = {};
	#over = new Map<Feature, Style>(); #map: GMap | null = null; #ml: any = null; #id = `gm-data-${++seq}`; #subs: [string, string, (e: any) => void][] = [];
	#hover: Feature | null = null; #list: Feature[] = []; #seen = new Map<string, unknown>(); #pending = false; #zIndex = 0;
	static Feature = Feature;
	constructor(o: { map?: GMap | null; style?: Style } = {}) { super(); if (o.style) this.#style = o.style; if (o.map) this.setMap(o.map); }

	// ── features ──
	add(f: Feature | { id?: string | number; geometry?: any; properties?: Record<string, unknown> } | LatLngLike): Feature {
		const feat = f instanceof Feature ? f : "lat" in (f as object) ? new Feature({ geometry: f }) : new Feature(f as object);
		const id = feat.getId();
		if (id !== undefined && this.#byId.has(id)) this.remove(this.#byId.get(id)!);
		feat._owner = this; this.#f.add(feat); if (id !== undefined) this.#byId.set(id, feat);
		event.trigger(this, "addfeature", { feature: feat });
		this.#refresh();
		return feat;
	}
	addGeoJson(g: any, o: { idPropertyName?: string } = {}): Feature[] {
		const list = g?.type === "FeatureCollection" ? g.features : g?.type === "Feature" ? [g] : g?.type ? [{ type: "Feature", geometry: g, properties: {} }] : [];
		return list.map((x: any) => this.add(new Feature({ id: o.idPropertyName ? x.properties?.[o.idPropertyName] : x.id, geometry: x.geometry, properties: x.properties })));
	}
	loadGeoJson(url: string, o?: { idPropertyName?: string }, cb?: (f: Feature[]) => void): void {
		fetch(url).then(r => r.json()).then(j => { const f = this.addGeoJson(j, o); cb?.(f); }).catch(e => console.error(`[gmshim] loadGeoJson ${url}:`, e));
	}
	remove(f: Feature): void {
		if (!this.#f.delete(f)) return;
		const id = f.getId(); if (id !== undefined && this.#byId.get(id) === f) this.#byId.delete(id);
		f._owner = null; this.#over.delete(f);
		event.trigger(this, "removefeature", { feature: f });
		this.#refresh();
	}
	contains(f: Feature): boolean { return this.#f.has(f); }
	getFeatureById(id: string | number): Feature | undefined { return this.#byId.get(id) ?? this.#byId.get(String(id)) ?? (typeof id === "string" && id !== "" && !isNaN(+id) ? this.#byId.get(+id) : undefined); }
	forEach(cb: (f: Feature) => void): void { for (const f of [...this.#f]) cb(f); }
	toGeoJson(cb: (o: object) => void): void { cb({ type: "FeatureCollection", features: [...this.#f].map(f => f._json()) }); }
	_changed(f: Feature, name: string, e: object): void { if (this.#f.has(f)) { event.trigger(this, name, e); this.#refresh(); } }

	// ── style ──
	setStyle(s: Style | ((f: Feature) => Style | null | undefined)): void { this.#style = s ?? {}; this.#refresh(); }
	getStyle(): unknown { return this.#style; }
	overrideStyle(f: Feature, s: Style): void { this.#over.set(f, { ...this.#over.get(f), ...s }); this.#refresh(); }
	revertStyle(f?: Feature): void { if (f) this.#over.delete(f); else this.#over.clear(); this.#refresh(); }
	#styleOf(f: Feature): Style {
		const base = typeof this.#style === "function" ? this.#style(f) ?? {} : this.#style;
		const s = { ...DEFAULT, ...base, ...this.#over.get(f) };
		if (s.icon) unsupported("Data style icon (points are drawn as circles)");
		return s;
	}
	/** the source data: each feature with its evaluated style in _gm_* properties */
	_data(): object {
		const out: object[] = [];
		let i = 0;
		this.#list = [...this.#f];
		for (const f of this.#f) {
			const j = f._json(); if (!j.geometry) { i++; continue; }
			const s = this.#styleOf(f), pt = s.icon?.scale ?? 6;
			out.push({ type: "Feature", properties: { ...j.properties, _gm_i: i++, _gm_fc: s.fillColor, _gm_fo: +s.fillOpacity, _gm_sc: s.strokeColor, _gm_so: +s.strokeOpacity, _gm_sw: +s.strokeWeight, _gm_v: s.visible !== false, _gm_c: s.clickable !== false, _gm_pt: pt, _gm_pc: s.icon?.fillColor ?? (s.fillColor === DEFAULT.fillColor ? "#EA4335" : s.fillColor) },
				geometry: j.geometry.type === "LinearRing" ? { type: "LineString", coordinates: j.geometry.coordinates } : j.geometry });
		}
		return { type: "FeatureCollection", features: out };
	}
	#refresh(): void {
		if (!this.#ml || this.#pending) return;
		this.#pending = true;
		queueMicrotask(() => { this.#pending = false; this.#ml?.getSource(this.#id)?.setData(this._data()); });
	}
	#featureAt(e: any): Feature | null { const i = e.features?.[0]?.properties?._gm_i; return i == null ? null : this.#list[i] ?? null; }

	// ── LayerOverlay ──
	zIndex(): number { return this.#zIndex; }
	layerIds(): string[] { return [`${this.#id}-fill`, `${this.#id}-line`, `${this.#id}-point`]; }
	clickable(): boolean { return true; }
	_install(ml: any, map: GMap): void {
		this.#ml = ml;
		const before = map._beforeFor(this), id = this.#id, vis = ["==", ["get", "_gm_v"], true];
		const poly = ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]], line = ["in", ["geometry-type"], ["literal", ["LineString", "MultiLineString", "Polygon", "MultiPolygon"]]], point = ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]];
		if (!ml.getSource(id)) ml.addSource(id, { type: "geojson", data: this._data() });
		const layers = [
			{ id: `${id}-fill`, type: "fill", filter: ["all", poly, vis], paint: { "fill-color": ["get", "_gm_fc"], "fill-opacity": ["get", "_gm_fo"] } },
			{ id: `${id}-line`, type: "line", filter: ["all", line, vis], paint: { "line-color": ["get", "_gm_sc"], "line-opacity": ["get", "_gm_so"], "line-width": ["get", "_gm_sw"] }, layout: { "line-join": "round", "line-cap": "round" } },
			{ id: `${id}-point`, type: "circle", filter: ["all", point, vis], paint: { "circle-radius": ["get", "_gm_pt"], "circle-color": ["get", "_gm_pc"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 } },
		];
		for (const l of layers) if (!ml.getLayer(l.id)) ml.addLayer({ ...l, source: id }, before);
		if (this.#subs.length) return;
		const ev: [string, string][] = [["click", "click"], ["dblclick", "dblclick"], ["rightclick", "contextmenu"], ["mousedown", "mousedown"], ["mouseup", "mouseup"], ["mousemove", "mousemove"], ["mouseout", "mouseleave"]];
		for (const lid of this.layerIds()) for (const [g, m] of ev) {
			const f = (e: any): void => {
				if (m === "mouseleave") { if (this.#hover) { const h = this.#hover; this.#hover = null; ml.getCanvas?.()?.style.setProperty("cursor", ""); event.trigger(this, "mouseout", mouseEvent(e, { feature: h })); } return; }
				const feat = this.#featureAt(e);
				if (!feat || e.features?.[0]?.properties?._gm_c === false) return;
				if (e.originalEvent) { if (this.#seen.get(m) === e.originalEvent) return; this.#seen.set(m, e.originalEvent); }
				if (m === "mousemove" && feat !== this.#hover) {
					if (this.#hover) event.trigger(this, "mouseout", mouseEvent(e, { feature: this.#hover }));
					this.#hover = feat; ml.getCanvas?.()?.style.setProperty("cursor", "pointer");
					event.trigger(this, "mouseover", mouseEvent(e, { feature: feat }));
				}
				event.trigger(this, g, mouseEvent(e, { feature: feat }));
			};
			ml.on(m, lid, f); this.#subs.push([m, lid, f]);
		}
	}
	_uninstall(ml: any): void {
		for (const [m, id, f] of this.#subs.splice(0)) ml.off(m, id, f);
		for (const id of this.layerIds()) if (ml.getLayer(id)) ml.removeLayer(id);
		if (ml.getSource(this.#id)) ml.removeSource(this.#id);
		this.#ml = null; this.#hover = null;
	}
	setMap(m: GMap | null): void { if (m === this.#map) return; this.#map?._detach(this); this.#map = m; m?._attach(this); }
	getMap(): GMap | null { return this.#map; }
	setControls(c: unknown): void { if (c) unsupported("Data drawing controls"); }
	setDrawingMode(m: unknown): void { if (m) unsupported("Data drawing mode"); }
	getDrawingMode(): null { return null; }
	/** the bounds of every feature (not in Google's API; handy with map.fitBounds) */
	getBounds(): LatLngBounds { const b = new LatLngBounds(); for (const f of this.#f) f.getGeometry()?.forEachLatLng(p => b.extend(p)); return b; }
}
