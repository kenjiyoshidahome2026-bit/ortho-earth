// L.Map on a MapLibre map: options, camera, panes, handlers, layers, and the mouse events of the map and its paths.
//   Zoom: Leaflet's tiles are 256 px and MapLibre's 512 px, so a Leaflet zoom z is MapLibre zoom z − 1 (ctx.zoomOffset, default 1).
//   Layers that draw as MapLibre sources/layers (tiles, images, path renderers) join one stack ordered like Leaflet's panes:
//   (pane z-index, zIndex in the pane, order added) → the MapLibre `before` layer.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Evented, Handler, define, stamp, setOptions, unsupported } from "./core.ts";
import { LatLng, LatLngBounds, Point, Bounds, EPSG3857, toLatLng, toLatLngBounds, toPoint } from "./geo.ts";
import { DomEvent, injectCss } from "./dom.ts";
import { SVG } from "./vector.ts";

/** what createLeaflet closes over */
export interface Ctx {
	ml: any;
	zoomOffset: number;
	/** the MapLibre style of every map (null: the maplibregl Map's own default) */
	style?: unknown;
	mapOptions: Record<string, unknown>;
}

/** DOM events already handled by a marker: the MapLibre map does not report them again */
export const OVERLAY_EVENTS = new WeakSet<object>();
// Leaflet's _mouseEvents: a target with bubblingMouseEvents false stops these from reaching the map
const STOPPABLE = new Set(["click", "dblclick", "mouseover", "mouseout", "contextmenu"]);
const ML_MOUSE = ["click", "dblclick", "contextmenu", "mousedown", "mouseup", "mousemove"];
// Leaflet map event → MapLibre map event (translated on the first listener)
const ML_EVENTS: Record<string, string> = { move: "move", movestart: "movestart", moveend: "moveend", zoom: "zoom", zoomstart: "zoomstart", zoomend: "zoomend", dragstart: "dragstart", drag: "drag", dragend: "dragend", resize: "resize", mouseover: "mouseover" };
const CORNER: Record<string, string> = { topleft: "top-left", topright: "top-right", bottomleft: "bottom-left", bottomright: "bottom-right" };
const PANES: [string, number | null][] = [["mapPane", null], ["tilePane", 200], ["overlayPane", 400], ["shadowPane", 500], ["markerPane", 600], ["tooltipPane", 650], ["popupPane", 700]];
// Leaflet handler → MapLibre handler
const HANDLERS: [string, string][] = [["dragging", "dragPan"], ["scrollWheelZoom", "scrollZoom"], ["doubleClickZoom", "doubleClickZoom"], ["boxZoom", "boxZoom"], ["keyboard", "keyboard"], ["touchZoom", "touchZoomRotate"], ["tapHold", ""], ["tap", ""]];
let glSeq = 0;

/** map.dragging / map.scrollWheelZoom / …: enable() and disable() the MapLibre handler underneath */
class MlHandler extends Handler {
	addHooks(): void { this._map._ml[this._ml]?.enable?.(); }
	removeHooks(): void { this._map._ml[this._ml]?.disable?.(); }
	moving(): boolean { return !!this._map._ml.isMoving?.(); }
}

export class LMap extends Evented {
	initialize(id: string | HTMLElement, options?: any): void {
		const o = setOptions(this, options), ctx: Ctx = this._ctx;
		if (!ctx) throw new Error("L.Map: use the namespace returned by createLeaflet(maplibregl)");
		const container = this._container = typeof id === "string" ? document.getElementById(id) : id;
		if (!container) throw new Error("Map container not found.");
		if ((container as any)._leaflet_id) throw new Error("Map container is already initialized.");
		stamp(container);
		container.classList?.add("leaflet-container");
		injectCss();
		if (o.crs && o.crs.code !== "EPSG:3857" && o.crs.code !== "EPSG:900913") unsupported(`Map crs ${o.crs.code ?? "(custom)"}: MapLibre draws Web Mercator / the globe; coordinates are still read as latitude / longitude`);
		this._handlers = []; this._layers = {}; this._zoomBoundLayers = {}; this._panes = {}; this._paneRenderers = {};
		this._renderers = new Set(); this._pathById = new Map(); this._gl = new Set(); this._glInstalled = new Set();
		this._bound = new Set<string>(); this._ready = false; this._queue = []; this._hovered = null;
		const off = ctx.zoomOffset, rotate = !!o.rotate;
		const mo: Record<string, unknown> = {
			container, center: o.center ? toLngLat(o.center) : [0, 0], zoom: o.zoom !== undefined ? Math.max(0, this._limitZoom(o.zoom) - off) : 0,
			attributionControl: false, dragPan: o.dragging !== false, scrollZoom: o.scrollWheelZoom !== false, boxZoom: o.boxZoom !== false,
			doubleClickZoom: o.doubleClickZoom !== false, keyboard: o.keyboard !== false, touchZoomRotate: o.touchZoom !== false,
			dragRotate: rotate, pitchWithRotate: rotate, touchPitch: rotate,
			...(o.bearing !== undefined && { bearing: o.bearing }), ...(o.pitch !== undefined && { pitch: o.pitch }),
			...(o.minZoom !== undefined && { minZoom: Math.max(0, o.minZoom - off) }), ...(o.maxZoom !== undefined && { maxZoom: Math.max(0, o.maxZoom - off) }),
			...(o.maxBounds && { maxBounds: toMlBounds(o.maxBounds) }),
			...(ctx.style === undefined ? { style: { version: 8, sources: {}, layers: [] } } : ctx.style !== null && { style: ctx.style }),
			...ctx.mapOptions, ...o.maplibre,   // escape hatch: raw MapLibre MapOptions
		};
		const ml = this._ml = new ctx.ml.Map(mo);
		if (!rotate) ml.touchZoomRotate?.disableRotation?.();
		if (o.maxBounds) this.options.maxBounds = toLatLngBounds(o.maxBounds);
		const ready = (): void => {
			if (this._ready) return;
			this._ready = true;
			for (const f of this._queue.splice(0)) f();
			this._loaded = true;
			this.fire("load");
		};
		if (ml.isStyleLoaded?.()) queueMicrotask(ready); else ml.once("load", ready);
		// MapLibre drops sources/layers with the old style: put ours back after a setStyle on the MapLibre map
		ml.on("style.load", () => { if (!this._ready) return; this._glInstalled.clear(); for (const g of this._gl) this._glInstall(g); });
		for (const t of ML_MOUSE) ml.on(t, (e: any) => this._handleMouse(t, e));
		ml.on("mouseout", (e: any) => { this._hover(null, this._mouseData(e)); this.fire("mouseout", this._mouseData(e)); });
		DomEvent.on(container, "keydown", (e: KeyboardEvent) => { if (e.key === "Escape" && this._popup?.options.closeOnEscapeKey) this.closePopup(); });
		for (const [name, z] of PANES) { const p = this.createPane(name); if (z != null) p.style.zIndex = String(z); }
		for (const [name, mlName] of HANDLERS) {
			const h = this[name] = new MlHandler(this);
			h._ml = mlName;
			h._enabled = !!o[name];
			this._handlers.push(h);
		}
		this._lastSize = this.getSize();
		this.callInitHooks();   // Leaflet adds its zoom / attribution controls here
		for (const l of [].concat(o.layers || [])) this.addLayer(l);
	}

	// ── the MapLibre side ──
	/** the MapLibre map underneath (escape hatch) */
	getMapLibre(): any { return this._ml; }
	get _zoff(): number { return this._ctx.zoomOffset; }
	_mlZoom(z: number): number { return Math.max(0, z - this._zoff); }
	_whenStyle(f: () => void): void { if (this._ready) f(); else this._queue.push(f); }
	/** a layer drawn as MapLibre sources/layers joins the stack */
	_glAttach(g: any): void { this._gl.add(g); g._seq ??= ++glSeq; this._whenStyle(() => { if (this._gl.has(g)) this._glInstall(g); }); }
	_glDetach(g: any): void { this._gl.delete(g); if (this._glInstalled.delete(g)) g._glUninstall(this._ml); }
	_glInstall(g: any): void { if (this._glInstalled.has(g)) return; g._glInstall(this._ml, this._beforeFor(g)); this._glInstalled.add(g); }
	/** move an installed layer to its place in the stack again (after setZIndex / bringToFront) */
	_glReorder(g: any): void {
		if (!this._glInstalled.has(g)) return;
		const before = this._beforeFor(g);
		for (const id of g._layerIds()) if (this._ml.getLayer(id)) this._ml.moveLayer(id, before);
	}
	_paneZ(pane: any): number { const p = this.getPane(pane); return +(p?.style?.zIndex) || 400; }
	_glKey(g: any): number[] { return [this._paneZ(g.options.pane), g._subZ(), g._seq]; }
	/** the first MapLibre layer of the lowest layer stacked above g */
	_beforeFor(g: any): string | undefined {
		const k = this._glKey(g), gt = (a: number[], b: number[]): boolean => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
		let best: any = null, bestKey: number[] | null = null;
		for (const x of this._glInstalled) { if (x === g) continue; const xk = this._glKey(x); if (gt(xk, k) && (!bestKey || gt(bestKey, xk))) { best = x; bestKey = xk; } }
		return best?._layerIds().find((id: string) => this._ml.getLayer(id));
	}

	// ── mouse events: the map, its paths (hit by queryRenderedFeatures) and markers (their own DOM events) ──
	_mouseData(e: any): any {
		const p = e.point ? new Point(e.point.x, e.point.y) : undefined;
		return { originalEvent: e.originalEvent ?? {}, latlng: e.lngLat ? new LatLng(e.lngLat.lat, e.lngLat.lng) : undefined, containerPoint: p, layerPoint: p };
	}
	_pathAt(point: { x: number; y: number }): any {
		let any = false;
		for (const r of this._renderers) if (r._interactive > 0) { any = true; break; }
		if (!any) return null;
		const layers = [...this._renderers].flatMap((r: any) => r._layerIds()).filter((id: string) => this._ml.getLayer(id));
		if (!layers.length) return null;
		for (const f of this._ml.queryRenderedFeatures([point.x, point.y], { layers }) || []) {
			const p = this._pathById.get(f.properties?._lid ?? f.id);
			if (p?.options.interactive && p._map === this) return p;
		}
		return null;
	}
	_handleMouse(type: string, e: any): void {
		const oe = e.originalEvent;
		if (oe && OVERLAY_EVENTS.has(oe)) return;
		const data = this._mouseData(e), target = e.point ? this._pathAt(e.point) : null;
		if (type === "mousemove") this._hover(target, data);
		const targets = target ? [target, this] : [this];
		if (type === "click") this._fireTargets("preclick", targets, { ...data, originalEvent: synth(data.originalEvent) });
		this._fireTargets(type, targets, data);
	}
	_hover(target: any, data: any): void {
		const prev = this._hovered;
		if (prev === target) return;
		this._hovered = target;
		prev?.fire("mouseout", data, true);
		target?.fire("mouseover", data, true);
		this._ml.getCanvas?.()?.style?.setProperty?.("cursor", target ? "pointer" : "");
	}
	/** Leaflet's _fireDOMEvent: each target in turn, until one stops the event (L.DomEvent.stopPropagation / bubblingMouseEvents: false) */
	_fireTargets(type: string, targets: any[], data: any): void {
		for (const t of targets) {
			t.fire(type, data, true);
			if (data.originalEvent?._stopped || (t.options.bubblingMouseEvents === false && STOPPABLE.has(type))) return;
		}
	}
	/** a DOM event on a marker: the marker, then the map (unless stopped); MapLibre's report of the same event is skipped */
	_overlayMouse(layer: any, type: string, ev: any): void {
		OVERLAY_EVENTS.add(ev);
		const p = typeof ev.clientX === "number" ? this.mouseEventToContainerPoint(ev) : undefined;
		const data = { originalEvent: ev, latlng: layer.getLatLng?.(), containerPoint: p, layerPoint: p }, targets = [layer, this];
		if (type === "click") this._fireTargets("preclick", targets, { ...data, originalEvent: synth(ev) });
		this._fireTargets(type, targets, data);
	}
	_onListen(type: string): void {
		if (this._bound.has(type) || !this._ml) return;
		this._bound.add(type);
		const m = ML_EVENTS[type];
		if (type === "resize") this._ml.on("resize", () => { const old = this._lastSize, n = this._lastSize = this.getSize(); this.fire("resize", { oldSize: old, newSize: n }); });
		else if (type === "mouseover") this._ml.on("mouseover", (e: any) => this.fire("mouseover", this._mouseData(e)));
		else if (m) this._ml.on(m, (e: any) => this.fire(type, { originalEvent: e?.originalEvent }));
		else if (type === "keypress" || type === "keydown" || type === "keyup") DomEvent.on(this._container, type, (e: Event) => this.fire(type, { originalEvent: e }));
		else if (type === "zoomanim" || type === "autopanstart") unsupported(`Map event "${type}"`);
	}

	// ── camera ──
	getCenter(): LatLng { const c = this._ml.getCenter(); return new LatLng(c.lat, c.lng); }
	getZoom(): number { return this._ml.getZoom() + this._zoff; }
	getBounds(): LatLngBounds { const b = this._ml.getBounds(); return new LatLngBounds([b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]); }
	getMinZoom(): number { return this.options.minZoom === undefined ? this._layersMinZoom || 0 : this.options.minZoom; }
	getMaxZoom(): number { return this.options.maxZoom === undefined ? (this._layersMaxZoom === undefined ? Infinity : this._layersMaxZoom) : this.options.maxZoom; }
	getSize(): Point { const c = this._container; return new Point(c.clientWidth || 0, c.clientHeight || 0); }
	_limitZoom(zoom: number): number {
		const snap = this.options.zoomSnap;
		if (snap) zoom = Math.round(zoom / snap) * snap;
		return Math.max(this.getMinZoom(), Math.min(this.getMaxZoom(), zoom));
	}
	_move(center: LatLng, zoom: number, options: any = {}): this {
		const cam = { center: toLngLat(center), zoom: this._mlZoom(zoom) };
		if (options.animate === true || options.pan?.animate === true || options.zoom?.animate === true) this._ml.easeTo({ ...cam, duration: (options.duration ?? options.pan?.duration ?? 0.25) * 1000 });
		else this._ml.jumpTo(cam);
		return this;
	}
	setView(center: any, zoom?: number, options?: any): this { return this._move(toLatLng(center)!, zoom === undefined ? this.getZoom() : this._limitZoom(zoom), options); }
	setZoom(zoom: number, options?: any): this { return this.setView(this.getCenter(), zoom, { zoom: options }); }
	zoomIn(delta?: number, options?: any): this { return this._zoomBy(delta || this.options.zoomDelta, options); }
	zoomOut(delta?: number, options?: any): this { return this._zoomBy(-(delta || this.options.zoomDelta), options); }
	_zoomBy(d: number, options?: any): this {
		const z = this._limitZoom(this.getZoom() + d);
		if (options?.animate === false) this._ml.jumpTo({ zoom: this._mlZoom(z) }); else this._ml.easeTo({ zoom: this._mlZoom(z), duration: 250 });
		return this;
	}
	setZoomAround(latlng: any, zoom: number, options?: any): this {
		const scale = this.getZoomScale(zoom), half = this.getSize().divideBy(2);
		const p = latlng instanceof Point ? latlng : this.latLngToContainerPoint(latlng);
		const centerOffset = p.subtract(half).multiplyBy(1 - 1 / scale);
		return this.setView(this.containerPointToLatLng(half.add(centerOffset)), zoom, { zoom: options });
	}
	panTo(center: any, options: any = {}): this {
		const c = toLatLng(center)!;
		if (options.animate === false) this._ml.jumpTo({ center: toLngLat(c) }); else this._ml.easeTo({ center: toLngLat(c), duration: (options.duration ?? 0.25) * 1000 });
		return this;
	}
	panBy(offset: any, options: any = {}): this {
		const p = toPoint(offset)!.round();
		this._ml.panBy([p.x, p.y], options.animate === false ? { animate: false, duration: 0 } : { duration: (options.duration ?? 0.25) * 1000 });
		return this;
	}
	flyTo(latlng: any, zoom?: number, options: any = {}): this {
		if (options.animate === false) return this.setView(latlng, zoom, options);
		const z = zoom === undefined ? this.getZoom() : this._limitZoom(zoom);
		this._ml.flyTo({ center: toLngLat(toLatLng(latlng)!), zoom: this._mlZoom(z), ...(options.duration !== undefined && { duration: options.duration * 1000 }) });
		return this;
	}
	_getBoundsCenterZoom(bounds: any, options: any = {}): { center: LatLng; zoom: number } {
		bounds = toLatLngBounds(bounds);
		const tl = toPoint(options.paddingTopLeft || options.padding || [0, 0])!, br = toPoint(options.paddingBottomRight || options.padding || [0, 0])!;
		let zoom = this.getBoundsZoom(bounds, false, tl.add(br));
		zoom = typeof options.maxZoom === "number" ? Math.min(options.maxZoom, zoom) : zoom;
		if (zoom === Infinity) return { center: bounds.getCenter(), zoom };
		const paddingOffset = br.subtract(tl).divideBy(2), sw = this.project(bounds.getSouthWest(), zoom), ne = this.project(bounds.getNorthEast(), zoom);
		return { center: this.unproject(sw.add(ne).divideBy(2).add(paddingOffset), zoom), zoom };
	}
	fitBounds(bounds: any, options?: any): this {
		bounds = toLatLngBounds(bounds);
		if (!bounds.isValid()) throw new Error("Bounds are not valid.");
		const t = this._getBoundsCenterZoom(bounds, options);
		return this.setView(t.center, t.zoom, options);
	}
	fitWorld(options?: any): this { return this.fitBounds([[-90, -180], [90, 180]], options); }
	flyToBounds(bounds: any, options?: any): this { const t = this._getBoundsCenterZoom(bounds, options); return this.flyTo(t.center, t.zoom, options); }
	/** Leaflet's getBoundsZoom: the zoom that fits the bounds in the container, snapped to zoomSnap */
	getBoundsZoom(bounds: any, inside?: boolean, padding?: any): number {
		bounds = toLatLngBounds(bounds);
		const pad = toPoint(padding || [0, 0])!;
		let zoom = this.getZoom() || 0;
		const min = this.getMinZoom(), max = this.getMaxZoom(), size = this.getSize().subtract(pad);
		const boundsSize = new Bounds(this.project(bounds.getSouthEast(), zoom), this.project(bounds.getNorthWest(), zoom)).getSize();
		const sx = size.x / boundsSize.x, sy = size.y / boundsSize.y, scale = inside ? Math.max(sx, sy) : Math.min(sx, sy), snap = this.options.zoomSnap;
		zoom = this.getScaleZoom(scale, zoom);
		if (snap) { zoom = Math.round(zoom / (snap / 100)) * (snap / 100); zoom = inside ? Math.ceil(zoom / snap) * snap : Math.floor(zoom / snap) * snap; }
		return Math.max(min, Math.min(max, zoom));
	}
	panInsideBounds(bounds: any, options?: any): this {
		const b = toLatLngBounds(bounds), c = this.getCenter();
		const lat = Math.max(b.getSouth(), Math.min(b.getNorth(), c.lat)), lng = Math.max(b.getWest(), Math.min(b.getEast(), c.lng));
		return lat === c.lat && lng === c.lng ? this : this.panTo([lat, lng], options);
	}
	setMaxBounds(bounds: any): this {
		const b = bounds && toLatLngBounds(bounds);
		if (!b || !b.isValid()) { this.options.maxBounds = null; this._ml.setMaxBounds(null); return this; }
		this.options.maxBounds = b;
		this._ml.setMaxBounds(toMlBounds(b));
		return this;
	}
	setMinZoom(zoom: number): this { const old = this.options.minZoom; this.options.minZoom = zoom; this._applyZoomRange(); if (old !== zoom) this.fire("zoomlevelschange"); return this; }
	setMaxZoom(zoom: number): this { const old = this.options.maxZoom; this.options.maxZoom = zoom; this._applyZoomRange(); if (old !== zoom) this.fire("zoomlevelschange"); return this; }
	_applyZoomRange(): void {
		const min = this.getMinZoom(), max = this.getMaxZoom();
		this._ml.setMinZoom?.(Math.max(0, min - this._zoff));
		this._ml.setMaxZoom?.(isFinite(max) ? Math.max(0, max - this._zoff) : null);
	}
	stop(): this { this._ml.stop?.(); return this; }
	invalidateSize(options?: any): this { this._ml.resize(); return this; }
	getScaleZoom(scale: number, fromZoom?: number): number { const crs = this.options.crs, z = crs.zoom(scale * crs.scale(fromZoom === undefined ? this.getZoom() : fromZoom)); return isNaN(z) ? Infinity : z; }
	getZoomScale(toZoom: number, fromZoom?: number): number { const crs = this.options.crs; return crs.scale(toZoom) / crs.scale(fromZoom === undefined ? this.getZoom() : fromZoom); }

	// ── coordinates (the layer-point origin is the container's top-left corner) ──
	project(latlng: any, zoom?: number): Point { return this.options.crs.latLngToPoint(toLatLng(latlng), zoom === undefined ? this.getZoom() : zoom); }
	unproject(point: any, zoom?: number): LatLng { return this.options.crs.pointToLatLng(toPoint(point), zoom === undefined ? this.getZoom() : zoom); }
	latLngToContainerPoint(latlng: any): Point { const p = this._ml.project(toLngLat(toLatLng(latlng)!)); return new Point(p.x, p.y); }
	containerPointToLatLng(point: any): LatLng { const q = toPoint(point)!, ll = this._ml.unproject([q.x, q.y]); return new LatLng(ll.lat, ll.lng); }
	latLngToLayerPoint(latlng: any): Point { return this.latLngToContainerPoint(latlng); }
	layerPointToLatLng(point: any): LatLng { return this.containerPointToLatLng(point); }
	containerPointToLayerPoint(point: any): Point { return toPoint(point)!; }
	layerPointToContainerPoint(point: any): Point { return toPoint(point)!; }
	mouseEventToContainerPoint(e: any): Point { return DomEvent.getMousePosition(e, this._container); }
	mouseEventToLayerPoint(e: any): Point { return this.mouseEventToContainerPoint(e); }
	mouseEventToLatLng(e: any): LatLng { return this.containerPointToLatLng(this.mouseEventToContainerPoint(e)); }
	getPixelOrigin(): Point { return this.project(this.getCenter()).subtract(this.getSize().divideBy(2)).round(); }
	getPixelBounds(center?: any, zoom?: number): Bounds { const tl = this.project(center ?? this.getCenter(), zoom).subtract(this.getSize().divideBy(2)); return new Bounds(tl, tl.add(this.getSize())); }
	getPixelWorldBounds(zoom?: number): Bounds | null { return this.options.crs.getProjectedBounds(zoom === undefined ? this.getZoom() : zoom); }
	wrapLatLng(latlng: any): LatLng { return this.options.crs.wrapLatLng(toLatLng(latlng)); }
	wrapLatLngBounds(bounds: any): LatLngBounds { return this.options.crs.wrapLatLngBounds(toLatLngBounds(bounds)); }
	distance(a: any, b: any): number { return this.options.crs.distance(toLatLng(a), toLatLng(b)); }

	// ── DOM ──
	getContainer(): HTMLElement { return this._container; }
	/** panes are kept for code that reads them (their z-index orders the MapLibre layers); they are not in the page */
	createPane(name: string, container?: HTMLElement): HTMLElement {
		const pane = document.createElement("div");
		pane.className = `leaflet-pane${name ? ` leaflet-${name.replace("Pane", "")}-pane` : ""}`;
		container?.appendChild(pane);
		if (name) this._panes[name] = pane;
		return pane;
	}
	getPane(pane: any): HTMLElement { return typeof pane === "string" ? this._panes[pane] : pane; }
	getPanes(): Record<string, HTMLElement> { return this._panes; }
	addHandler(name: string, HandlerClass: any): this {
		if (!HandlerClass) return this;
		const h = this[name] = new HandlerClass(this);
		this._handlers.push(h);
		if (this.options[name]) h.enable();
		return this;
	}
	whenReady(callback: (e: any) => void, context?: unknown): this { if (this._loaded) callback.call(context || this, { target: this }); else this.on("load", callback, context); return this; }
	remove(): this {
		if (this._loaded) this.fire("unload");
		for (const id in this._layers) this._layers[id].remove();
		this._ml.remove();
		delete (this._container as any)._leaflet_id;
		this._container.classList?.remove("leaflet-container");
		this._loaded = false;
		return this;
	}

	// ── layers ──
	addLayer(layer: any): this {
		if (!layer._layerAdd) throw new Error("The provided object is not a Layer.");
		const id = stamp(layer);
		if (this._layers[id]) return this;
		this._layers[id] = layer;
		layer._mapToAdd = this;
		layer.beforeAdd?.(this);
		layer._layerAdd({ target: this });
		if (layer.options && (!isNaN(layer.options.maxZoom) || !isNaN(layer.options.minZoom))) { this._zoomBoundLayers[id] = layer; this._updateZoomLevels(); }
		return this;
	}
	removeLayer(layer: any): this {
		const id = stamp(layer);
		if (!this._layers[id]) return this;
		if (layer._map === this) layer.onRemove(this);
		delete this._layers[id];
		if (this._zoomBoundLayers[id]) { delete this._zoomBoundLayers[id]; this._updateZoomLevels(); }
		this.fire("layerremove", { layer });
		layer.fire("remove");
		layer._map = layer._mapToAdd = null;
		return this;
	}
	hasLayer(layer: any): boolean { return !!layer && stamp(layer) in this._layers; }
	eachLayer(fn: (l: any) => void, context?: unknown): this { for (const id in this._layers) fn.call(context, this._layers[id]); return this; }
	_updateZoomLevels(): void {
		let min = Infinity, max = -Infinity;
		const oldMax = this.getMaxZoom(), oldMin = this.getMinZoom();
		for (const id in this._zoomBoundLayers) {
			const o = this._zoomBoundLayers[id].options;
			min = o.minZoom === undefined ? min : Math.min(min, o.minZoom);
			max = o.maxZoom === undefined ? max : Math.max(max, o.maxZoom);
		}
		this._layersMaxZoom = max === -Infinity ? undefined : max;
		this._layersMinZoom = min === Infinity ? undefined : min;
		if (oldMax !== this.getMaxZoom() || oldMin !== this.getMinZoom()) { this._applyZoomRange(); this.fire("zoomlevelschange"); }
	}
	/** the renderer a path draws into: its own, its pane's, or the map's */
	getRenderer(layer: any): any {
		let r = layer.options.renderer || this._getPaneRenderer(layer.options.pane) || this.options.renderer || this._renderer;
		if (!r) r = this._renderer = this._createRenderer();
		if (!this.hasLayer(r)) this.addLayer(r);
		return r;
	}
	_getPaneRenderer(name?: string): any {
		if (name === "overlayPane" || name === undefined) return false;
		let r = this._paneRenderers[name];
		if (r === undefined) r = this._paneRenderers[name] = this._createRenderer({ pane: name });
		return r;
	}
	_createRenderer(options?: any): any { return new SVG(options); }

	// ── controls (MapLibre control corners) ──
	addControl(control: any): this { control.addTo(this); return this; }
	removeControl(control: any): this { control.remove(); return this; }
	_addMlControl(control: any, container: HTMLElement, position: string): void {
		container.classList?.add("maplibregl-ctrl");
		const c = control._mlControl = { onAdd: () => container, onRemove: () => container.parentNode?.removeChild(container) };
		this._ml.addControl(c, CORNER[position] ?? "top-right");
	}
	_removeMlControl(control: any): void { if (control._mlControl) this._ml.removeControl?.(control._mlControl); control._mlControl = null; }

	// ── geolocation ──
	locate(options: any = {}): this {
		const o = this._locateOptions = { timeout: 10000, watch: false, ...options };
		if (typeof navigator === "undefined" || !navigator.geolocation) { this.fire("locationerror", { code: 0, message: "Geolocation not supported." }); return this; }
		const ok = (pos: GeolocationPosition): void => {
			const c = pos.coords, latlng = new LatLng(c.latitude, c.longitude), bounds = latlng.toBounds(c.accuracy * 2);
			if (o.setView) this.setView(latlng, Math.min(this.getBoundsZoom(bounds), o.maxZoom ?? Infinity));
			const data: any = { latlng, bounds, timestamp: pos.timestamp };
			for (const k in c) if (typeof (c as any)[k] === "number") data[k] = (c as any)[k];
			this.fire("locationfound", data);
		};
		const err = (e: GeolocationPositionError): void => { const code = e.code, message = e.message || (code === 1 ? "permission denied" : code === 2 ? "position unavailable" : "timeout"); if (o.setView && !this._loaded) this.fitWorld(); this.fire("locationerror", { code, message: `Geolocation error: ${message}.` }); };
		const go = { enableHighAccuracy: !!o.enableHighAccuracy, timeout: o.timeout, maximumAge: o.maximumAge ?? 0 };
		if (o.watch) this._locationWatchId = navigator.geolocation.watchPosition(ok, err, go); else navigator.geolocation.getCurrentPosition(ok, err, go);
		return this;
	}
	stopLocate(): this { if (this._locationWatchId != null && typeof navigator !== "undefined") navigator.geolocation.clearWatch(this._locationWatchId); this._locationWatchId = null; return this; }
}
define(LMap, {
	options: {
		crs: EPSG3857, center: undefined, zoom: undefined, minZoom: undefined, maxZoom: undefined, layers: [], maxBounds: undefined, renderer: undefined,
		zoomAnimation: true, zoomAnimationThreshold: 4, fadeAnimation: true, markerZoomAnimation: true, transform3DLimit: 8388608, zoomSnap: 1, zoomDelta: 1, trackResize: true,
		closePopupOnClick: true, boxZoom: true, doubleClickZoom: true, dragging: true, inertia: true, keyboard: true, scrollWheelZoom: true, touchZoom: true, tapHold: false, tap: true,
		zoomControl: true, attributionControl: true,
	},
});

/** Leaflet LatLng → MapLibre [lng, lat] */
export const toLngLat = (v: any): [number, number] => { const p = toLatLng(v)!; return [p.lng, p.lat]; };
/** Leaflet bounds → MapLibre [[w, s], [e, n]] */
export const toMlBounds = (v: any): [[number, number], [number, number]] => { const b = toLatLngBounds(v); return [[b.getWest(), b.getSouth()], [b.getEast(), b.getNorth()]]; };
/** the copy of a DOM event Leaflet hands to "preclick" (stopping it does not stop the click) */
const synth = (e: any): any => ({ type: "preclick", clientX: e?.clientX, clientY: e?.clientY, target: e?.target, button: e?.button });
