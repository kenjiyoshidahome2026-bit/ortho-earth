// L.Control and the four built-in controls (Zoom, Attribution, Scale, Layers), placed in MapLibre's control corners.
//   L.Control.extend({ onAdd(map) { return element } }) works as in Leaflet.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Class, define, setOptions, stamp } from "./core.ts";
import { DomUtil, DomEvent } from "./dom.ts";
import { LMap } from "./map.ts";

export class Control extends Class {
	initialize(options?: any): void { setOptions(this, options); }
	getPosition(): string { return this.options.position; }
	setPosition(position: string): this { const map = this._map; map?.removeControl(this); this.options.position = position; map?.addControl(this); return this; }
	getContainer(): HTMLElement { return this._container; }
	addTo(map: any): this {
		this.remove();
		this._map = map;
		const container = this._container = this.onAdd(map);
		DomUtil.addClass(container, "leaflet-control");
		map._addMlControl(this, container, this.getPosition());
		map.on("unload", this.remove, this);
		return this;
	}
	remove(): this {
		if (!this._map) return this;
		this._map._removeMlControl(this);
		this.onRemove?.(this._map);
		this._map.off("unload", this.remove, this);
		this._map = null;
		return this;
	}
	_refocusOnMap(): void {}
}
define(Control, { options: { position: "topright" } });

/** L.Control.Zoom: + / − buttons */
export class Zoom extends Control {
	onAdd(map: any): HTMLElement {
		const o = this.options, c = DomUtil.create("div", "leaflet-control-zoom leaflet-bar maplibregl-ctrl-group");
		this._zoomInButton = this._button(o.zoomInText, o.zoomInTitle, "leaflet-control-zoom-in", c, (e: any) => { if (!this._disabled && map.getZoom() < map.getMaxZoom()) map.zoomIn(map.options.zoomDelta * (e.shiftKey ? 3 : 1)); });
		this._zoomOutButton = this._button(o.zoomOutText, o.zoomOutTitle, "leaflet-control-zoom-out", c, (e: any) => { if (!this._disabled && map.getZoom() > map.getMinZoom()) map.zoomOut(map.options.zoomDelta * (e.shiftKey ? 3 : 1)); });
		this._updateDisabled();
		map.on("zoomend zoomlevelschange", this._updateDisabled, this);
		return c;
	}
	onRemove(map: any): void { map.off("zoomend zoomlevelschange", this._updateDisabled, this); }
	disable(): this { this._disabled = true; this._updateDisabled(); return this; }
	enable(): this { this._disabled = false; this._updateDisabled(); return this; }
	_button(html: string, title: string, className: string, container: HTMLElement, fn: (e: any) => void): HTMLElement {
		const b = DomUtil.create("button", className, container) as HTMLButtonElement;
		b.innerHTML = html; b.title = title; b.type = "button";
		b.setAttribute?.("aria-label", title);
		DomEvent.disableClickPropagation(b);
		b.addEventListener("click", (e: Event) => { DomEvent.stop(e); fn(e); });
		return b;
	}
	_updateDisabled(): void {
		const map = this._map;
		if (!map || !this._zoomInButton) return;
		(this._zoomInButton as HTMLButtonElement).disabled = !!this._disabled || map.getZoom() >= map.getMaxZoom();
		(this._zoomOutButton as HTMLButtonElement).disabled = !!this._disabled || map.getZoom() <= map.getMinZoom();
	}
}
define(Zoom, { options: { position: "topleft", zoomInText: '<span aria-hidden="true">+</span>', zoomInTitle: "Zoom in", zoomOutText: '<span aria-hidden="true">&#x2212;</span>', zoomOutTitle: "Zoom out" } });

/** L.Control.Attribution: the layers' attributions (and the MapLibre style's sources') after a prefix */
export class Attribution extends Control {
	initialize(options?: any): void { setOptions(this, options); this._attributions = {}; }
	onAdd(map: any): HTMLElement {
		map.attributionControl = this;
		this._container = DomUtil.create("div", "leaflet-control-attribution");
		DomEvent.disableClickPropagation(this._container);
		map.eachLayer((l: any) => { if (l.getAttribution) this.addAttribution(l.getAttribution()); });
		map.on("layeradd", this._addAttribution, this);
		map.on("layerremove", this._removeAttribution, this);
		map._ml.on?.("styledata", this._onStyle = () => this._update());
		this._update();
		return this._container;
	}
	onRemove(map: any): void { map.off("layeradd", this._addAttribution, this); map.off("layerremove", this._removeAttribution, this); map._ml.off?.("styledata", this._onStyle); }
	_addAttribution(e: any): void { if (e.layer.getAttribution) { this.addAttribution(e.layer.getAttribution()); e.layer.once("remove", () => this.removeAttribution(e.layer.getAttribution())); } }
	_removeAttribution(): void {}
	setPrefix(prefix: string | false): this { this.options.prefix = prefix; this._update(); return this; }
	addAttribution(text?: string | null): this { if (!text) return this; this._attributions[text] = (this._attributions[text] || 0) + 1; this._update(); return this; }
	removeAttribution(text?: string | null): this { if (!text) return this; if (this._attributions[text]) { this._attributions[text]--; this._update(); } return this; }
	_update(): void {
		if (!this._map || !this._container) return;
		const attribs = Object.keys(this._attributions).filter(k => this._attributions[k]);
		const sources = this._map._ml.getStyle?.()?.sources || {};
		for (const id in sources) { const a = sources[id]?.attribution; if (a && !id.startsWith("lf-") && !attribs.includes(a)) attribs.push(a); }
		const parts: string[] = [];
		if (this.options.prefix) parts.push(this.options.prefix);
		if (attribs.length) parts.push(attribs.join(", "));
		this._container.innerHTML = parts.join(' <span aria-hidden="true">|</span> ');
	}
}
define(Attribution, { options: { position: "bottomright", prefix: '<a href="https://maplibre.org/" title="Drawn by MapLibre (Leaflet API by @ortho-earth/leaflet)">MapLibre</a>' } });
LMap.mergeOptions({ attributionControl: true });
LMap.addInitHook(function (this: any) { if (this.options.attributionControl) new Attribution().addTo(this); });
LMap.addInitHook(function (this: any) { if (this.options.zoomControl) { this.zoomControl = new Zoom(); this.addControl(this.zoomControl); } });

/** L.Control.Scale: metric and / or imperial bars (Leaflet's rounding) */
export class Scale extends Control {
	onAdd(map: any): HTMLElement {
		const c = DomUtil.create("div", "leaflet-control-scale"), o = this.options;
		if (o.metric) this._mScale = DomUtil.create("div", "leaflet-control-scale-line", c);
		if (o.imperial) this._iScale = DomUtil.create("div", "leaflet-control-scale-line", c);
		map.on(o.updateWhenIdle ? "moveend" : "move", this._update, this);
		map.whenReady(this._update, this);
		return c;
	}
	onRemove(map: any): void { map.off(this.options.updateWhenIdle ? "moveend" : "move", this._update, this); }
	_update(): void {
		const map = this._map;
		if (!map) return;
		const y = map.getSize().y / 2, maxMeters = map.distance(map.containerPointToLatLng([0, y]), map.containerPointToLatLng([this.options.maxWidth, y]));
		if (!(maxMeters > 0)) return;
		if (this._mScale) { const m = this._getRoundNum(maxMeters); this._updateScale(this._mScale, m < 1000 ? `${m} m` : `${m / 1000} km`, m / maxMeters); }
		if (this._iScale) {
			const maxFeet = maxMeters * 3.2808399;
			if (maxFeet > 5280) { const mi = this._getRoundNum(maxFeet / 5280); this._updateScale(this._iScale, `${mi} mi`, mi / (maxFeet / 5280)); }
			else { const ft = this._getRoundNum(maxFeet); this._updateScale(this._iScale, `${ft} ft`, ft / maxFeet); }
		}
	}
	_updateScale(el: HTMLElement, text: string, ratio: number): void { el.style.width = `${Math.round(this.options.maxWidth * ratio)}px`; el.innerHTML = text; }
	_getRoundNum(num: number): number { const pow10 = Math.pow(10, (`${Math.floor(num)}`).length - 1); let d = num / pow10; d = d >= 10 ? 10 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1; return pow10 * d; }
}
define(Scale, { options: { position: "bottomleft", maxWidth: 100, metric: true, imperial: true, updateWhenIdle: false } });

/** L.Control.Layers: radio buttons for base layers, checkboxes for overlays */
export class Layers extends Control {
	initialize(baseLayers?: Record<string, any>, overlays?: Record<string, any>, options?: any): void {
		setOptions(this, options);
		this._layerControlInputs = []; this._layers = []; this._lastZIndex = 0; this._handlingClick = false; this._preventClick = false;
		for (const name in baseLayers) this._addLayer(baseLayers[name], name);
		for (const name in overlays) this._addLayer(overlays[name], name, true);
	}
	onAdd(map: any): HTMLElement {
		this._initLayout();
		this._update();
		this._map = map;
		map.on("zoomend", this._checkDisabledLayers, this);
		for (const o of this._layers) o.layer.on("add remove", this._onLayerChange, this);
		return this._container;
	}
	addTo(map: any): this { super.addTo(map); return this._expandIfNotCollapsed(); }
	onRemove(map: any): void { map.off("zoomend", this._checkDisabledLayers, this); for (const o of this._layers) o.layer.off("add remove", this._onLayerChange, this); }
	addBaseLayer(layer: any, name: string): this { this._addLayer(layer, name); return this._map ? this._update() : this; }
	addOverlay(layer: any, name: string): this { this._addLayer(layer, name, true); return this._map ? this._update() : this; }
	removeLayer(layer: any): this { layer.off("add remove", this._onLayerChange, this); const o = this._getLayer(stamp(layer)); if (o) this._layers.splice(this._layers.indexOf(o), 1); return this._map ? this._update() : this; }
	expand(): this { DomUtil.addClass(this._container, "leaflet-control-layers-expanded"); return this; }
	collapse(): this { DomUtil.removeClass(this._container, "leaflet-control-layers-expanded"); return this; }
	_initLayout(): void {
		const c = this._container = DomUtil.create("div", "leaflet-control-layers"), collapsed = this.options.collapsed;
		c.setAttribute?.("aria-haspopup", "true");
		DomEvent.disableClickPropagation(c);
		DomEvent.disableScrollPropagation(c);
		const section = this._section = DomUtil.create("section", "leaflet-control-layers-list");
		if (collapsed) {
			c.addEventListener("mouseenter", () => this.expand());
			c.addEventListener("mouseleave", () => this.collapse());
		}
		const link = this._layersLink = DomUtil.create("a", "leaflet-control-layers-toggle", c) as HTMLAnchorElement;
		link.href = "#"; link.title = "Layers"; link.setAttribute?.("role", "button");
		link.addEventListener("click", (e: Event) => { DomEvent.preventDefault(e); this.expand(); });
		if (!collapsed) this.expand();
		this._baseLayersList = DomUtil.create("div", "leaflet-control-layers-base", section);
		this._separator = DomUtil.create("div", "leaflet-control-layers-separator", section);
		this._overlaysList = DomUtil.create("div", "leaflet-control-layers-overlays", section);
		c.appendChild(section);
	}
	_getLayer(id: number): any { return this._layers.find((o: any) => stamp(o.layer) === id); }
	_addLayer(layer: any, name: string, overlay?: boolean): void {
		if (this._map) layer.on("add remove", this._onLayerChange, this);
		this._layers.push({ layer, name, overlay });
		if (this.options.sortLayers) this._layers.sort((a: any, b: any) => this.options.sortFunction(a.layer, b.layer, a.name, b.name));
		if (this.options.autoZIndex && layer.setZIndex) { this._lastZIndex++; layer.setZIndex(this._lastZIndex); }
		this._expandIfNotCollapsed();
	}
	_update(): this {
		if (!this._container) return this;
		DomUtil.empty(this._baseLayersList); DomUtil.empty(this._overlaysList);
		this._layerControlInputs = [];
		let baseLayersPresent = false, overlaysPresent = false, baseLayersCount = 0;
		for (const o of this._layers) { this._addItem(o); overlaysPresent ||= !!o.overlay; baseLayersPresent ||= !o.overlay; baseLayersCount += o.overlay ? 0 : 1; }
		if (this.options.hideSingleBase) { baseLayersPresent = baseLayersPresent && baseLayersCount > 1; this._baseLayersList.style.display = baseLayersPresent ? "" : "none"; }
		this._separator.style.display = overlaysPresent && baseLayersPresent ? "" : "none";
		return this;
	}
	_onLayerChange(e: any): void {
		if (!this._handlingClick) this._update();
		const o = this._getLayer(stamp(e.target)), type = o?.overlay ? (e.type === "add" ? "overlayadd" : "overlayremove") : (e.type === "add" ? "baselayerchange" : null);
		if (type) this._map.fire(type, o);
	}
	_addItem(obj: any): HTMLElement {
		const label = document.createElement("label"), checked = this._map?.hasLayer(obj.layer);
		const input = document.createElement("input") as HTMLInputElement;
		if (obj.overlay) { input.type = "checkbox"; input.className = "leaflet-control-layers-selector"; input.defaultChecked = !!checked; }
		else { input.type = "radio"; input.className = "leaflet-control-layers-selector"; input.name = `leaflet-base-layers_${stamp(this)}`; }
		input.checked = !!checked;
		this._layerControlInputs.push(input);
		(input as any).layerId = stamp(obj.layer);
		input.addEventListener("click", () => this._onInputClick());
		const name = document.createElement("span");
		name.innerHTML = ` ${obj.name}`;
		const holder = document.createElement("span");
		label.appendChild(holder); holder.appendChild(input); holder.appendChild(name);
		(obj.overlay ? this._overlaysList : this._baseLayersList).appendChild(label);
		this._checkDisabledLayers();
		return label;
	}
	_onInputClick(): void {
		if (this._preventClick) return;
		const add: any[] = [], remove: any[] = [];
		this._handlingClick = true;
		for (const input of this._layerControlInputs) {
			const layer = this._getLayer(input.layerId)?.layer;
			if (!layer) continue;
			if (input.checked) add.push(layer); else remove.push(layer);
		}
		for (const l of remove) if (this._map.hasLayer(l)) this._map.removeLayer(l);
		for (const l of add) if (!this._map.hasLayer(l)) this._map.addLayer(l);
		this._handlingClick = false;
	}
	_checkDisabledLayers(): void {
		const zoom = this._map?.getZoom();
		if (zoom === undefined) return;
		for (const input of this._layerControlInputs) {
			const l = this._getLayer(input.layerId)?.layer;
			if (l) input.disabled = (l.options.minZoom !== undefined && zoom < l.options.minZoom) || (l.options.maxZoom !== undefined && zoom > l.options.maxZoom);
		}
	}
	_expandIfNotCollapsed(): this { if (this._map && !this.options.collapsed) this.expand(); return this; }
}
define(Layers, { options: { collapsed: true, position: "topright", autoZIndex: true, hideSingleBase: false, sortLayers: false, sortFunction: (a: any, b: any, na: string, nb: string) => na < nb ? -1 : nb < na ? 1 : 0 } });
