// L.Icon, L.Icon.Default, L.DivIcon and L.Marker on a MapLibre Marker. The icon is built exactly as Leaflet builds it (an <img> or <div>
//   with negative margins at its iconAnchor), inside a 0×0 holder that MapLibre places at the latlng: custom createIcon() keeps working.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Class, Handler, Browser, define, setOptions } from "./core.ts";
import { LatLng, toLatLng, toPoint, latLngToCoords, getFeature, SphericalMercator } from "./geo.ts";
import { DomUtil } from "./dom.ts";
import { Layer } from "./layer.ts";

export class Icon extends Class {
	initialize(options?: any): void { setOptions(this, options); }
	createIcon(oldIcon?: HTMLElement): HTMLElement { return this._createIcon("icon", oldIcon)!; }
	createShadow(oldIcon?: HTMLElement): HTMLElement | null { return this._createIcon("shadow", oldIcon); }
	_createIcon(name: string, oldIcon?: any): HTMLElement | null {
		const src = this._getIconUrl(name);
		if (!src) { if (name === "icon") throw new Error("iconUrl not set in Icon options (see the docs)."); return null; }
		const img = this._createImg(src, oldIcon && oldIcon.tagName === "IMG" ? oldIcon : null);
		this._setIconStyles(img, name);
		if (this.options.crossOrigin || this.options.crossOrigin === "") (img as HTMLImageElement).crossOrigin = this.options.crossOrigin === true ? "" : this.options.crossOrigin;
		return img;
	}
	_setIconStyles(img: HTMLElement, name: string): void {
		const o = this.options;
		let sizeOption = o[`${name}Size`];
		if (typeof sizeOption === "number") sizeOption = [sizeOption, sizeOption];
		const size = toPoint(sizeOption), anchor = toPoint((name === "shadow" && o.shadowAnchor) || o.iconAnchor || (size && size.divideBy(2).round()));
		img.className = `leaflet-marker-${name} ${o.className || ""}`;
		if (anchor) { img.style.marginLeft = `${-anchor.x}px`; img.style.marginTop = `${-anchor.y}px`; }
		if (size) { img.style.width = `${size.x}px`; img.style.height = `${size.y}px`; }
	}
	_createImg(src: string, el?: any): HTMLElement { el = el || document.createElement("img"); el.src = src; return el; }
	_getIconUrl(name: string): string | undefined { return (Browser.retina && this.options[`${name}RetinaUrl`]) || this.options[`${name}Url`]; }
}
define(Icon, { options: { popupAnchor: [0, 0], tooltipAnchor: [0, 0], crossOrigin: false } });

// Leaflet's blue pin (25 × 41) and its shadow, drawn here as SVG so no image files have to be served
const svgUrl = (s: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
const PIN = svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="25" height="41" viewBox="0 0 25 41"><defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#2e85cb"/><stop offset="1" stop-color="#1a6eb5"/></linearGradient></defs><path d="M12.5.6C5.9.6.6 5.8.6 12.4c0 2.4.7 4.6 1.9 6.5L12.5 40.4l10-21.5c1.2-1.9 1.9-4.1 1.9-6.5C24.4 5.8 19.1.6 12.5.6z" fill="url(#g)" stroke="#2b6596" stroke-width="1.1"/><circle cx="12.5" cy="12.4" r="4.6" fill="#fff"/></svg>`);
const SHADOW = svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="41" height="41" viewBox="0 0 41 41"><ellipse cx="20" cy="33" rx="12" ry="5.5" transform="rotate(-25 20 33) skewX(-35)" fill="#000" fill-opacity=".22"/></svg>`);

/** L.Icon.Default: Leaflet's blue marker. `L.Icon.Default.mergeOptions({ iconUrl, shadowUrl })` and imagePath work as in Leaflet */
export class IconDefault extends Icon {
	static imagePath?: string;
	_getIconUrl(name: string): string | undefined {
		const url = Icon.prototype._getIconUrl.call(this, name), path = this.options.imagePath || IconDefault.imagePath;
		return path && url && !/^(data:|blob:|https?:|\/)/.test(url) ? path + url : url;
	}
}
define(IconDefault, { options: { iconUrl: PIN, iconRetinaUrl: PIN, shadowUrl: SHADOW, iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], tooltipAnchor: [16, -28], shadowSize: [41, 41] } });

/** L.DivIcon: your HTML (string or element) as the icon */
export class DivIcon extends Icon {
	createIcon(oldIcon?: any): HTMLElement {
		const div = oldIcon && oldIcon.tagName === "DIV" ? oldIcon : document.createElement("div"), o = this.options;
		if (o.html && typeof o.html === "object" && o.html.nodeType) { DomUtil.empty(div); div.appendChild(o.html); }
		else div.innerHTML = o.html !== false ? o.html : "";
		if (o.bgPos) { const p = toPoint(o.bgPos)!; div.style.backgroundPosition = `${-p.x}px ${-p.y}px`; }
		this._setIconStyles(div, "icon");
		return div;
	}
	createShadow(): null { return null; }
}
define(DivIcon, { options: { iconSize: [12, 12], html: false, bgPos: null, className: "leaflet-div-icon" } });

const DOM_EVENTS = ["click", "dblclick", "mousedown", "mouseup", "mouseover", "mouseout", "contextmenu"];

/** marker.dragging: the MapLibre Marker's own drag */
class MarkerDrag extends Handler {
	initialize(marker: any): void { this._marker = marker; }
	addHooks(): void { this._marker.options.draggable = true; this._marker._mk?.setDraggable?.(true); }
	removeHooks(): void { this._marker.options.draggable = false; this._marker._mk?.setDraggable?.(false); }
	moved(): boolean { return !!this._marker._dragMoved; }
}

/** L.Marker on a MapLibre Marker */
export class Marker extends Layer {
	initialize(latlng: any, options?: any): void {
		setOptions(this, options);
		this._latlng = toLatLng(latlng);
		this.dragging = new MarkerDrag(this);
		if (this.options.draggable) this.dragging._enabled = true;
	}
	onAdd(map: any): void { this._initIcon(); this.update(); }
	onRemove(): void { this._removeIcon(); }
	getEvents(): Record<string, unknown> { return {}; }
	getLatLng(): LatLng { return this._latlng; }
	setLatLng(latlng: any): this { const old = this._latlng; this._latlng = toLatLng(latlng); this.update(); return this.fire("move", { oldLatLng: old, latlng: this._latlng }); }
	setZIndexOffset(offset: number): this { this.options.zIndexOffset = offset; return this.update(); }
	getIcon(): any { return this.options.icon; }
	setIcon(icon: any): this {
		this.options.icon = icon;
		if (this._map) { this._initIcon(); this.update(); }
		if (this._popup) this.bindPopup(this._popup, this._popup.options);
		return this;
	}
	getElement(): HTMLElement | undefined { return this._icon; }
	update(): this { if (this._mk && this._latlng) { this._mk.setLngLat([this._latlng.lng, this._latlng.lat]); this._updateZIndex(0); } return this; }
	setOpacity(opacity: number): this { this.options.opacity = opacity; if (this._holder) this._holder.style.opacity = String(opacity); return this; }
	toGeoJSON(precision?: number | false): any { return getFeature(this, { type: "Point", coordinates: latLngToCoords(this.getLatLng(), precision) }); }
	_getPopupAnchor(): any { return this.options.icon.options.popupAnchor; }
	_getTooltipAnchor(): any { return this.options.icon.options.tooltipAnchor; }
	_bringToFront(): void { this._updateZIndex(1e5); }
	_resetZIndex(): void { this._updateZIndex(0); }
	/** Leaflet's stacking: southern markers above northern ones, plus zIndexOffset */
	_updateZIndex(offset: number): void {
		if (!this._holder || !this._latlng) return;
		const y = (1 - (SphericalMercator.project(this._latlng).y / (SphericalMercator.R * Math.PI) + 1) / 2) * 262144;
		this._holder.style.zIndex = String(Math.round(y) + (this.options.zIndexOffset || 0) + offset);
	}
	_initIcon(): void {
		const o = this.options, map = this._map;
		this._removeIcon();
		const icon = this._icon = o.icon.createIcon();
		DomUtil.addClass(icon, "leaflet-marker-icon");
		if (o.interactive) DomUtil.addClass(icon, "leaflet-interactive");
		if (o.keyboard) { (icon as any).tabIndex = "0"; icon.setAttribute?.("role", "button"); }
		if (o.title) icon.title = o.title;
		if (icon.tagName === "IMG") (icon as HTMLImageElement).alt = o.alt || "";
		icon.style.position = "absolute"; icon.style.left = "0"; icon.style.top = "0";
		const shadow = this._shadow = o.icon.createShadow();
		if (shadow) { DomUtil.addClass(shadow, "leaflet-marker-shadow"); (shadow as any).alt = ""; shadow.style.position = "absolute"; shadow.style.left = "0"; shadow.style.top = "0"; shadow.style.pointerEvents = "none"; }
		const holder = this._holder = document.createElement("div");
		holder.className = "leaflet-marker-holder";
		holder.style.cssText = "width:0;height:0;overflow:visible";
		if (shadow) holder.appendChild(shadow);
		holder.appendChild(icon);
		if (o.opacity < 1) holder.style.opacity = String(o.opacity);
		if (o.interactive) for (const t of DOM_EVENTS) icon.addEventListener(t, (ev: Event) => this._onDom(t, ev));
		if (o.keyboard) icon.addEventListener("keypress", (ev: any) => { if (ev.keyCode === 13 || ev.key === "Enter") this._onDom("click", ev); });
		if (o.riseOnHover) { icon.addEventListener("mouseover", () => this._updateZIndex(o.riseOffset)); icon.addEventListener("mouseout", () => this._updateZIndex(0)); }
		const mk = this._mk = new map._ctx.ml.Marker({ element: holder, anchor: "top-left", draggable: !!o.draggable });
		mk.setLngLat([this._latlng.lng, this._latlng.lat]).addTo(map._ml);
		mk.on?.("dragstart", () => { this._dragMoved = false; this._dragStart = this._latlng; this.fire("movestart").fire("dragstart"); });
		mk.on?.("drag", () => {
			const ll = mk.getLngLat(), old = this._latlng;
			if (!ll) return;
			this._dragMoved = true;
			this._latlng = new LatLng(ll.lat, ll.lng);
			this._updateZIndex(0);
			this.fire("move", { oldLatLng: old, latlng: this._latlng }).fire("drag", { oldLatLng: old, latlng: this._latlng });
		});
		mk.on?.("dragend", () => { this.fire("moveend").fire("dragend", { distance: this._dragStart && this._map ? this._map.latLngToContainerPoint(this._dragStart).distanceTo(this._map.latLngToContainerPoint(this._latlng)) : 0 }); });
	}
	_onDom(type: string, ev: any): void {
		if (type === "click" && this._dragMoved) { this._dragMoved = false; return; }   // the click a drag ends with
		this._map?._overlayMouse(this, type, ev);
	}
	_removeIcon(): void { this._mk?.remove(); this._mk = null; this._holder = null; }
}
define(Marker, { options: { icon: new IconDefault(), interactive: true, keyboard: true, title: "", alt: "Marker", zIndexOffset: 0, opacity: 1, riseOnHover: false, riseOffset: 250, pane: "markerPane", shadowPane: "shadowPane", bubblingMouseEvents: false, autoPanOnFocus: true, draggable: false, autoPan: false, autoPanPadding: [50, 50], autoPanSpeed: 10 } });
