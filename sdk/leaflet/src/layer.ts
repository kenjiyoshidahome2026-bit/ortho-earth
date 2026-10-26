// L.Layer, L.LayerGroup, L.FeatureGroup: what every layer shares (addTo / remove / panes / attribution) and the groups.
//   Popups and tooltips are bound onto Layer in popup.ts (as Leaflet does in Popup.js / Tooltip.js).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Evented, define, stamp, setOptions } from "./core.ts";
import { LatLngBounds } from "./geo.ts";

export class Layer extends Evented {
	addTo(map: any): this { map.addLayer(this); return this; }
	remove(): this { return this.removeFrom(this._map || this._mapToAdd); }
	removeFrom(obj: any): this { obj?.removeLayer(this); return this; }
	getPane(name?: string): HTMLElement { return this._map.getPane(name ? (this.options[name] || name) : this.options.pane); }
	addInteractiveTarget(target: any): this { return this; }
	removeInteractiveTarget(target: any): this { return this; }
	getAttribution(): string | null { return this.options.attribution; }
	_layerAdd(e: { target: any }): void {
		const map = e.target;
		if (!map.hasLayer(this)) return;
		this._map = map;
		this._zoomAnimated = false;
		if (this.getEvents) {
			const events = this.getEvents();
			map.on(events, this);
			this.once("remove", () => map.off(events, this), this);
		}
		this.onAdd(map);
		this.fire("add");
		map.fire("layeradd", { layer: this });
	}
}
define(Layer, { options: { pane: "overlayPane", attribution: null, bubblingMouseEvents: true } });

/** L.LayerGroup: layers added to / removed from the map together */
export class LayerGroup extends Layer {
	initialize(layers?: any[], options?: any): void {
		setOptions(this, options);
		this._layers = {};
		for (const l of layers || []) this.addLayer(l);
	}
	addLayer(layer: any): this { const id = this.getLayerId(layer); this._layers[id] = layer; this._map?.addLayer(layer); return this; }
	removeLayer(layer: any): this {
		const id = id_(this, layer);
		if (this._map && this._layers[id]) this._map.removeLayer(this._layers[id]);
		delete this._layers[id];
		return this;
	}
	hasLayer(layer: any): boolean { return !!layer && (id_(this, layer) in this._layers); }
	clearLayers(): this { return this.eachLayer(this.removeLayer, this); }
	invoke(methodName: string, ...args: unknown[]): this { for (const id in this._layers) this._layers[id][methodName]?.apply(this._layers[id], args); return this; }
	onAdd(map: any): void { this.eachLayer(map.addLayer, map); }
	onRemove(map: any): void { this.eachLayer(map.removeLayer, map); }
	eachLayer(fn: (l: any) => void, context?: unknown): this { for (const id in this._layers) fn.call(context, this._layers[id]); return this; }
	getLayer(id: number): any { return this._layers[id]; }
	getLayers(): any[] { const out: any[] = []; this.eachLayer(l => out.push(l)); return out; }
	setZIndex(z: number): this { return this.invoke("setZIndex", z); }
	getLayerId(layer: any): number { return stamp(layer); }
}
const id_ = (g: LayerGroup, layer: any): number => typeof layer === "number" ? layer : g.getLayerId(layer);

/** L.FeatureGroup: a LayerGroup whose members' events reach the group (e.layer / e.propagatedFrom), with setStyle / getBounds */
export class FeatureGroup extends LayerGroup {
	addLayer(layer: any): this {
		if (this.hasLayer(layer)) return this;
		layer.addEventParent(this);
		super.addLayer(layer);
		return this.fire("layeradd", { layer });
	}
	removeLayer(layer: any): this {
		if (!this.hasLayer(layer)) return this;
		if (layer in this._layers) layer = this._layers[layer];
		layer.removeEventParent(this);
		super.removeLayer(layer);
		return this.fire("layerremove", { layer });
	}
	setStyle(style: any): this { return this.invoke("setStyle", style); }
	bringToFront(): this { return this.invoke("bringToFront"); }
	bringToBack(): this { return this.invoke("bringToBack"); }
	getBounds(): LatLngBounds {
		const b = new LatLngBounds();
		for (const id in this._layers) { const l = this._layers[id]; b.extend(l.getBounds ? l.getBounds() : l.getLatLng()); }
		return b;
	}
}
