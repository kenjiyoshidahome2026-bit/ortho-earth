/** @ortho-earth/google-tiles — Google Photorealistic 3D Tiles for @ortho-earth/globe (key, session token, attribution on top of add3DTiles requestTransform) */
export const GOOGLE_3D_TILES_ROOT: string;
export const GOOGLE_TILES_HOST: string;
export interface GoogleRequestTransform {
	(url: string, type?: "Source" | "Tile"): { url: string } | null;
	/** the last session token seen in a request URL (null until the root tileset hands one out) */
	readonly session: string | null;
}
/** Adds key=… to every request to `hosts` (default tile.googleapis.com) and carries session=… to later requests that lack it. Other hosts: untouched (null). */
export function googleRequestTransform(opts: { key: string; session?: string | null; hosts?: string[] }): GoogleRequestTransform;
/** "Google; <provider>; <provider>…" from the copyrights of the tiles on screen (most frequent first) */
export function googleAttribution(copyrights?: string[]): string;
export interface GoogleTilesOptions {
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
/** map.add3DTiles(root, …) with Google's key, session and attribution. Resolves to the tileset handle (stats, pick, copyrights, remove …) */
export function addGoogle3DTiles(map: { add3DTiles(url: string, opts?: Record<string, unknown>): Promise<unknown> }, opts: GoogleTilesOptions): Promise<any>;
export interface GoogleTilesPlugin { name: "google-tiles"; version: string; install(map: unknown): void }
/** map.use(googleTilesPlugin({ key })) → map.gadget.googleTiles(opts) */
export function googleTilesPlugin(opts: GoogleTilesOptions & { gadget?: string }): GoogleTilesPlugin;
export default googleTilesPlugin;
