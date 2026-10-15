// @ortho-earth/google-tiles — Google Photorealistic 3D Tiles for @ortho-earth/globe.
//   The globe's add3DTiles already streams any 3D Tiles tileset and lets each tileset rewrite its requests (requestTransform, F5).
//   This package is the Google-specific part on top of that extension point:
//     - every request to tile.googleapis.com carries your API key (key=…); requests to any other host are left untouched (the key never leaks);
//     - the session token that Google puts in the child tileset URIs (session=…) is remembered and added to later requests that lack it
//       (the content URIs inside those child tilesets are relative and come without it);
//     - the attribution: "Google" plus the data providers of the tiles on screen (glTF asset.copyright, split on ";", most frequent first).
//   The key is passed in by the app at run time. Nothing here stores, logs or bundles it.
export const GOOGLE_3D_TILES_ROOT = "https://tile.googleapis.com/v1/3dtiles/root.json";
export const GOOGLE_TILES_HOST = "tile.googleapis.com";

/** requestTransform for add3DTiles: (url, type) → { url } | null. state: .session (last session token seen) */
export function googleRequestTransform({ key, session = null, hosts = [GOOGLE_TILES_HOST] } = {}) {
	if (!key || typeof key !== "string") throw new Error("googleRequestTransform: an API key is required ({ key })");
	const allow = new Set(hosts.map(h => String(h).toLowerCase()));
	let current = session || null;
	const rt = (url) => {
		let u;
		try { u = new URL(url); } catch { return null; }
		if (!allow.has(u.host.toLowerCase())) return null;   // not Google: leave as is (no key on foreign hosts)
		const s = u.searchParams.get("session");
		if (s) current = s;
		else if (current) u.searchParams.set("session", current);
		if (!u.searchParams.has("key")) u.searchParams.set("key", key);
		return { url: u.href };
	};
	Object.defineProperty(rt, "session", { get: () => current, enumerable: true });
	return rt;
}

/** Attribution text: "Google" first, then the data providers (already ordered by the globe: most frequent first). Duplicates of "Google" are folded. */
export function googleAttribution(copyrights = []) {
	const rest = copyrights.map(c => String(c).trim()).filter(c => c && !/^google$/i.test(c));
	return ["Google", ...rest].join("; ");
}

/** map.add3DTiles(root, { requestTransform, attribution, ...opts }) with Google's key / session / attribution. Returns the tileset handle. */
export function addGoogle3DTiles(map, { key, root = GOOGLE_3D_TILES_ROOT, hosts, id = "google-3d", attribution = googleAttribution, ...opts } = {}) {
	if (typeof map?.add3DTiles !== "function") throw new Error("addGoogle3DTiles: map.add3DTiles is required (@ortho-earth/globe)");
	const requestTransform = googleRequestTransform({ key, hosts: hosts ?? [new URL(root, globalThis.location?.href).host] });
	return map.add3DTiles(root, { id, maxSSE: 16, ...opts, requestTransform, attribution });
}

/** Plugin form: map.use(googleTilesPlugin({ key })) → map.gadget.googleTiles(opts) adds the tileset (opts override the plugin's). */
export function googleTilesPlugin({ key, gadget = "googleTiles", ...defaults } = {}) {
	if (!key) throw new Error("googleTilesPlugin: an API key is required ({ key })");
	return {
		name: "google-tiles",
		version: "0.1.0",
		install(map) {
			map.registry.gadgets.add(gadget, function (opts = {}) { return addGoogle3DTiles(this, { key, ...defaults, ...opts }); });
		},
	};
}
export default googleTilesPlugin;
