// L.Popup and L.Tooltip on MapLibre Popups, the bindPopup / bindTooltip family on every Layer, and map.openPopup / openTooltip.
//   Behavior follows Leaflet: popups close on a map click ("preclick"), opening one closes the open one (autoClose),
//   a marker's popup toggles on its click; tooltips open on mouseover (or stay, permanent) and follow the mouse when sticky.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Util, define, setOptions } from "./core.ts";
import { LatLng, toLatLng, toPoint } from "./geo.ts";
import { DomEvent } from "./dom.ts";
import { Layer, FeatureGroup } from "./layer.ts";
import { LMap, toLngLat } from "./map.ts";

/** what Popup and Tooltip share: content, position, the MapLibre Popup underneath */
export class DivOverlay extends Layer {
	initialize(options?: any, source?: any): void {
		if (options && (options instanceof LatLng || Array.isArray(options))) { this._latlng = toLatLng(options); setOptions(this, source); }
		else { setOptions(this, options); this._source = source; }
		if (this.options.content) this._content = this.options.content;
	}
	openOn(map?: any): this { map = map || this._source._map; if (!map.hasLayer(this)) map.addLayer(this); return this; }
	close(): this { this._map?.removeLayer(this); return this; }
	toggle(layer?: any): this {
		if (this._map) this.close();
		else { if (layer) this._source = layer; else layer = this._source; this._prepareOpen(); this.openOn(layer._map); }
		return this;
	}
	onAdd(map: any): void { this._contentNode ||= document.createElement("div"); this._makeMl(map); this.update(); }
	onRemove(map?: any): void { this._removeMl(); }
	getLatLng(): LatLng { return this._latlng; }
	setLatLng(latlng: any): this { this._latlng = toLatLng(latlng); if (this._map) { this._updatePosition(); this._adjustPan(); } return this; }
	getContent(): any { return this._content; }
	setContent(content: any): this { this._content = content; this.update(); return this; }
	getElement(): HTMLElement | undefined { return this._mlp?.getElement?.(); }
	update(): void { if (!this._map) return; this._updateContent(); this._updateLayout(); this._updatePosition(); this._adjustPan(); }
	isOpen(): boolean { return !!this._map && this._map.hasLayer(this); }
	bringToFront(): this { const e = this.getElement(); if (e) e.style.zIndex = String(+e.style.zIndex + 1); return this; }
	bringToBack(): this { const e = this.getElement(); if (e) e.style.zIndex = String(+e.style.zIndex - 1); return this; }
	_prepareOpen(latlng?: any): boolean {
		let source = this._source;
		if (!source?._map) return false;
		if (source instanceof FeatureGroup) {
			source = null;
			const layers = (this._source as any)._layers;
			for (const id in layers) if (layers[id]._map) { source = layers[id]; break; }
			if (!source) return false;
			this._source = source;
		}
		if (!latlng) {
			if (source.getCenter) latlng = source.getCenter();
			else if (source.getLatLng) latlng = source.getLatLng();
			else if (source.getBounds) latlng = source.getBounds().getCenter();
			else throw new Error("Unable to get source layer LatLng.");
		}
		this.setLatLng(latlng);
		if (this._map) this.update();
		return true;
	}
	_updateContent(): void {
		const node = this._contentNode;
		if (!node) return;
		const c = typeof this._content === "function" ? this._content(this._source || this) : this._content;
		if (typeof c === "string") node.innerHTML = c;
		else node.replaceChildren(...(c != null ? [c] : []));
		this.fire("contentupdate");
	}
	_updateLayout(): void {}
	_adjustPan(): void {}
	_updatePosition(): void { if (this._mlp && this._latlng) { this._mlp.setLngLat(toLngLat(this._latlng)); this._mlp.setOffset?.(this._mlOffset()); } }
	_getAnchor(): any { return toPoint(this._source && this._source._getPopupAnchor ? this._source._getPopupAnchor() : [0, 0]); }
	_mlOffset(): [number, number] { return [0, 0]; }
	_mlOptions(): Record<string, unknown> { return {}; }
	_makeMl(map: any): void {
		this._removeMl();
		const p = this._mlp = new map._ctx.ml.Popup({ closeOnClick: false, closeOnMove: false, focusAfterOpen: false, maxWidth: "none", offset: this._mlOffset(), ...this._mlOptions() });
		p.setDOMContent(this._contentNode);
		if (this._latlng) p.setLngLat(toLngLat(this._latlng));
		p.addTo(map._ml);
		p.on?.("close", () => { if (!this._closing && this._map) this.close(); });
		const e = p.getElement?.();
		if (e) e.style.zIndex = String(this._z);
	}
	_removeMl(): void { if (!this._mlp) return; this._closing = true; this._mlp.remove(); this._mlp = null; this._closing = false; }
}
define(DivOverlay, { options: { interactive: false, offset: [0, 0], className: "", pane: undefined, content: "" }, _z: 1e6 });

export class Popup extends DivOverlay {
	openOn(map?: any): this {
		map = map || this._source._map;
		if (!map.hasLayer(this) && map._popup && map._popup.options.autoClose) map.removeLayer(map._popup);
		map._popup = this;
		return super.openOn(map);
	}
	onAdd(map: any): void {
		super.onAdd(map);
		map.fire("popupopen", { popup: this });
		if (this._source) {
			this._source.fire("popupopen", { popup: this }, true);
			if (!this._source._isPath) this._source.on("preclick", DomEvent.stopPropagation);
		}
	}
	onRemove(map: any): void {
		super.onRemove(map);
		map.fire("popupclose", { popup: this });
		if (this._source) {
			this._source.fire("popupclose", { popup: this }, true);
			if (!this._source._isPath) this._source.off("preclick", DomEvent.stopPropagation);
		}
	}
	getEvents(): Record<string, unknown> {
		const closeOnClick = this.options.closeOnClick !== undefined ? this.options.closeOnClick : this._map.options.closePopupOnClick;
		return closeOnClick ? { preclick: this.close } : {};
	}
	_mlOptions(): Record<string, unknown> { return { closeButton: this.options.closeButton !== false, anchor: "bottom", className: `leaflet-popup ${this.options.className || ""}`.trim() }; }
	// Leaflet's tip points at the latlng + offset (+ the marker's popupAnchor); its default offset [0, 7] is the tip's own height
	_mlOffset(): [number, number] { const a = this._getAnchor(), o = toPoint(this.options.offset)!; return [o.x + a.x, o.y - 7 + a.y]; }
	_updateLayout(): void {
		const s = this._contentNode.style, o = this.options;
		this._contentNode.className = "leaflet-popup-content";
		s.maxWidth = `${o.maxWidth}px`; s.minWidth = `${o.minWidth}px`;
		if (o.maxHeight) { s.maxHeight = `${o.maxHeight}px`; s.overflowY = "auto"; }
	}
	/** autoPan: pan the map so the popup is inside the container (autoPanPadding) */
	_adjustPan(): void {
		if (!this.options.autoPan || !this._map?._loaded) return;
		const map = this._map, el = this.getElement();
		if (!el?.getBoundingClientRect) return;
		Util.requestAnimFrame(() => {
			if (!this._mlp) return;
			const r = el.getBoundingClientRect(), c = map.getContainer().getBoundingClientRect(), size = map.getSize();
			if (!r.width || !c.width) return;
			const tl = toPoint(this.options.autoPanPaddingTopLeft || this.options.autoPanPadding)!, br = toPoint(this.options.autoPanPaddingBottomRight || this.options.autoPanPadding)!;
			const x = r.left - c.left, y = r.top - c.top;
			let dx = 0, dy = 0;
			if (x + r.width + br.x > size.x) dx = x + r.width - size.x + br.x;
			if (x - dx - tl.x < 0) dx = x - tl.x;
			if (y + r.height + br.y > size.y) dy = y + r.height - size.y + br.y;
			if (y - dy - tl.y < 0) dy = y - tl.y;
			if (dx || dy) { if (this.options.keepInView) this._autopanning = true; map.fire("autopanstart").panBy([dx, dy]); }
		});
	}
}
define(Popup, { options: { pane: "popupPane", offset: [0, 7], maxWidth: 300, minWidth: 50, maxHeight: null, autoPan: true, autoPanPaddingTopLeft: null, autoPanPaddingBottomRight: null, autoPanPadding: [5, 5], keepInView: false, closeButton: true, autoClose: true, closeOnEscapeKey: true, className: "" } });

// Leaflet tooltip direction → [MapLibre anchor, the 6 px gap Leaflet's CSS puts between the point and the tooltip]
const DIR: Record<string, [string, number, number]> = { right: ["left", 6, 0], left: ["right", -6, 0], top: ["bottom", 0, -6], bottom: ["top", 0, 6], center: ["center", 0, 0] };
export class Tooltip extends DivOverlay {
	onAdd(map: any): void {
		super.onAdd(map);
		this.setOpacity(this.options.opacity);
		map.fire("tooltipopen", { tooltip: this });
		this._source?.fire("tooltipopen", { tooltip: this }, true);
	}
	onRemove(map: any): void {
		super.onRemove(map);
		map.fire("tooltipclose", { tooltip: this });
		this._source?.fire("tooltipclose", { tooltip: this }, true);
	}
	getEvents(): Record<string, unknown> { return {}; }
	setOpacity(opacity: number): void { this.options.opacity = opacity; const e = this.getElement(); if (e) e.style.opacity = String(opacity); }
	_getAnchor(): any { return toPoint(this._source && this._source._getTooltipAnchor && !this.options.sticky ? this._source._getTooltipAnchor() : [0, 0]); }
	/** "auto" is right of the point on the left half of the map, left of it on the right half */
	_direction(): { dir: string; auto: boolean } {
		const d = this.options.direction;
		if (DIR[d]) return { dir: d, auto: false };
		const m = this._map;
		if (!m || !this._latlng) return { dir: "right", auto: true };
		return { dir: m.latLngToContainerPoint(this._latlng).x < m.getSize().x / 2 ? "right" : "left", auto: true };
	}
	_mlOptions(): Record<string, unknown> {
		const { dir } = this._dir = this._direction();
		return { closeButton: false, anchor: DIR[dir][0], className: `leaflet-tooltip leaflet-tooltip-${dir} ${this.options.className || ""}`.trim() };
	}
	_mlOffset(): [number, number] {
		const { dir, auto } = this._dir ?? this._direction(), a = this._getAnchor(), o = toPoint(this.options.offset)!, [, gx, gy] = DIR[dir];
		const x = auto && dir === "left" ? -(o.x + a.x) : o.x + a.x;
		return [x + gx, o.y + a.y + gy];
	}
	_updatePosition(): void {
		if (this._mlp && this._map && this._direction().dir !== this._dir?.dir) { this._makeMl(this._map); this.setOpacity(this.options.opacity); }
		super._updatePosition();
	}
	_makeMl(map: any): void {
		this._dir = this._direction();
		super._makeMl(map);
		const e = this.getElement();
		if (e && !this.options.interactive) e.style.pointerEvents = "none";
	}
}
define(Tooltip, { options: { pane: "tooltipPane", offset: [0, 0], direction: "auto", permanent: false, sticky: false, opacity: 0.9 }, _z: 9e5 });

// ── map.openPopup / closePopup / openTooltip / closeTooltip ──
LMap.include({
	openPopup(this: any, popup: any, latlng?: any, options?: any): any { initOverlay(Popup, popup, latlng, options).openOn(this); return this; },
	closePopup(this: any, popup?: any): any { popup = popup || this._popup; popup?.close(); return this; },
	openTooltip(this: any, tooltip: any, latlng?: any, options?: any): any { initOverlay(Tooltip, tooltip, latlng, options).openOn(this); return this; },
	closeTooltip(this: any, tooltip: any): any { tooltip.close(); return this; },
});
function initOverlay(C: any, content: any, latlng?: any, options?: any): any { const o = content instanceof C ? content : new C(options).setContent(content); if (latlng) o.setLatLng(latlng); return o; }

// ── layer.bindPopup / bindTooltip and friends (Leaflet's Layer.include in Popup.js / Tooltip.js) ──
Layer.include({
	bindPopup(this: any, content: any, options?: any): any {
		this._popup = this._initOverlay(Popup, this._popup, content, options);
		if (!this._popupHandlersAdded) { this.on({ click: this._openPopup, keypress: this._onKeyPress, remove: this.closePopup, move: this._movePopup }); this._popupHandlersAdded = true; }
		return this;
	},
	unbindPopup(this: any): any {
		if (this._popup) { this.off({ click: this._openPopup, keypress: this._onKeyPress, remove: this.closePopup, move: this._movePopup }); this._popupHandlersAdded = false; this._popup = null; }
		return this;
	},
	openPopup(this: any, latlng?: any): any {
		if (this._popup) {
			if (!(this instanceof FeatureGroup)) this._popup._source = this;
			if (this._popup._prepareOpen(latlng || this._latlng)) this._popup.openOn(this._map);
		}
		return this;
	},
	closePopup(this: any): any { this._popup?.close(); return this; },
	togglePopup(this: any): any { this._popup?.toggle(this); return this; },
	isPopupOpen(this: any): boolean { return this._popup ? this._popup.isOpen() : false; },
	setPopupContent(this: any, content: any): any { this._popup?.setContent(content); return this; },
	getPopup(this: any): any { return this._popup; },
	_openPopup(this: any, e: any): void {
		if (!this._popup || !this._map) return;
		DomEvent.stop(e);
		const target = e.layer || e.target;
		if (this._popup._source === target && !target._isPath) {
			if (this._map.hasLayer(this._popup)) this.closePopup(); else this.openPopup(e.latlng);
			return;
		}
		this._popup._source = target;
		this.openPopup(e.latlng);
	},
	_movePopup(this: any, e: any): void { this._popup.setLatLng(e.latlng); },
	_onKeyPress(this: any, e: any): void { if (e.originalEvent?.keyCode === 13) this._openPopup(e); },
	_initOverlay(this: any, C: any, old: any, content: any, options?: any): any {
		let overlay = content;
		if (!(overlay instanceof C)) { overlay = old && !options ? old : new C(options, this); overlay.setContent(content); }
		else overlay._source = this;
		return overlay;
	},

	bindTooltip(this: any, content: any, options?: any): any {
		if (this._tooltip && this.isTooltipOpen()) this.unbindTooltip();
		this._tooltip = this._initOverlay(Tooltip, this._tooltip, content, options);
		this._initTooltipInteractions();
		if (this._tooltip.options.permanent && this._map && this._map.hasLayer(this)) this.openTooltip();
		return this;
	},
	unbindTooltip(this: any): any { if (this._tooltip) { this._initTooltipInteractions(true); this.closeTooltip(); this._tooltip = null; } return this; },
	_initTooltipInteractions(this: any, remove?: boolean): void {
		if (!remove && this._tooltipHandlersAdded) return;
		const events: Record<string, unknown> = { remove: this.closeTooltip, move: this._moveTooltip };
		if (!this._tooltip.options.permanent) { events.mouseover = this._openTooltip; events.mouseout = this.closeTooltip; events.click = this._openTooltip; }
		else events.add = this._openTooltip;
		if (this._tooltip.options.sticky) events.mousemove = this._moveTooltip;
		this[remove ? "off" : "on"](events);
		this._tooltipHandlersAdded = !remove;
	},
	openTooltip(this: any, latlng?: any): any {
		if (this._tooltip) {
			if (!(this instanceof FeatureGroup)) this._tooltip._source = this;
			if (this._tooltip._prepareOpen(latlng)) this._tooltip.openOn(this._map);
		}
		return this;
	},
	closeTooltip(this: any): any { this._tooltip?.close(); return this; },
	toggleTooltip(this: any): any { this._tooltip?.toggle(this); return this; },
	isTooltipOpen(this: any): boolean { return this._tooltip ? this._tooltip.isOpen() : false; },
	setTooltipContent(this: any, content: any): any { this._tooltip?.setContent(content); return this; },
	getTooltip(this: any): any { return this._tooltip; },
	_openTooltip(this: any, e: any): void {
		if (!this._tooltip || !this._map) return;
		this._tooltip._source = e.layer || e.target;
		this.openTooltip(this._tooltip.options.sticky ? e.latlng : undefined);
	},
	_moveTooltip(this: any, e: any): void {
		let latlng = e.latlng;
		if (this._tooltip.options.sticky && e.originalEvent && typeof e.originalEvent.clientX === "number") latlng = this._map.mouseEventToLatLng(e.originalEvent);
		this._tooltip.setLatLng(latlng);
	},
});
