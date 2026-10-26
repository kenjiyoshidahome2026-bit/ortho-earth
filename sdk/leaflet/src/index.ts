// @ortho-earth/leaflet — the Leaflet API on MapLibre GL.
//   createLeaflet(maplibregl) returns an `L` namespace whose map, markers, popups, tile layers, vector layers and GeoJSON draw through that
//   maplibregl: the real maplibre-gl, or @ortho-earth/globe/maplibre (the globe; "./globe" binds it for you).
//   It is a translator only: what has no MapLibre counterpart is reported once as "[lfshim] unsupported: …" and never throws.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Class, Evented, Handler, Mixin, Util, Browser, unsupported, unsupportedReport } from "./core.ts";
import { LatLng, LatLngBounds, Point, Bounds, Transformation, CRS, Projection, toLatLng, toLatLngBounds, toPoint, toBounds, toTransformation, isFlat } from "./geo.ts";
import { DomUtil, DomEvent } from "./dom.ts";
import { Layer, LayerGroup, FeatureGroup } from "./layer.ts";
import { LMap, type Ctx } from "./map.ts";
import { Renderer, SVG, Canvas, svg, canvas, Path, Polyline, Polygon, Rectangle, CircleMarker, Circle, polylineCenter, polygonCenter } from "./vector.ts";
import { Icon, IconDefault, DivIcon, Marker } from "./marker.ts";
import { DivOverlay, Popup, Tooltip } from "./popup.ts";
import { GridLayer, TileLayer, TileLayerWMS, ImageOverlay, VideoOverlay, SVGOverlay } from "./raster.ts";
import { GeoJSON } from "./geojson.ts";
import { Control, Zoom, Attribution, Scale, Layers } from "./control.ts";

export { unsupportedReport };

export interface LeafletOptions {
	/** the MapLibre style under every map (default: an empty style, so the map shows only your layers, as Leaflet does; null: the maplibregl Map's own default) */
	style?: unknown;
	/** Leaflet zoom − MapLibre zoom (default 1: Leaflet's 256 px tiles vs MapLibre's 512 px) */
	zoomOffset?: number;
	/** extra MapLibre MapOptions given to every map */
	mapOptions?: Record<string, unknown>;
}

// Leaflet's statics on its classes
Object.assign(Icon, { Default: IconDefault });
Object.assign(TileLayer, { WMS: TileLayerWMS });
Object.assign(Control, { Zoom, Attribution, Scale, Layers });

/** L.Draggable / L.PosAnimation: Leaflet's DOM animation helpers; MapLibre moves the map itself */
class Draggable extends Evented { initialize(): void { unsupported("L.Draggable"); } enable(): void {} disable(): void {} finishDrag(): void {} }
class PosAnimation extends Evented { run(el: any, newPos: Point): void { DomUtil.setPosition(el, newPos); this.fire("start").fire("step").fire("end"); } stop(): void {} }

const sqDist = (p: Point, a: Point, b: Point): number => { const c = closestPointOnSegment(p, a, b); return (c.x - p.x) ** 2 + (c.y - p.y) ** 2; };
function closestPointOnSegment(p: Point, a: Point, b: Point): Point {
	const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
	return new Point(a.x + t * dx, a.y + t * dy);
}
const LineUtil = {
	isFlat, polylineCenter, closestPointOnSegment,
	pointToSegmentDistance: (p: Point, a: Point, b: Point): number => Math.sqrt(sqDist(p, a, b)),
	simplify: (points: Point[]): Point[] => points,
};
const PolyUtil = { polygonCenter };

/** the L namespace on a maplibregl namespace */
export function createLeaflet(maplibregl: any, o: LeafletOptions = {}): any {
	if (!maplibregl?.Map) throw new Error("createLeaflet(maplibregl): pass the maplibregl namespace (maplibre-gl or @ortho-earth/globe/maplibre)");
	const ctx: Ctx = { ml: maplibregl, zoomOffset: o.zoomOffset ?? 1, style: o.style, mapOptions: { ...o.mapOptions } };
	const Map = LMap.extend({ _ctx: ctx });
	const control: any = (opts?: any) => new Control(opts);
	Object.assign(control, { zoom: (x?: any) => new Zoom(x), attribution: (x?: any) => new Attribution(x), scale: (x?: any) => new Scale(x), layers: (b?: any, ov?: any, x?: any) => new Layers(b, ov, x) });
	const tileLayer: any = (url: string, x?: any) => new TileLayer(url, x);
	tileLayer.wms = (url: string, x?: any) => new TileLayerWMS(url, x);
	const geoJSON = (g?: any, x?: any): GeoJSON => new GeoJSON(g, x);
	const L: Record<string, any> = {
		version: "1.9.4",
		Map, map: (id: string | HTMLElement, x?: any) => new Map(id, x),
		Class, Evented, Mixin, Handler, Util, Browser, DomUtil, DomEvent, Draggable, PosAnimation, LineUtil, PolyUtil,
		extend: Util.extend, bind: Util.bind, stamp: Util.stamp, setOptions: Util.setOptions,
		LatLng, latLng: toLatLng, LatLngBounds, latLngBounds: toLatLngBounds, Point, point: toPoint, Bounds, bounds: toBounds,
		Transformation, transformation: toTransformation, CRS, Projection,
		Layer, LayerGroup, layerGroup: (l?: any[], x?: any) => new LayerGroup(l, x), FeatureGroup, featureGroup: (l?: any[], x?: any) => new FeatureGroup(l, x),
		Renderer, SVG, svg, Canvas, canvas,
		Path, Polyline, polyline: (l: any, x?: any) => new Polyline(l, x), Polygon, polygon: (l: any, x?: any) => new Polygon(l, x),
		Rectangle, rectangle: (b: any, x?: any) => new Rectangle(b, x), CircleMarker, circleMarker: (l: any, x?: any) => new CircleMarker(l, x),
		Circle, circle: (l: any, x?: any, legacy?: any) => new Circle(l, x, legacy),
		Icon, icon: (x?: any) => new Icon(x), DivIcon, divIcon: (x?: any) => new DivIcon(x), Marker, marker: (l: any, x?: any) => new Marker(l, x),
		DivOverlay, Popup, popup: (x?: any, s?: any) => new Popup(x, s), Tooltip, tooltip: (x?: any, s?: any) => new Tooltip(x, s),
		GridLayer, gridLayer: (x?: any) => new GridLayer(x), TileLayer, tileLayer,
		ImageOverlay, imageOverlay: (u: string, b: any, x?: any) => new ImageOverlay(u, b, x), VideoOverlay, videoOverlay: (u: any, b: any, x?: any) => new VideoOverlay(u, b, x),
		SVGOverlay, svgOverlay: (e: any, b: any, x?: any) => new SVGOverlay(e, b, x),
		GeoJSON, geoJSON, geoJson: geoJSON,
		Control, control,
		unsupportedReport,
		/** the maplibregl namespace underneath */
		maplibregl,
	};
	L.noConflict = (): any => { const g = globalThis as any; if (g.L === L) g.L = L._oldL; return L; };
	return L;
}

/** Put a namespace where Leaflet's script tag would: globalThis.L (for code and plugins that read the global). Returns the namespace. */
export function installGlobal(L: any): any {
	const g = globalThis as any;
	if (g.L !== L) L._oldL = g.L;
	g.L = L;
	return L;
}
