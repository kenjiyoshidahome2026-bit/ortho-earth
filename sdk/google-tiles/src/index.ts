// @ortho-earth/google-tiles — Google Photorealistic 3D Tiles for @ortho-earth/globe.
//   The globe's add3DTiles already streams any 3D Tiles tileset and lets each tileset rewrite its requests (requestTransform, F5).
//   This package is the Google-specific part on top of that extension point:
//     - every request to tile.googleapis.com carries your API key (key=…); requests to any other host are left untouched (the key never leaks);
//     - the session token that Google puts in the child tileset URIs (session=…) is remembered and added to later requests that lack it
//       (the content URIs inside those child tilesets are relative and come without it);
//     - the attribution: "Google" plus the data providers of the tiles on screen (glTF asset.copyright, split on ";", most frequent first).
//   The key is passed in by the app at run time. Nothing here stores, logs or bundles it.
import type { OrthoJapanMap, OrthoPlugin, Tiles3DOptions, Tiles3DHandle } from "@ortho-earth/globe";

export const GOOGLE_3D_TILES_ROOT = "https://tile.googleapis.com/v1/3dtiles/root.json";
export const GOOGLE_TILES_HOST = "tile.googleapis.com";

/** requestTransform for add3DTiles: (url, type) → { url } | null. state: .session (last session token seen) */
export interface GoogleRequestTransform {
	(url: string, type?: "Source" | "Tile"): { url: string } | null;
	/** the last session token seen in a request URL (null until the root tileset hands one out) */
	readonly session: string | null;
}
export interface GoogleRequestTransformOptions {
	/** Map Tiles API key (kept by your app; never bundled) */
	key: string;
	/** a session token to start with (default: none until the root tileset hands one out) */
	session?: string | null;
	/** hosts that receive the key (default tile.googleapis.com) */
	hosts?: string[];
}
export interface GoogleTilesOptions extends Omit<Tiles3DOptions, "id" | "requestTransform"> {
	/** Map Tiles API key (kept by your app; never bundled) */
	key: string;
	/** root tileset (default GOOGLE_3D_TILES_ROOT) */
	root?: string;
	/** hosts that receive the key (default: the root's host) */
	hosts?: string[];
	/** tileset id (default "google-3d") */
	id?: string;
	/** attribution text from the copyrights (default googleAttribution) */
	attribution?: string | ((copyrights: string[]) => string | null);
	[k: string]: unknown;
}
export interface GoogleTilesPluginOptions extends GoogleTilesOptions { gadget?: string }
export interface GoogleTilesPlugin extends OrthoPlugin { name: "google-tiles"; version: string; install(map: OrthoJapanMap): void }
/** add3DTiles を持つ map（@ortho-earth/globe の map・検定では偽の map） */
export type GoogleTilesMap = Pick<OrthoJapanMap, "add3DTiles">;

// 省略（undefined）は {} と同じ＝鍵の有無は実行時に検める（JS から呼ばれても同じ例外）
const optsOf = <T extends object>(o: T | undefined): Partial<T> => o ?? {};

/** Adds key=… to every request to `hosts` (default tile.googleapis.com) and carries session=… to later requests that lack it. Other hosts: untouched (null). */
export function googleRequestTransform(opts: GoogleRequestTransformOptions): GoogleRequestTransform {
	const { key = "", session = null, hosts = [GOOGLE_TILES_HOST] } = optsOf(opts);
	if (!key || typeof key !== "string") throw new Error("googleRequestTransform: an API key is required ({ key })");
	const allow = new Set(hosts.map(h => String(h).toLowerCase()));
	let current: string | null = session || null;
	const rt = (url: string): { url: string } | null => {
		let u: URL;
		try { u = new URL(url); } catch { return null; }
		if (!allow.has(u.host.toLowerCase())) return null;   // not Google: leave as is (no key on foreign hosts)
		const s = u.searchParams.get("session");
		if (s) current = s;
		else if (current) u.searchParams.set("session", current);
		if (!u.searchParams.has("key")) u.searchParams.set("key", key);
		return { url: u.href };
	};
	Object.defineProperty(rt, "session", { get: () => current, enumerable: true });
	return rt as GoogleRequestTransform;   // defineProperty で生やした getter は型に写らない＝ここだけ名乗る
}

/** Attribution text: "Google" first, then the data providers (already ordered by the globe: most frequent first). Duplicates of "Google" are folded. */
export function googleAttribution(copyrights: string[] = []): string {
	const rest = copyrights.map(c => String(c).trim()).filter(c => c && !/^google$/i.test(c));
	return ["Google", ...rest].join("; ");
}

/** map.add3DTiles(root, { requestTransform, attribution, ...opts }) with Google's key / session / attribution. Returns the tileset handle. */
export function addGoogle3DTiles(map: GoogleTilesMap, opts: GoogleTilesOptions): Promise<Tiles3DHandle> {
	const { key = "", root = GOOGLE_3D_TILES_ROOT, hosts, id = "google-3d", attribution = googleAttribution, ...rest } = optsOf(opts);
	if (typeof map?.add3DTiles !== "function") throw new Error("addGoogle3DTiles: map.add3DTiles is required (@ortho-earth/globe)");
	const requestTransform = googleRequestTransform({ key, hosts: hosts ?? [new URL(root, globalThis.location?.href).host] });
	return map.add3DTiles(root, { id, maxSSE: 16, ...rest, requestTransform, attribution });
}

/** Plugin form: map.use(googleTilesPlugin({ key })) → map.gadget.googleTiles(opts) adds the tileset (opts override the plugin's). */
export function googleTilesPlugin(opts: GoogleTilesPluginOptions): GoogleTilesPlugin {
	const { key = "", gadget = "googleTiles", ...defaults } = optsOf(opts);
	if (!key) throw new Error("googleTilesPlugin: an API key is required ({ key })");
	return {
		name: "google-tiles",
		version: "0.1.0",
		install(map: OrthoJapanMap): void {
			map.registry.gadgets.add(gadget, function (this: OrthoJapanMap, o: Partial<GoogleTilesOptions> = {}) { return addGoogle3DTiles(this, { key, ...defaults, ...o }); });
		},
	};
}
export default googleTilesPlugin;
