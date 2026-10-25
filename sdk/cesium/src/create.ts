// The engine's create* helpers that make a primitive: rebuilt on the facade's Cesium3DTileset (the engine's would make one the globe cannot draw).
import { Cesium3DTileStyle, CesiumTerrainProvider, IonResource } from "@cesium/engine";
import { Cesium3DTileset } from "./tileset.ts";

type Any = any;
/** Cesium OSM Buildings (ion asset 96188) */
export async function createOsmBuildingsAsync(options: Any = {}): Promise<Cesium3DTileset> {
	const ts = await Cesium3DTileset.fromIonAssetId(96188, options);
	ts.style = options.style ?? new Cesium3DTileStyle({ color: { conditions: [["${feature['cesium#color']} !== undefined", "color(${feature['cesium#color']})"], ["true", options.defaultColor ? `color('${options.defaultColor.toCssHexString()}')` : "color('#ffffff')"]] } });
	return ts;
}
/** Google Photorealistic 3D Tiles (through ion, asset 2275207, or with options.key straight from Google) */
export async function createGooglePhotorealistic3DTileset(apiOptions: Any = {}, tilesetOptions: Any = {}): Promise<Cesium3DTileset> {
	if (apiOptions?.key) return Cesium3DTileset.fromUrl(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(apiOptions.key)}`, tilesetOptions);
	return Cesium3DTileset.fromIonAssetId(apiOptions?.assetId ?? 2275207, tilesetOptions);
}
/** Cesium World Terrain: the provider is the engine's; the globe shows its own world terrain for it */
export async function createWorldTerrainAsync(options: Any = {}): Promise<Any> {
	const p = await CesiumTerrainProvider.fromUrl(IonResource.fromAssetId(1), { requestVertexNormals: !!options.requestVertexNormals, requestWaterMask: !!options.requestWaterMask });
	(p as Any).__orthoWorldTerrain = true;
	return p;
}
