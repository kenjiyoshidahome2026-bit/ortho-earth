// L.GeoJSON: a FeatureGroup with one layer per feature (markers for points by default, polylines, polygons), as in Leaflet,
//   so style / onEachFeature / pointToLayer / filter / resetStyle / eachLayer code keeps working. All paths of the group share the
//   pane's renderer: one MapLibre source however many features.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { define, extend, setOptions } from "./core.ts";
import { coordsToLatLng, coordsToLatLngs, latLngToCoords, latLngsToCoords, asFeature, getFeature } from "./geo.ts";
import { FeatureGroup, LayerGroup } from "./layer.ts";
import { Marker } from "./marker.ts";
import { Polyline, Polygon } from "./vector.ts";

export class GeoJSON extends FeatureGroup {
	initialize(geojson?: any, options?: any): void {
		setOptions(this, options);
		this._layers = {};
		if (geojson) this.addData(geojson);
	}
	addData(geojson: any): this {
		const features = Array.isArray(geojson) ? geojson : geojson.features;
		if (features) {
			for (const f of features) if (f.geometries || f.geometry || f.features || f.coordinates) this.addData(f);
			return this;
		}
		const o = this.options;
		if (o.filter && !o.filter(geojson)) return this;
		const layer = geometryToLayer(geojson, o);
		if (!layer) return this;
		layer.feature = asFeature(geojson);
		layer.defaultOptions = layer.options;
		this.resetStyle(layer);
		o.onEachFeature?.(geojson, layer);
		return this.addLayer(layer);
	}
	resetStyle(layer?: any): this {
		if (layer === undefined) return this.eachLayer(this.resetStyle, this);
		layer.options = extend({}, layer.defaultOptions);
		this._setLayerStyle(layer, this.options.style);
		return this;
	}
	setStyle(style: any): this { return this.eachLayer(l => this._setLayerStyle(l, style)); }
	_setLayerStyle(layer: any, style: any): void {
		if (!layer.setStyle) return;
		if (typeof style === "function") style = style(layer.feature);
		layer.setStyle(style);
	}
	static geometryToLayer = (g: any, o?: any): any => geometryToLayer(g, o);
	static coordsToLatLng = coordsToLatLng;
	static coordsToLatLngs = coordsToLatLngs;
	static latLngToCoords = latLngToCoords;
	static latLngsToCoords = latLngsToCoords;
	static getFeature = getFeature;
	static asFeature = asFeature;
}
define(GeoJSON, {});

/** a GeoJSON geometry / feature → its Leaflet layer */
export function geometryToLayer(geojson: any, options: any = {}): any {
	const geometry = geojson.type === "Feature" ? geojson.geometry : geojson, coords = geometry?.coordinates, layers: any[] = [];
	const c2l = options.coordsToLatLng || coordsToLatLng;
	if (!coords && !geometry) return null;
	const point = (latlng: any): any => options.pointToLayer ? options.pointToLayer(geojson, latlng) : new Marker(latlng, options.markersInheritOptions && options);
	switch (geometry.type) {
		case "Point": return point(c2l(coords));
		case "MultiPoint": for (const c of coords) layers.push(point(c2l(c))); return new FeatureGroup(layers);
		case "LineString": case "MultiLineString": return new Polyline(coordsToLatLngs(coords, geometry.type === "LineString" ? 0 : 1, c2l), options);
		case "Polygon": case "MultiPolygon": return new Polygon(coordsToLatLngs(coords, geometry.type === "Polygon" ? 1 : 2, c2l), options);
		case "GeometryCollection":
			for (const g of geometry.geometries) { const l = geometryToLayer({ geometry: g, type: "Feature", properties: geojson.properties }, options); if (l) layers.push(l); }
			return new FeatureGroup(layers);
		case "FeatureCollection":
			for (const f of geometry.features) { const l = geometryToLayer(f, options); if (l) layers.push(l); }
			return new FeatureGroup(layers);
		default: throw new Error("Invalid GeoJSON object.");
	}
}

// toGeoJSON on groups (Leaflet's LayerGroup.include in GeoJSON.js)
LayerGroup.include({
	toMultiPoint(this: any, precision?: number | false): any {
		const coords: number[][] = [];
		this.eachLayer((l: any) => coords.push(l.toGeoJSON(precision).geometry.coordinates));
		return getFeature(this, { type: "MultiPoint", coordinates: coords });
	},
	toGeoJSON(this: any, precision?: number | false): any {
		const type = this.feature?.geometry?.type;
		if (type === "MultiPoint") return this.toMultiPoint(precision);
		const isGC = type === "GeometryCollection", out: any[] = [];
		this.eachLayer((l: any) => {
			if (!l.toGeoJSON) return;
			const j = l.toGeoJSON(precision);
			if (isGC) out.push(j.geometry);
			else { const f = asFeature(j); if (f.type === "FeatureCollection") out.push(...f.features); else out.push(f); }
		});
		return isGC ? getFeature(this, { geometries: out, type: "GeometryCollection" }) : { type: "FeatureCollection", features: out };
	},
});
