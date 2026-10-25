// google.maps.Map on a MapLibre map: options, camera, controls and events translated; overlays install their sources/layers through it.
//   Zoom: Google's tiles are 256 px and MapLibre's 512 px, so a Google zoom z is MapLibre zoom z − 1 (ctx.zoomOffset, default 1).
import { MVCObject, MVCArray, LatLng, LatLngBounds, Point, event, unsupported, toLatLng, toLngLat, fromLngLat, toMlBounds, ON_LISTEN, type LatLngLike, type LatLngBoundsLike, type LatLngBoundsLiteral } from "./core.ts";

/** what createGoogleMaps closes over: the maplibregl namespace and the style per map type */
export interface Ctx {
	ml: any;
	zoomOffset: number;
	styles: Record<string, unknown>;
	style?: unknown;
	mapOptions: Record<string, unknown>;
}
/** an overlay drawn as MapLibre sources/layers (shapes, Data) */
export interface LayerOverlay {
	zIndex(): number;
	layerIds(): string[];
	clickable(): boolean;
	_install(ml: any, map: GMap): void;
	_uninstall(ml: any): void;
}

export const MapTypeId = { ROADMAP: "roadmap", SATELLITE: "satellite", HYBRID: "hybrid", TERRAIN: "terrain" } as const;
export const ControlPosition = {
	TOP_LEFT: 1, TOP_CENTER: 2, TOP: 2, TOP_RIGHT: 3, LEFT_CENTER: 4, LEFT_TOP: 5, LEFT: 5, LEFT_BOTTOM: 6, RIGHT_TOP: 7, RIGHT: 7, RIGHT_CENTER: 8, RIGHT_BOTTOM: 9,
	BOTTOM_LEFT: 10, BOTTOM_CENTER: 11, BOTTOM: 11, BOTTOM_RIGHT: 12, CENTER: 13,
	BLOCK_START_INLINE_START: 14, BLOCK_START_INLINE_CENTER: 15, BLOCK_START_INLINE_END: 16, INLINE_START_BLOCK_CENTER: 17, INLINE_START_BLOCK_START: 18, INLINE_START_BLOCK_END: 19,
	INLINE_END_BLOCK_START: 20, INLINE_END_BLOCK_CENTER: 21, INLINE_END_BLOCK_END: 22, BLOCK_END_INLINE_START: 23, BLOCK_END_INLINE_CENTER: 24, BLOCK_END_INLINE_END: 25,
} as const;
// Google position → a MapLibre corner, or a centered strip of our own ("top" | "bottom" | "left" | "right" | "center")
const CORNER: Record<number, string> = {
	1: "top-left", 5: "top-left", 18: "top-left", 14: "top-left", 4: "left", 17: "left", 6: "bottom-left", 19: "bottom-left", 10: "bottom-left", 23: "bottom-left",
	3: "top-right", 7: "top-right", 20: "top-right", 16: "top-right", 8: "right", 21: "right", 9: "bottom-right", 22: "bottom-right", 12: "bottom-right", 25: "bottom-right",
	2: "top", 15: "top", 11: "bottom", 24: "bottom", 13: "center",
};
const STRIP_CSS: Record<string, string> = {
	top: "top:10px;left:50%;transform:translateX(-50%)", bottom: "bottom:10px;left:50%;transform:translateX(-50%)",
	left: "left:10px;top:50%;transform:translateY(-50%)", right: "right:10px;top:50%;transform:translateY(-50%)", center: "left:50%;top:50%;transform:translate(-50%,-50%)",
};

// Google map event → MapLibre map event
const MOUSE: Record<string, string> = { click: "click", dblclick: "dblclick", rightclick: "contextmenu", contextmenu: "contextmenu", mousemove: "mousemove", mouseout: "mouseout", mouseover: "mouseover", mousedown: "mousedown", mouseup: "mouseup" };
const PLAIN: Record<string, string> = { idle: "idle", tilesloaded: "idle", bounds_changed: "move", center_changed: "move", zoom_changed: "zoom", heading_changed: "rotate", tilt_changed: "pitch", drag: "drag", dragstart: "dragstart", dragend: "dragend", resize: "resize", projection_changed: "load", isfractionalzoomenabled_changed: "" };
const CLICKS = new Set(["click", "dblclick", "rightclick", "contextmenu"]);

/** DOM events already handled by an overlay (a marker): the map does not report them as its own click */
export const OVERLAY_EVENTS = new WeakSet<object>();

export const mouseEvent = (e: any, extra: object = {}): any => ({
	latLng: e.lngLat ? fromLngLat(e.lngLat) : null, domEvent: e.originalEvent, pixel: e.point ? new Point(e.point.x, e.point.y) : null,
	stop() { e.originalEvent?.stopPropagation?.(); }, ...extra,
});

export class GMap extends MVCObject {
	static ctx: Ctx | null = null;
	#ml: any; #div: HTMLElement; #ctx: Ctx; #bound = new Set<string>(); #overlays = new Set<LayerOverlay>(); #installed = new Set<LayerOverlay>();
	#mapTypeId: string; #ready = false; #queue: (() => void)[] = []; #strips: Record<string, HTMLElement> = {}; #holders = new Map<number, HTMLElement>();
	#data: any = null; #lastZoom: number | undefined;
	controls: MVCArray<HTMLElement>[] = [];
	overlayMapTypes = new MVCArray<unknown>();
	constructor(div: HTMLElement | null, opts: Record<string, any> = {}) {
		super();
		const ctx = (new.target as typeof GMap).ctx;
		if (!ctx) throw new Error("google.maps.Map: use the namespace returned by createGoogleMaps(maplibregl)");
		if (!div) throw new Error("google.maps.Map: the map div is null");
		this.#ctx = ctx; this.#div = div;
		this.#mapTypeId = opts.mapTypeId ?? MapTypeId.ROADMAP;
		const g = opts.gestureHandling ?? "auto", off = ctx.zoomOffset;
		const style = this.#styleFor(this.#mapTypeId, opts.mapId);
		const mo: Record<string, unknown> = {
			container: div, center: opts.center ? toLngLat(opts.center) : [0, 0], zoom: opts.zoom != null ? Math.max(0, opts.zoom - off) : 0,
			bearing: opts.heading ?? 0, pitch: opts.tilt ?? 0, interactive: g !== "none", cooperativeGestures: g === "cooperative",
			dragPan: opts.draggable !== false, scrollZoom: opts.scrollwheel !== false, doubleClickZoom: !opts.disableDoubleClickZoom, keyboard: opts.keyboardShortcuts !== false,
			...(style !== undefined && { style }),
			...(opts.minZoom != null && { minZoom: Math.max(0, opts.minZoom - off) }), ...(opts.maxZoom != null && { maxZoom: opts.maxZoom - off }),
			...(opts.restriction?.latLngBounds && { maxBounds: toMlBounds(opts.restriction.latLngBounds) }),
			...ctx.mapOptions, ...opts.maplibre,   // escape hatch: raw MapLibre MapOptions
		};
		if (opts.backgroundColor) div.style.background = opts.backgroundColor;
		if (opts.styles) unsupported("MapOptions.styles (Google JSON styling): give MapLibre styles to createGoogleMaps({ styles })");
		for (const k of ["streetViewControl", "mapTypeControl", "rotateControl"]) if (opts[k]) unsupported(`MapOptions.${k}`);
		this.#ml = new ctx.ml.Map(mo);
		const ready = (): void => { if (this.#ready) return; this.#ready = true; for (const f of this.#queue.splice(0)) f(); };
		if (this.#ml.isStyleLoaded?.()) ready(); else this.#ml.once("load", ready);
		// re-adding overlays after a style swap (setMapTypeId) — MapLibre drops user layers with the old style
		this.#ml.on("style.load", () => { if (!this.#ready) return; this.#installed.clear(); for (const o of this.#overlays) this.#install(o); });
		for (let p = 0; p <= 25; p++) { const a = new MVCArray<HTMLElement>(); this.controls[p] = a; for (const n of ["insert_at", "remove_at", "set_at"]) event.addListener(a, n, () => this.#layoutControls(p)); }
		event.addListener(this.overlayMapTypes, "insert_at", () => unsupported("Map.overlayMapTypes"));
		if (!opts.disableDefaultUI) {
			if (opts.zoomControl !== false) this.#addMlControl(new ctx.ml.NavigationControl({ showCompass: !!(opts.heading || opts.tilt) }), opts.zoomControlOptions?.position ?? ControlPosition.RIGHT_BOTTOM);
			if (opts.fullscreenControl !== false && ctx.ml.FullscreenControl) this.#addMlControl(new ctx.ml.FullscreenControl(), opts.fullscreenControlOptions?.position ?? ControlPosition.RIGHT_TOP);
		}
		if (opts.scaleControl && ctx.ml.ScaleControl) this.#addMlControl(new ctx.ml.ScaleControl(), ControlPosition.BOTTOM_RIGHT);
	}

	#styleFor(type: string, mapId?: string): unknown {
		const s = this.#ctx.styles;
		return (mapId && s[mapId]) ?? s[type] ?? (type === "hybrid" ? s.satellite : type === "terrain" ? s.roadmap : undefined) ?? this.#ctx.style;
	}
	#addMlControl(c: unknown, pos: number): void { const corner = CORNER[pos] ?? "top-right"; this.#ml.addControl(c, corner.includes("-") ? corner : corner === "left" ? "top-left" : corner === "right" ? "top-right" : `${corner === "bottom" ? "bottom" : "top"}-right`); }
	#layoutControls(p: number): void {
		if (typeof document === "undefined") return;
		const corner = CORNER[p] ?? "top-right";
		let holder = this.#holders.get(p);
		if (!holder) {
			holder = document.createElement("div");
			holder.className = "maplibregl-ctrl gm-control-holder";
			holder.style.cssText = "clear:both;pointer-events:auto";
			if (corner.includes("-")) this.#ml.addControl({ onAdd: () => holder, onRemove: () => holder!.remove() }, corner);
			else {
				let strip = this.#strips[corner];
				if (!strip) { strip = this.#strips[corner] = document.createElement("div"); strip.style.cssText = `position:absolute;z-index:2;display:flex;gap:6px;flex-direction:${corner === "left" || corner === "right" ? "column" : "row"};${STRIP_CSS[corner]}`; this.#div.appendChild(strip); }
				strip.appendChild(holder);
			}
			this.#holders.set(p, holder);
		}
		holder.replaceChildren(...this.controls[p].getArray());
	}

	// ── the MapLibre side ──
	/** the MapLibre map underneath (escape hatch) */
	getMapLibre(): any { return this.#ml; }
	get _ctx(): Ctx { return this.#ctx; }
	_whenReady(f: () => void): void { if (this.#ready) f(); else this.#queue.push(f); }
	_attach(o: LayerOverlay): void { this.#overlays.add(o); this._whenReady(() => { if (this.#overlays.has(o)) this.#install(o); }); }
	_detach(o: LayerOverlay): void { this.#overlays.delete(o); if (this.#installed.delete(o)) o._uninstall(this.#ml); }
	#install(o: LayerOverlay): void { if (this.#installed.has(o)) return; o._install(this.#ml, this); this.#installed.add(o); }
	/** the first layer of the lowest installed overlay drawn above z (Google zIndex → MapLibre layer order) */
	_beforeFor(o: LayerOverlay): string | undefined {
		let best: LayerOverlay | null = null;
		for (const x of this.#installed) if (x !== o && x.zIndex() > o.zIndex() && (!best || x.zIndex() < best.zIndex())) best = x;
		return best?.layerIds().find(id => this.#ml.getLayer(id));
	}
	#hitsOverlay(e: any): boolean {
		if (e.originalEvent && OVERLAY_EVENTS.has(e.originalEvent)) return true;
		const layers = [...this.#installed].filter(o => o.clickable()).flatMap(o => o.layerIds()).filter(id => this.#ml.getLayer(id));
		return layers.length > 0 && !!e.point && (this.#ml.queryRenderedFeatures(e.point, { layers }) || []).length > 0;
	}
	[ON_LISTEN](name: string): void {
		if (this.#bound.has(name)) return;
		this.#bound.add(name);
		if (MOUSE[name]) this.#ml.on(MOUSE[name], (e: any) => { if (CLICKS.has(name) && this.#hitsOverlay(e)) return; event.trigger(this, name, mouseEvent(e)); });
		else if (name === "zoom_changed") this.#ml.on("zoom", () => { const z = this.getZoom(); if (z !== this.#lastZoom) { this.#lastZoom = z; event.trigger(this, name); } });
		else if (PLAIN[name]) this.#ml.on(PLAIN[name], () => event.trigger(this, name));
		else if (!/_changed$/.test(name)) unsupported(`Map event "${name}"`);
	}

	// ── camera ──
	getCenter(): LatLng { return fromLngLat(this.#ml.getCenter()); }
	setCenter(c: LatLngLike): void { this.#ml.jumpTo({ center: toLngLat(c) }); }
	getZoom(): number { return this.#ml.getZoom() + this.#ctx.zoomOffset; }
	setZoom(z: number): void { this.#ml.jumpTo({ zoom: Math.max(0, z - this.#ctx.zoomOffset) }); }
	getHeading(): number { return this.#ml.getBearing(); }
	setHeading(h: number): void { this.#ml.jumpTo({ bearing: h }); }
	getTilt(): number { return this.#ml.getPitch(); }
	setTilt(t: number): void { this.#ml.jumpTo({ pitch: t }); }
	moveCamera(c: { center?: LatLngLike; zoom?: number; heading?: number; tilt?: number }): void {
		this.#ml.jumpTo({ ...(c.center && { center: toLngLat(c.center) }), ...(c.zoom != null && { zoom: Math.max(0, c.zoom - this.#ctx.zoomOffset) }), ...(c.heading != null && { bearing: c.heading }), ...(c.tilt != null && { pitch: c.tilt }) });
	}
	panTo(c: LatLngLike): void { this.#ml.easeTo({ center: toLngLat(c) }); }
	panBy(x: number, y: number): void { this.#ml.panBy([x, y]); }
	fitBounds(b: LatLngBoundsLike, padding?: number | { top?: number; right?: number; bottom?: number; left?: number }): void {
		const bb = toMlBounds(b);
		if (bb[0][0] > bb[1][0] || bb[0][1] > bb[1][1]) return;   // empty bounds
		this.#ml.fitBounds(bb, { padding: padding ?? 0, animate: false });
	}
	panToBounds(b: LatLngBoundsLike): void { const lb = b instanceof LatLngBounds ? b : new LatLngBounds(b as LatLngBoundsLiteral); if (!lb.isEmpty()) this.panTo(lb.getCenter()); }
	getBounds(): LatLngBounds | undefined {
		const b = this.#ml.getBounds?.();
		return b && new LatLngBounds({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
	}
	getDiv(): HTMLElement { return this.#div; }
	getMapTypeId(): string { return this.#mapTypeId; }
	setMapTypeId(t: string): void {
		if (t === this.#mapTypeId) return;
		this.#mapTypeId = t;
		const s = this.#styleFor(t);
		if (s !== undefined) this.#ml.setStyle(s); else unsupported(`map type "${t}" (no style given for it in createGoogleMaps({ styles }))`);
		event.trigger(this, "maptypeid_changed");
	}
	setOptions(o: Record<string, any> = {}): void {
		const off = this.#ctx.zoomOffset, ml = this.#ml;
		if (o.center || o.zoom != null || o.heading != null || o.tilt != null) this.moveCamera(o);
		if (o.mapTypeId) this.setMapTypeId(o.mapTypeId);
		if (o.minZoom !== undefined) ml.setMinZoom(o.minZoom == null ? null : Math.max(0, o.minZoom - off));
		if (o.maxZoom !== undefined) ml.setMaxZoom(o.maxZoom == null ? null : o.maxZoom - off);
		if (o.restriction !== undefined) ml.setMaxBounds(o.restriction?.latLngBounds ? toMlBounds(o.restriction.latLngBounds) : null);
		const h = (name: string, on: boolean | undefined): void => { if (on !== undefined) ml[name]?.[on ? "enable" : "disable"]?.(); };
		h("dragPan", o.draggable); h("scrollZoom", o.scrollwheel); h("keyboard", o.keyboardShortcuts);
		if (o.disableDoubleClickZoom !== undefined) h("doubleClickZoom", !o.disableDoubleClickZoom);
		if (o.gestureHandling) for (const k of ["dragPan", "scrollZoom", "doubleClickZoom", "touchZoomRotate", "keyboard", "boxZoom", "dragRotate"]) h(k, o.gestureHandling !== "none");
		if (o.backgroundColor) this.#div.style.background = o.backgroundColor;
		if (o.styles) unsupported("MapOptions.styles (Google JSON styling): give MapLibre styles to createGoogleMaps({ styles })");
	}
	/** the Google world-coordinate projection (256 px Web Mercator at zoom 0) */
	getProjection(): { fromLatLngToPoint(ll: LatLngLike): Point; fromPointToLatLng(p: Point, noClamp?: boolean): LatLng } {
		return {
			fromLatLngToPoint(ll) { const p = toLatLng(ll), s = Math.min(Math.max(Math.sin(p.lat() * Math.PI / 180), -0.9999), 0.9999); return new Point(256 * (0.5 + p.lng() / 360), 256 * (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI))); },
			fromPointToLatLng(p, noClamp) { const lng = p.x / 256 * 360 - 180, n = Math.PI - 2 * Math.PI * p.y / 256; return new LatLng(180 / Math.PI * Math.atan(Math.sinh(n)), lng, noClamp); },
		};
	}
	getStreetView(): null { unsupported("Map.getStreetView (Street View)"); return null; }
	getRenderingType(): string { return "VECTOR"; }
	get data(): any { if (!this.#data) this.#data = new (this.#ctx as Ctx & { Data: any }).Data({ map: this }); return this.#data; }
}
