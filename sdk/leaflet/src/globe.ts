// @ortho-earth/leaflet/globe — the L namespace bound to @ortho-earth/globe/maplibre (the globe). Shaped like the "leaflet" package
//   (default export L, and its named exports), so a bundler alias "leaflet" → "@ortho-earth/leaflet/globe" ports an app unchanged.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as maplibregl from "@ortho-earth/globe/maplibre";
import { createLeaflet, installGlobal, type LeafletOptions } from "./index.ts";

export { createLeaflet, installGlobal, unsupportedReport } from "./index.ts";
export type { LeafletOptions } from "./index.ts";

/** L on the globe (style null: the globe's own Earth under your tile layers) */
export const L: any = createLeaflet(maplibregl, { style: null });
export default L;

/** L on the globe with your own options (a MapLibre style under the layers, zoomOffset, MapLibre map options) */
export const createGlobeLeaflet = (o: LeafletOptions = {}): any => createLeaflet(maplibregl, { style: null, ...o });

export const {
	version, Map, map, Class, Evented, Mixin, Handler, Util, Browser, DomUtil, DomEvent, Draggable, PosAnimation, LineUtil, PolyUtil,
	extend, bind, stamp, setOptions, LatLng, latLng, LatLngBounds, latLngBounds, Point, point, Bounds, bounds, Transformation, transformation, CRS, Projection,
	Layer, LayerGroup, layerGroup, FeatureGroup, featureGroup, Renderer, SVG, svg, Canvas, canvas,
	Path, Polyline, polyline, Polygon, polygon, Rectangle, rectangle, CircleMarker, circleMarker, Circle, circle,
	Icon, icon, DivIcon, divIcon, Marker, marker, DivOverlay, Popup, popup, Tooltip, tooltip,
	GridLayer, gridLayer, TileLayer, tileLayer, ImageOverlay, imageOverlay, VideoOverlay, videoOverlay, SVGOverlay, svgOverlay,
	GeoJSON, geoJSON, geoJson, Control, control,
} = L;

/** window.L, for scripts and plugins that read the global */
export const install = (): any => installGlobal(L);
