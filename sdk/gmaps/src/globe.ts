// @ortho-earth/gmaps/globe — the google.maps namespace bound to @ortho-earth/globe/maplibre (the globe), plus a stand-in for
// @googlemaps/js-api-loader so `new Loader({ apiKey }).importLibrary("maps")` keeps working. No API key is needed or sent.
import * as maplibregl from "@ortho-earth/globe/maplibre";
import { createGoogleMaps, installGlobal, type GoogleMapsOptions } from "./index.ts";

export * from "./index.ts";

/** google.maps on the globe (no styles: MapLibre styles per map type go in createGlobeMaps({ styles })) */
export const maps = createGoogleMaps(maplibregl);
export const google = { maps };
export default google;

/** google.maps on the globe with your own MapLibre styles per map type / mapId */
export const createGlobeMaps = (o: GoogleMapsOptions = {}): any => createGoogleMaps(maplibregl, o);

/** @googlemaps/js-api-loader's Loader: apiKey and the rest are accepted and ignored */
export class Loader {
	#maps: any;
	constructor(o: { maps?: any; [k: string]: unknown } = {}) { this.#maps = o.maps ?? maps; }
	async load(): Promise<{ maps: any }> { installGlobal(this.#maps); return { maps: this.#maps }; }
	importLibrary(name: string): Promise<unknown> { installGlobal(this.#maps); return this.#maps.importLibrary(name); }
}
