// @ortho-earth/gmaps — the Google Maps JavaScript API on MapLibre GL.
//   createGoogleMaps(maplibregl) returns a google.maps namespace whose Map, Marker, InfoWindow, shapes and Data draw through that maplibregl:
//   the real maplibre-gl, or @ortho-earth/globe/maplibre (the globe; "./globe" binds it for you).
//   It is a translator only: what has no MapLibre counterpart is reported once as "[gmshim] unsupported: …" and never throws.
//   Services that need Google's servers (Geocoder, DirectionsService, places, StreetView…) are not translated; their constructors
//   are stubs whose methods reject, so the map part of an app still runs.
import { LatLng, LatLngBounds, Point, Size, MVCObject, MVCArray, event, unsupported, unsupportedReport } from "./core.ts";
import { geometry } from "./geometry.ts";
import { GMap, MapTypeId, ControlPosition, type Ctx } from "./map.ts";
import { Marker, AdvancedMarkerElement, PinElement, InfoWindow, SymbolPath, Animation, CollisionBehavior } from "./markers.ts";
import { Polyline, Polygon, Circle, Rectangle } from "./shapes.ts";
import { Data as DataBase, DataGeometries } from "./data.ts";

export { LatLng, LatLngBounds, Point, Size, MVCObject, MVCArray, event, geometry, unsupportedReport };
export type { LatLngLiteral, LatLngBoundsLiteral, MapsEventListener } from "./core.ts";

export interface GoogleMapsOptions {
	/** MapLibre style per Google map type or mapId ("roadmap", "satellite", "hybrid", "terrain", or your mapId). hybrid falls back to satellite, terrain to roadmap */
	styles?: Record<string, unknown>;
	/** the style when none of `styles` matches (default: none = the maplibregl Map's own default) */
	style?: unknown;
	/** Google zoom − MapLibre zoom (default 1: Google's 256 px tiles vs MapLibre's 512 px) */
	zoomOffset?: number;
	/** extra MapLibre MapOptions given to every Map */
	mapOptions?: Record<string, unknown>;
}

const StrokePosition = { CENTER: 0, INSIDE: 1, OUTSIDE: 2 } as const;
const ColorScheme = { DARK: "DARK", LIGHT: "LIGHT", FOLLOW_SYSTEM: "FOLLOW_SYSTEM" } as const;
const RenderingType = { RASTER: "RASTER", VECTOR: "VECTOR", UNINITIALIZED: "UNINITIALIZED" } as const;

/** a constructor for a Google service this translator does not provide: methods reject (or return undefined) and are reported */
function stub(name: string): unknown {
	return class {
		constructor() {
			unsupported(`google.maps.${name}`);
			return new Proxy(this, { get: (t, k) => typeof k === "symbol" || k === "then" ? undefined : (...a: unknown[]) => { unsupported(`google.maps.${name}.${k}()`); const cb = a.find(x => typeof x === "function") as ((r: null, s: string) => void) | undefined; cb?.(null, "REQUEST_DENIED"); return Promise.reject(new Error(`google.maps.${name} is not available on MapLibre`)); } });
		}
	};
}

/** the google.maps namespace on a maplibregl namespace */
export function createGoogleMaps(maplibregl: any, o: GoogleMapsOptions = {}): any {
	if (!maplibregl?.Map) throw new Error("createGoogleMaps(maplibregl): pass the maplibregl namespace (maplibre-gl or @ortho-earth/globe/maplibre)");
	const ctx: Ctx & { Data?: unknown } = { ml: maplibregl, zoomOffset: o.zoomOffset ?? 1, styles: { ...o.styles }, style: o.style, mapOptions: { ...o.mapOptions } };
	class Map extends GMap { static ctx = ctx; }
	class Data extends DataBase {}
	Object.assign(Data, DataGeometries);
	ctx.Data = Data;
	const marker = { Marker, AdvancedMarkerElement, PinElement, CollisionBehavior };
	const ns: Record<string, unknown> = {
		Map, Marker, InfoWindow, Polyline, Polygon, Circle, Rectangle, Data,
		LatLng, LatLngBounds, Point, Size, MVCObject, MVCArray, event,
		MapTypeId, ControlPosition, SymbolPath, Animation, StrokePosition, ColorScheme, RenderingType,
		geometry, marker, version: "ortho-earth-gmaps",
		unsupportedReport,
		/** the maplibregl namespace underneath */
		maplibregl,
	};
	// google.maps.importLibrary("maps" | "marker" | "core" | "geometry") — the sections Google's loader hands out
	const libs: Record<string, Record<string, unknown>> = {
		core: { LatLng, LatLngBounds, Point, Size, MVCObject, MVCArray, event, ControlPosition, SymbolPath, Animation, ColorScheme },
		maps: { Map, InfoWindow, Polyline, Polygon, Circle, Rectangle, Data, MapTypeId, StrokePosition, RenderingType },
		marker, geometry, ...geometry,
	};
	ns.importLibrary = async (name: string): Promise<unknown> => {
		if (libs[name]) return libs[name];
		unsupported(`importLibrary("${name}")`);
		return new Proxy({}, { get: (_, k) => typeof k === "string" && /^[A-Z]/.test(k) ? stub(`${name}.${k}`) : undefined });
	};
	return new Proxy(ns, { get: (t, k) => k in t || typeof k !== "string" || !/^[A-Z]/.test(k) ? t[k as string] : (t[k] = stub(k)) });
}

/**
 * Put a namespace where Google's script tag would: globalThis.google.maps (for code that reads the global).
 * Returns the namespace.
 */
export function installGlobal(maps: any): any {
	const g = globalThis as { google?: { maps?: unknown } };
	g.google = { ...g.google, maps };
	return maps;
}
