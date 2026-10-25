// Shapes: google.maps.Polyline / Polygon / Circle / Rectangle, each a GeoJSON source with line (and fill) layers on the MapLibre map.
import { MVCObject, MVCArray, LatLng, LatLngBounds, event, unsupported, watchArray, toLatLng, toLngLat, toBounds, type LatLngLike, type LatLngBoundsLike, type MapsEventListener } from "./core.ts";
import { spherical } from "./geometry.ts";
import { mouseEvent, type GMap, type LayerOverlay } from "./map.ts";

// Google overlay mouse event → MapLibre layer event
const LAYER_EVENTS: [string, string][] = [["click", "click"], ["dblclick", "dblclick"], ["rightclick", "contextmenu"], ["mousemove", "mousemove"], ["mousedown", "mousedown"], ["mouseup", "mouseup"], ["mouseover", "mouseenter"], ["mouseout", "mouseleave"]];
let seq = 0;

const path = (p: unknown): MVCArray<LatLng> => p instanceof MVCArray ? p as MVCArray<LatLng> : new MVCArray(((p as LatLngLike[]) || []).map(toLatLng));
/** densify a path along great circles (geodesic: true) */
function geodesic(pts: LatLng[]): LatLng[] {
	const out: LatLng[] = [];
	for (let i = 0; i < pts.length; i++) {
		if (i) {
			const n = Math.min(64, Math.ceil(spherical.computeDistanceBetween(pts[i - 1], pts[i]) / 100000));
			for (let k = 1; k < n; k++) out.push(spherical.interpolate(pts[i - 1], pts[i], k / n));
		}
		out.push(pts[i]);
	}
	return out;
}
const ring = (pts: LatLng[]): number[][] => { const r = pts.map(toLngLat); if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0]); return r; };

/** what every shape shares: options, setMap, its source and layers, and mouse events on its layers */
abstract class Shape extends MVCObject implements LayerOverlay {
	protected _o: Record<string, any>;
	protected _map: GMap | null = null;
	protected _ml: any = null;
	protected _id = `gm-shape-${++seq}`;
	#subs: [string, string, (e: any) => void][] = [];
	#hover = 0; #seen = new Map<string, unknown>();
	constructor(defaults: Record<string, any>, opts: Record<string, any>) {
		super();
		this._o = { strokeColor: "#000000", strokeOpacity: 1, strokeWeight: 3, visible: true, clickable: true, zIndex: 0, ...defaults, ...opts };
		if (opts.editable) unsupported(`${this.constructor.name} editable`);
		if (opts.draggable) unsupported(`${this.constructor.name} draggable`);
	}
	protected abstract _geometry(): object;
	protected abstract _layers(): { id: string; type: string; paint: Record<string, unknown>; layout?: Record<string, unknown> }[];
	zIndex(): number { return +this._o.zIndex || 0; }
	clickable(): boolean { return this._o.clickable !== false && this._o.visible !== false; }
	layerIds(): string[] { return this._layers().map(l => l.id); }
	protected _feature(): object { return { type: "Feature", properties: {}, geometry: this._geometry() }; }
	_install(ml: any, map: GMap): void {
		this._ml = ml;
		const before = map._beforeFor(this);
		if (!ml.getSource(this._id)) ml.addSource(this._id, { type: "geojson", data: this._feature() });
		for (const l of this._layers()) if (!ml.getLayer(l.id)) ml.addLayer({ ...l, source: this._id, layout: { ...l.layout, visibility: this._o.visible === false ? "none" : "visible" } }, before);
		if (!this.#subs.length) for (const id of this.layerIds()) for (const [g, m] of LAYER_EVENTS) {
			const f = (e: any): void => {
				if (!this.clickable()) return;
				// the fill and the line of one shape are two layers: one Google event per DOM event, one mouseover/mouseout per visit
				if (m === "mouseenter" || m === "mouseleave") {
					const was = this.#hover; this.#hover = Math.max(0, was + (m === "mouseenter" ? 1 : -1));
					if ((was === 0) === (this.#hover === 0)) return;
					ml.getCanvas?.()?.style.setProperty("cursor", this.#hover ? "pointer" : "");
				} else if (e.originalEvent) {
					if (this.#seen.get(m) === e.originalEvent) return;
					this.#seen.set(m, e.originalEvent);
				}
				event.trigger(this, g, mouseEvent(e));
			};
			ml.on(m, id, f); this.#subs.push([m, id, f]);
		}
	}
	_uninstall(ml: any): void {
		for (const [m, id, f] of this.#subs.splice(0)) ml.off(m, id, f);
		this.#hover = 0;
		for (const id of this.layerIds()) if (ml.getLayer(id)) ml.removeLayer(id);
		if (ml.getSource(this._id)) ml.removeSource(this._id);
		this._ml = null;
	}
	/** geometry changed → new data; options changed → paint/layout */
	protected _redraw(): void { this._ml?.getSource(this._id)?.setData(this._feature()); }
	protected _restyle(): void {
		const ml = this._ml; if (!ml) return;
		for (const l of this._layers()) {
			if (!ml.getLayer(l.id)) continue;
			for (const [k, v] of Object.entries(l.paint)) ml.setPaintProperty(l.id, k, v);
			ml.setLayoutProperty(l.id, "visibility", this._o.visible === false ? "none" : "visible");
		}
	}
	protected _line(): { id: string; type: string; paint: Record<string, unknown>; layout: Record<string, unknown> } {
		return { id: `${this._id}-line`, type: "line", paint: { "line-color": this._o.strokeColor, "line-opacity": +this._o.strokeOpacity, "line-width": +this._o.strokeWeight }, layout: { "line-join": "round", "line-cap": "round" } };
	}
	protected _fill(): { id: string; type: string; paint: Record<string, unknown> } {
		return { id: `${this._id}-fill`, type: "fill", paint: { "fill-color": this._o.fillColor, "fill-opacity": +this._o.fillOpacity } };
	}
	setMap(m: GMap | null): void {
		if (m === this._map) return;
		this._map?._detach(this);
		this._map = m;
		m?._attach(this);
		event.trigger(this, "map_changed");
	}
	getMap(): GMap | null { return this._map; }
	setVisible(v: boolean): void { this._o.visible = v; this._restyle(); event.trigger(this, "visible_changed"); }
	getVisible(): boolean { return this._o.visible !== false; }
	getDraggable(): boolean { return false; }
	setDraggable(d: boolean): void { if (d) unsupported(`${this.constructor.name} draggable`); }
	getEditable(): boolean { return false; }
	setEditable(e: boolean): void { if (e) unsupported(`${this.constructor.name} editable`); }
	/** style options; geometry options go to the subclass's setters */
	setOptions(o: Record<string, any> = {}): void {
		const { map, ...rest } = o;
		const geo = this._takeGeometry(rest);
		if (rest.zIndex !== undefined && rest.zIndex !== this._o.zIndex && this._map) { Object.assign(this._o, rest); const m = this._map; this.setMap(null); this.setMap(m); }
		else { Object.assign(this._o, rest); this._restyle(); }
		if (geo) this._redraw();
		if (map !== undefined) this.setMap(map);
	}
	/** pull geometry keys (path, paths, center, radius, bounds) out of an options object; true when one was set */
	protected abstract _takeGeometry(o: Record<string, any>): boolean;
}

/** google.maps.Polyline */
export class Polyline extends Shape {
	#path!: MVCArray<LatLng>; #watch: MapsEventListener | null = null;
	constructor(opts: Record<string, any> = {}) {
		super({}, opts);
		this.setPath(opts.path ?? []);
		if (opts.icons?.length) unsupported("Polyline icons");
		if (opts.map) this.setMap(opts.map);
	}
	protected _geometry(): object { const p = this.#path.getArray(); return { type: "LineString", coordinates: (this._o.geodesic ? geodesic(p) : p).map(toLngLat) }; }
	protected _layers() { return [this._line()]; }
	protected _takeGeometry(o: Record<string, any>): boolean { if (o.icons?.length) unsupported("Polyline icons"); if (o.path === undefined) return "geodesic" in o; this.setPath(o.path); delete o.path; return true; }
	getPath(): MVCArray<LatLng> { return this.#path; }
	setPath(p: unknown): void { this.#watch?.remove(); this.#path = path(p); this.#watch = watchArray(this.#path, () => this._redraw()); this._redraw(); }
}

/** google.maps.Polygon: the first path is the outer ring, the others are holes */
export class Polygon extends Shape {
	#paths!: MVCArray<MVCArray<LatLng>>; #watch: MapsEventListener | null = null;
	constructor(opts: Record<string, any> = {}) {
		super({ fillColor: "#000000", fillOpacity: 0.3 }, opts);
		this.setPaths(opts.paths ?? []);
		if (opts.map) this.setMap(opts.map);
	}
	protected _geometry(): object { return { type: "Polygon", coordinates: this.#paths.getArray().map(p => p.getArray()).filter(p => p.length).map(p => ring(this._o.geodesic ? geodesic(p) : p)) }; }
	protected _layers() { return [this._fill(), this._line()]; }
	protected _takeGeometry(o: Record<string, any>): boolean { if (o.paths === undefined) return "geodesic" in o; this.setPaths(o.paths); delete o.paths; return true; }
	getPath(): MVCArray<LatLng> { return this.#paths.getAt(0) ?? new MVCArray(); }
	setPath(p: unknown): void { this.setPaths([p]); }
	getPaths(): MVCArray<MVCArray<LatLng>> { return this.#paths; }
	setPaths(p: unknown): void {
		this.#watch?.remove();
		const a = p instanceof MVCArray ? (p as MVCArray<unknown>).getArray() : (p as unknown[]) || [];
		const nested = a.length > 0 && (a[0] instanceof MVCArray || Array.isArray(a[0]));
		this.#paths = p instanceof MVCArray && nested ? p as MVCArray<MVCArray<LatLng>> : new MVCArray(nested ? a.map(path) : [path(a)]);
		this.#watch = watchArray(this.#paths, () => this._redraw());
		this._redraw();
	}
}

/** google.maps.Circle: radius in meters, drawn as a 72-gon on the sphere */
export class Circle extends Shape {
	constructor(opts: Record<string, any> = {}) {
		super({ fillColor: "#000000", fillOpacity: 0.3 }, opts);
		if (opts.center) this._o.center = toLatLng(opts.center);
		this._o.radius = +(opts.radius ?? 0);
		if (opts.map) this.setMap(opts.map);
	}
	protected _geometry(): object {
		const c = this._o.center as LatLng | undefined;
		if (!c) return { type: "Polygon", coordinates: [] };
		const pts: LatLng[] = []; for (let i = 0; i < 72; i++) pts.push(spherical.computeOffset(c, this._o.radius, i * 5));
		return { type: "Polygon", coordinates: [ring(pts)] };
	}
	protected _layers() { return [this._fill(), this._line()]; }
	protected _takeGeometry(o: Record<string, any>): boolean {
		let g = false;
		if (o.center !== undefined) { this._o.center = o.center && toLatLng(o.center); delete o.center; g = true; event.trigger(this, "center_changed"); }
		if (o.radius !== undefined) { this._o.radius = +o.radius; delete o.radius; g = true; event.trigger(this, "radius_changed"); }
		return g;
	}
	getCenter(): LatLng | null { return this._o.center ?? null; }
	setCenter(c: LatLngLike): void { this.setOptions({ center: c }); }
	getRadius(): number { return this._o.radius; }
	setRadius(r: number): void { this.setOptions({ radius: r }); }
	getBounds(): LatLngBounds | null {
		const c = this._o.center as LatLng | undefined; if (!c) return null;
		const r = this._o.radius, b = new LatLngBounds();
		for (const h of [0, 90, 180, 270]) b.extend(spherical.computeOffset(c, r, h));
		return b;
	}
}

/** google.maps.Rectangle */
export class Rectangle extends Shape {
	constructor(opts: Record<string, any> = {}) {
		super({ fillColor: "#000000", fillOpacity: 0.3 }, opts);
		if (opts.bounds) this._o.bounds = toBounds(opts.bounds);
		if (opts.map) this.setMap(opts.map);
	}
	protected _geometry(): object {
		const b = this._o.bounds as LatLngBounds | undefined;
		if (!b || b.isEmpty()) return { type: "Polygon", coordinates: [] };
		const { north: n, south: s, east: e, west: w } = b.toJSON();
		return { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
	}
	protected _layers() { return [this._fill(), this._line()]; }
	protected _takeGeometry(o: Record<string, any>): boolean { if (o.bounds === undefined) return false; this._o.bounds = o.bounds && toBounds(o.bounds); delete o.bounds; event.trigger(this, "bounds_changed"); return true; }
	getBounds(): LatLngBounds | null { return this._o.bounds ?? null; }
	setBounds(b: LatLngBoundsLike): void { this.setOptions({ bounds: b }); }
}
