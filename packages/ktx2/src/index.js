// @ortho-earth/ktx2 — plugin for @ortho-earth/globe that registers the KTX2 / Basis Universal transcoder.
//   map.use(ktx2Plugin({ libraryPath }))  → registry.textureTranscoders "ktx2" = { url: <this package's transcode.js>#lib=… }
//   The globe's model worker import()s that URL and calls transcode(bytes) for every KHR_texture_basisu image in glb models and 3D Tiles.
//   The WASM is fetched on first use from libraryPath (basis_transcoder.js + basis_transcoder.wasm); default = unpkg's @loaders.gl/textures (pinned).
//   Nothing is downloaded until a model with a KTX2 texture is loaded, and nothing when the plugin is not installed (opt-in).
import { DEFAULT_LIBRARY_PATH } from "./transcode.js";
export { DEFAULT_LIBRARY_PATH, isKTX2, isBasis, ktx2Header, libraryPath } from "./transcode.js";
/** URL of the worker-side module, with the library path in the hash (what gets registered) */
export function transcoderUrl({ libraryPath = null } = {}) {
	const u = new URL("./transcode.js", import.meta.url);
	if (libraryPath) u.hash = "lib=" + encodeURIComponent(String(libraryPath));
	return u.href;
}
export function ktx2Plugin({ libraryPath = null, name = "ktx2" } = {}) {
	return {
		name: "ktx2",
		version: "0.1.0",
		install(map) {
			map.registry.textureTranscoders.add(name, { url: transcoderUrl({ libraryPath }), formats: ["ktx2", "basis"] });
			// registry entries owned by this plugin are dropped by map.unuse() itself; nothing else to clean up
		},
	};
}
export default ktx2Plugin;
