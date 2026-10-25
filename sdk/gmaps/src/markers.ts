// Markers and info windows: google.maps.Marker (legacy), marker.AdvancedMarkerElement / PinElement, InfoWindow — all on MapLibre Marker / Popup.
import { MVCObject, LatLng, Size, event, unsupported, toLatLng, toLngLat, fromLngLat, type LatLngLike } from "./core.ts";
import { OVERLAY_EVENTS, type GMap } from "./map.ts";

export const SymbolPath = { CIRCLE: 0, FORWARD_CLOSED_ARROW: 1, FORWARD_OPEN_ARROW: 2, BACKWARD_CLOSED_ARROW: 3, BACKWARD_OPEN_ARROW: 4 } as const;
export const Animation = { BOUNCE: 1, DROP: 2 } as const;
export const CollisionBehavior = { REQUIRED: "REQUIRED", REQUIRED_AND_HIDES_OPTIONAL: "REQUIRED_AND_HIDES_OPTIONAL", OPTIONAL_AND_HIDES_LOWER_PRIORITY: "OPTIONAL_AND_HIDES_LOWER_PRIORITY" } as const;
// Google's built-in symbol paths (radius / arrow units around the origin)
const SYMBOL_D = ["M -1,0 A 1,1 0 1,0 1,0 A 1,1 0 1,0 -1,0", "M 0,-3 L -2,1 L 2,1 Z", "M -2,1 L 0,-3 L 2,1", "M 0,3 L -2,-1 L 2,-1 Z", "M -2,-1 L 0,3 L 2,-1"];
const SVGNS = "http://www.w3.org/2000/svg";
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const el = (tag = "div", css = ""): HTMLElement => { const e = document.createElement(tag); if (css) e.style.cssText = css; return e; };

/** the Google pin (27 × 43 at scale 1), with an optional glyph text or element in the head */
function pinSvg(o: { background?: string; borderColor?: string; glyphColor?: string; glyph?: string | Element | URL | null; scale?: number; label?: string } = {}): HTMLElement {
	const s = o.scale ?? 1, w = 27 * s, h = 43 * s;
	const box = el("div", `position:relative;width:${w}px;height:${h}px;cursor:pointer`);
	const bg = esc(o.background ?? "#EA4335"), bd = esc(o.borderColor ?? "#C5221F"), gc = esc(o.glyphColor ?? "#B31412");
	box.innerHTML = `<svg xmlns="${SVGNS}" width="${w}" height="${h}" viewBox="0 0 27 43" style="display:block"><path d="M13.5 1.5C6.6 1.5 1.5 6.8 1.5 13.6c0 8.9 10.3 15.5 12 27.4 1.7-11.9 12-18.5 12-27.4C25.5 6.8 20.4 1.5 13.5 1.5z" fill="${bg}" stroke="${bd}" stroke-width="1.5"/>${o.glyph === undefined && o.label == null ? `<circle cx="13.5" cy="13.6" r="4.6" fill="${gc}"/>` : ""}</svg>`;
	const g = o.glyph;
	if (g instanceof URL || (typeof g === "string" && /^(https?:|data:|\/|\.)/.test(g))) { const img = el("img", `position:absolute;left:${w / 2}px;top:${13.6 * s}px;width:${12 * s}px;height:${12 * s}px;transform:translate(-50%,-50%)`) as HTMLImageElement; img.src = String(g); box.appendChild(img); }
	else if (g != null && typeof g === "object") { const c = el("div", `position:absolute;left:${w / 2}px;top:${13.6 * s}px;transform:translate(-50%,-50%)`); c.appendChild(g as Element); box.appendChild(c); }
	else if (g != null || o.label != null) { const t = el("div", `position:absolute;left:0;right:0;top:${13.6 * s}px;transform:translateY(-50%);text-align:center;font:500 ${14 * s}px Roboto,Arial,sans-serif;color:${o.glyphColor ?? "#fff"}`); t.textContent = String(g ?? o.label); box.appendChild(t); }
	return box;
}

/** google.maps.marker.PinElement */
export class PinElement {
	element: HTMLElement;
	constructor(o: { background?: string; borderColor?: string; glyphColor?: string; glyph?: string | Element | URL | null; glyphText?: string; scale?: number } = {}) { this.element = pinSvg({ ...o, glyph: o.glyphText ?? o.glyph }); }
}

// A legacy icon / label → { element, anchor/offset for MapLibre, the height above the position (where an InfoWindow sits) }
type Built = { element: HTMLElement; anchor: string; offset: [number, number]; top: number };
function buildLegacy(icon: any, label: any): Built {
	const lab = label == null ? null : typeof label === "string" ? { text: label } : label;
	const labelEl = (cx: number, cy: number): HTMLElement => {
		const t = el("div", `position:absolute;left:${cx}px;top:${cy}px;transform:translate(-50%,-50%);white-space:nowrap;pointer-events:none;font-family:${lab.fontFamily ?? "Roboto,Arial,sans-serif"};font-size:${lab.fontSize ?? "14px"};font-weight:${lab.fontWeight ?? "normal"};color:${lab.color ?? "black"}`);
		if (lab.className) t.className = lab.className;
		t.textContent = lab.text;
		return t;
	};
	if (icon == null) {   // the default pin; a label is written into its head
		const e = pinSvg(lab ? { label: "" } : {});
		if (lab) e.appendChild(labelEl(13.5, 13.6));
		return { element: e, anchor: "bottom", offset: [0, 0], top: 43 };
	}
	if (typeof icon === "string") icon = { url: icon };
	if (icon.path != null) {   // Symbol: an SVG path around the anchor (0,0 by default), stroke not scaled
		const s = icon.scale ?? 1, a = icon.anchor ?? { x: 0, y: 0 }, d = typeof icon.path === "number" ? SYMBOL_D[icon.path] : icon.path;
		const box = el("div", "position:relative;width:0;height:0;overflow:visible;cursor:pointer");
		const open = icon.path === SymbolPath.FORWARD_OPEN_ARROW || icon.path === SymbolPath.BACKWARD_OPEN_ARROW;
		box.innerHTML = `<svg xmlns="${SVGNS}" width="1" height="1" style="position:absolute;left:0;top:0;overflow:visible"><g transform="rotate(${+(icon.rotation ?? 0)}) scale(${+s}) translate(${-a.x},${-a.y})"><path d="${esc(d)}" fill="${open ? "none" : esc(icon.fillColor ?? "black")}" fill-opacity="${+(icon.fillOpacity ?? 0)}" stroke="${esc(icon.strokeColor ?? icon.fillColor ?? "black")}" stroke-opacity="${+(icon.strokeOpacity ?? 1)}" stroke-width="${+(icon.strokeWeight ?? 1)}" vector-effect="non-scaling-stroke"/></g></svg>`;
		if (lab) box.appendChild(labelEl((icon.labelOrigin?.x ?? 0) * s, (icon.labelOrigin?.y ?? 0) * s));
		return { element: box, anchor: "top-left", offset: [0, 0], top: s * 2 };
	}
	const sz: Size | undefined = icon.scaledSize ?? icon.size;
	const w = sz?.width, h = sz?.height;
	const box = el("div", `position:relative;cursor:pointer;line-height:0${w != null ? `;width:${w}px;height:${h}px` : ""}`);
	const img = el("img", `display:block;${w != null ? `width:${w}px;height:${h}px` : ""}`) as HTMLImageElement;
	img.src = icon.url; img.draggable = false; box.appendChild(img);
	if (lab) box.appendChild(labelEl(icon.labelOrigin?.x ?? (w ?? 0) / 2, icon.labelOrigin?.y ?? (h ?? 0) / 2));
	if (icon.anchor) return { element: box, anchor: "top-left", offset: [-icon.anchor.x, -icon.anchor.y], top: icon.anchor.y };
	return { element: box, anchor: "bottom", offset: [0, 0], top: h ?? 32 };
}

/** the MapLibre marker under a Google marker: attach/detach, position, drag, DOM events */
abstract class MarkerBase extends MVCObject {
	protected _map: GMap | null = null;
	protected _pos: LatLng | null = null;
	protected _mk: any = null;
	protected _built: Built | null = null;
	protected _draggable = false;
	protected abstract _build(): Built;
	protected abstract _style(e: HTMLElement): void;
	protected _clickable(): boolean { return true; }
	_anchorHeight(): number { return this._built?.top ?? 43; }
	protected _attach(): void {
		const map = this._map;
		if (!map || !this._pos || typeof document === "undefined") return;
		const b = this._built = this._build(), e = b.element;
		this._style(e);
		const fire = (name: string, ev: Event): void => {
			if (!this._clickable()) return;
			OVERLAY_EVENTS.add(ev);
			event.trigger(this, name, { latLng: this._pos, domEvent: ev, stop: () => ev.stopPropagation() });
		};
		e.addEventListener("click", ev => { fire("click", ev); fire("gmp-click", ev); });
		e.addEventListener("dblclick", ev => fire("dblclick", ev));
		e.addEventListener("contextmenu", ev => fire("rightclick", ev));
		e.addEventListener("mouseover", ev => fire("mouseover", ev));
		e.addEventListener("mouseout", ev => fire("mouseout", ev));
		e.addEventListener("mousedown", ev => fire("mousedown", ev));
		e.addEventListener("mouseup", ev => fire("mouseup", ev));
		const mk = this._mk = new map._ctx.ml.Marker({ element: e, anchor: b.anchor, offset: b.offset, draggable: this._draggable });
		mk.setLngLat(toLngLat(this._pos)).addTo(map.getMapLibre());
		const drag = (name: string) => () => {
			const ll = mk.getLngLat();
			if (ll) this._pos = fromLngLat(ll);
			if (name === "drag") event.trigger(this, "position_changed");
			event.trigger(this, name, { latLng: this._pos });
		};
		mk.on?.("dragstart", drag("dragstart")); mk.on?.("drag", drag("drag")); mk.on?.("dragend", drag("dragend"));
	}
	protected _detach(): void { this._mk?.remove(); this._mk = null; this._built = null; }
	protected _rebuild(): void { if (this._mk) { this._detach(); this._attach(); } }
	protected _setMap(m: GMap | null): void {
		if (m === this._map) return;
		this._detach(); this._map = m; this._attach();
		event.trigger(this, "map_changed");
	}
	protected _setPos(p: LatLngLike | null | undefined): void {
		this._pos = p == null ? null : toLatLng(p);
		if (!this._pos) this._detach();
		else if (this._mk) this._mk.setLngLat(toLngLat(this._pos));
		else this._attach();
		event.trigger(this, "position_changed");
	}
	protected _setDraggable(d: boolean): void { this._draggable = !!d; this._mk?.setDraggable?.(this._draggable); event.trigger(this, "draggable_changed"); }
}

/** google.maps.Marker (deprecated by Google, still the most common code) */
export class Marker extends MarkerBase {
	static MAX_ZINDEX = 1000000;
	#o: Record<string, any>;
	constructor(opts: Record<string, any> = {}) {
		super();
		this.#o = { visible: true, clickable: true, opacity: 1, ...opts };
		this._draggable = !!opts.draggable;
		this._pos = opts.position ? toLatLng(opts.position) : null;
		if (opts.animation) unsupported("Marker animation");
		if (opts.map) this.setMap(opts.map);
	}
	protected _build(): Built { return buildLegacy(this.#o.icon, this.#o.label); }
	protected _clickable(): boolean { return this.#o.clickable !== false; }
	protected _style(e: HTMLElement): void {
		const o = this.#o;
		e.title = o.title ?? "";
		e.style.display = o.visible === false ? "none" : "";
		e.style.opacity = String(o.opacity ?? 1);
		if (o.zIndex != null) e.style.zIndex = String(o.zIndex);
		e.style.cursor = o.cursor ?? (o.clickable === false && !this._draggable ? "default" : "pointer");
		if (o.clickable === false) e.style.pointerEvents = this._draggable ? "" : "none";
	}
	#restyle(): void { if (this._built) this._style(this._built.element); }
	setMap(m: GMap | null): void { this._setMap(m); }
	getMap(): GMap | null { return this._map; }
	setPosition(p: LatLngLike | null): void { this._setPos(p); }
	getPosition(): LatLng | null { return this._pos; }
	setDraggable(d: boolean): void { this._setDraggable(d); }
	getDraggable(): boolean { return this._draggable; }
	setTitle(t: string): void { this.#o.title = t; this.#restyle(); event.trigger(this, "title_changed"); }
	getTitle(): string | undefined { return this.#o.title; }
	setLabel(l: unknown): void { this.#o.label = l; this._rebuild(); event.trigger(this, "label_changed"); }
	getLabel(): unknown { return this.#o.label; }
	setIcon(i: unknown): void { this.#o.icon = i; this._rebuild(); event.trigger(this, "icon_changed"); }
	getIcon(): unknown { return this.#o.icon; }
	setVisible(v: boolean): void { this.#o.visible = v; this.#restyle(); event.trigger(this, "visible_changed"); }
	getVisible(): boolean { return this.#o.visible !== false; }
	setOpacity(v: number | null): void { this.#o.opacity = v ?? 1; this.#restyle(); }
	getOpacity(): number { return this.#o.opacity; }
	setZIndex(z: number | null): void { this.#o.zIndex = z; this.#restyle(); event.trigger(this, "zindex_changed"); }
	getZIndex(): number | undefined { return this.#o.zIndex; }
	setClickable(c: boolean): void { this.#o.clickable = c; this.#restyle(); }
	getClickable(): boolean { return this.#o.clickable !== false; }
	setCursor(c: string): void { this.#o.cursor = c; this.#restyle(); }
	setAnimation(a: unknown): void { if (a) unsupported("Marker animation"); }
	getAnimation(): null { return null; }
	setOptions(o: Record<string, any> = {}): void {
		const { map, position, draggable, ...rest } = o;
		Object.assign(this.#o, rest);
		if ("icon" in rest || "label" in rest) this._rebuild(); else this.#restyle();
		if (draggable !== undefined) this.setDraggable(draggable);
		if (position !== undefined) this.setPosition(position);
		if (map !== undefined) this.setMap(map);
	}
}

/** google.maps.marker.AdvancedMarkerElement: properties instead of setters; content is any element (default: a PinElement) */
export class AdvancedMarkerElement extends MarkerBase {
	#content: HTMLElement | null = null; #title = ""; #zIndex: number | null = null; #clickable = true;
	/** the element of this marker (Google's AdvancedMarkerElement is itself an HTMLElement) */
	readonly element: HTMLElement | null = typeof document !== "undefined" ? el("div", "cursor:pointer") : null;
	constructor(o: Record<string, any> = {}) {
		super();
		this.#content = o.content ?? null; this.#title = o.title ?? ""; this.#zIndex = o.zIndex ?? null;
		this._draggable = !!(o.gmpDraggable ?? o.draggable); this.#clickable = o.gmpClickable !== false;
		this._pos = o.position ? toLatLng(o.position) : null;
		if (o.collisionBehavior && o.collisionBehavior !== CollisionBehavior.REQUIRED) unsupported("AdvancedMarkerElement.collisionBehavior");
		if (o.map) this.map = o.map;
	}
	protected _build(): Built {
		const box = this.element!;
		box.replaceChildren(this.#content ?? new PinElement().element);
		return { element: box, anchor: "bottom", offset: [0, 0], top: this.#content ? (this.#content.offsetHeight || 43) : 43 };
	}
	protected _clickable(): boolean { return this.#clickable; }
	protected _style(e: HTMLElement): void { e.title = this.#title; e.style.zIndex = this.#zIndex == null ? "" : String(this.#zIndex); }
	get map(): GMap | null { return this._map; }
	set map(m: GMap | null) { this._setMap(m ?? null); }
	setMap(m: GMap | null): void { this.map = m; }
	get position(): LatLng | null { return this._pos; }
	set position(p: LatLngLike | null) { this._setPos(p); }
	get content(): HTMLElement | null { return this.#content; }
	set content(c: HTMLElement | null) { this.#content = c; this._rebuild(); }
	get title(): string { return this.#title; }
	set title(t: string) { this.#title = t; if (this._built) this._style(this._built.element); }
	get zIndex(): number | null { return this.#zIndex; }
	set zIndex(z: number | null) { this.#zIndex = z; if (this._built) this._style(this._built.element); }
	get gmpDraggable(): boolean { return this._draggable; }
	set gmpDraggable(d: boolean) { this._setDraggable(d); }
	get gmpClickable(): boolean { return this.#clickable; }
	set gmpClickable(c: boolean) { this.#clickable = c; }
	/** DOM-style listeners ("gmp-click", "click", …) on the marker element */
	addEventListener(name: string, fn: (e: Event) => void, o?: AddEventListenerOptions): void {
		if (name === "gmp-click") { event.addListener(this, "gmp-click", (e: { domEvent: Event }) => fn(e.domEvent)); return; }
		this.element?.addEventListener(name, fn, o);
	}
	removeEventListener(name: string, fn: (e: Event) => void, o?: EventListenerOptions): void { this.element?.removeEventListener(name, fn, o); }
}

type Anchor = { getPosition?(): LatLng | null; position?: LatLng | null; getMap?(): GMap | null; map?: GMap | null; _anchorHeight?(): number };

/** google.maps.InfoWindow on a MapLibre Popup (anchored above a marker, or at a position) */
export class InfoWindow extends MVCObject {
	#o: Record<string, any>; #pp: any = null; #map: GMap | null = null; #anchor: Anchor | null = null; #anchorSub: { remove(): void } | null = null; #closing = false;
	constructor(opts: Record<string, any> = {}) { super(); this.#o = { ...opts }; if (opts.position) this.#o.position = toLatLng(opts.position); }
	get isOpen(): boolean { return !!this.#pp; }
	#offset(): [number, number] {
		const po: Size | undefined = this.#o.pixelOffset;
		return [po?.width ?? 0, (po?.height ?? 0) - (this.#anchor ? (this.#anchor._anchorHeight?.() ?? 43) : 0)];
	}
	#where(): LatLng | null { const a = this.#anchor; return a ? (a.getPosition?.() ?? a.position ?? null) : this.#o.position ?? null; }
	#fill(): void {
		const c = this.#o.content, pp = this.#pp;
		if (!pp) return;
		const head = this.#o.headerContent;
		if (c == null && head == null) { pp.setHTML(""); return; }
		if (head == null && typeof c === "string") { pp.setHTML(c); return; }
		const box = document.createElement("div");
		for (const part of [head, c]) {
			if (part == null) continue;
			if (typeof part === "string") { const d = document.createElement("div"); d.innerHTML = part; box.appendChild(d); }
			else box.appendChild(part);
		}
		pp.setDOMContent(box);
	}
	open(a?: GMap | { map?: GMap | null; anchor?: Anchor | null; shouldFocus?: boolean } | null, anchor?: Anchor | null): void {
		let map: GMap | null | undefined;
		if (a && !(a as GMap).getMapLibre && ("map" in a || "anchor" in a)) { map = (a as { map?: GMap | null }).map; anchor = (a as { anchor?: Anchor | null }).anchor; }
		else map = a as GMap | null | undefined;
		this.#anchorSub?.remove(); this.#anchorSub = null;
		this.#anchor = anchor ?? null;
		map = map ?? anchor?.getMap?.() ?? anchor?.map ?? null;
		const where = this.#where();
		if (!map || !where || typeof document === "undefined") return;
		if (this.#pp && this.#map !== map) this.close();
		this.#map = map;
		if (!this.#pp) {
			const pp = this.#pp = new map._ctx.ml.Popup({ closeButton: true, closeOnClick: false, anchor: "bottom", maxWidth: this.#o.maxWidth ? `${this.#o.maxWidth}px` : "648px", offset: this.#offset() });
			pp.on?.("close", () => {
				if (this.#pp !== pp) return;
				this.#pp = null; this.#anchorSub?.remove(); this.#anchorSub = null;
				if (!this.#closing) event.trigger(this, "closeclick");
				event.trigger(this, "close");
			});
			this.#fill();
			pp.setLngLat(toLngLat(where)).addTo(map.getMapLibre());
			if (this.#o.zIndex != null) pp.getElement?.()?.style.setProperty("z-index", String(this.#o.zIndex));
		} else { setOffset(this.#pp, this.#offset()); this.#pp.setLngLat(toLngLat(where)); }
		if (this.#anchor) this.#anchorSub = event.addListener(this.#anchor, "position_changed", () => { const p = this.#where(); if (p && this.#pp) this.#pp.setLngLat(toLngLat(p)); });
		setTimeout(() => event.trigger(this, "domready"), 0);
		event.trigger(this, "visible");
	}
	close(): void { if (!this.#pp) return; this.#closing = true; try { this.#pp.remove(); } finally { this.#closing = false; } this.#pp = null; }
	focus(): void { (this.#pp?.getElement?.()?.querySelector("button, a, [tabindex]") as HTMLElement | null)?.focus(); }
	getContent(): unknown { return this.#o.content; }
	setContent(c: unknown): void { this.#o.content = c; this.#fill(); event.trigger(this, "content_changed"); }
	getHeaderContent(): unknown { return this.#o.headerContent; }
	setHeaderContent(c: unknown): void { this.#o.headerContent = c; this.#fill(); }
	getPosition(): LatLng | null { return this.#where(); }
	setPosition(p: LatLngLike | null): void { this.#o.position = p ? toLatLng(p) : null; this.#anchor = null; this.#anchorSub?.remove(); if (this.#pp && p) { setOffset(this.#pp, this.#offset()); this.#pp.setLngLat(toLngLat(p)); } event.trigger(this, "position_changed"); }
	getZIndex(): number | undefined { return this.#o.zIndex; }
	setZIndex(z: number): void { this.#o.zIndex = z; this.#pp?.getElement?.()?.style.setProperty("z-index", String(z)); event.trigger(this, "zindex_changed"); }
	setOptions(o: Record<string, any> = {}): void {
		const { content, position, zIndex, ...rest } = o;
		Object.assign(this.#o, rest);
		if (content !== undefined) this.setContent(content);
		if (position !== undefined) this.setPosition(position);
		if (zIndex !== undefined) this.setZIndex(zIndex);
		if (rest.pixelOffset && this.#pp) setOffset(this.#pp, this.#offset());
	}
}
const setOffset = (pp: any, o: [number, number]): void => { pp.setOffset?.(o); };
