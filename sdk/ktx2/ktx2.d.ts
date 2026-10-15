/** @ortho-earth/ktx2 — KTX2 / Basis Universal transcoder plugin for @ortho-earth/globe (registry.textureTranscoders "ktx2") */
export interface Ktx2PluginOptions {
	/** Directory holding basis_transcoder.js and basis_transcoder.wasm (trailing slash optional). Default: unpkg copy of @loaders.gl/textures (pinned). Self-host to stay first-party. */
	libraryPath?: string | null;
	/** Registry name (default "ktx2") */
	name?: string;
}
export interface Ktx2Plugin { name: "ktx2"; version: string; install(map: unknown): void }
export function ktx2Plugin(opts?: Ktx2PluginOptions): Ktx2Plugin;
export default ktx2Plugin;
/** The URL the plugin registers (transcode.js with the library path in the hash) */
export function transcoderUrl(opts?: { libraryPath?: string | null }): string;
export const DEFAULT_LIBRARY_PATH: string;
export function isKTX2(bytes: Uint8Array): boolean;
export function isBasis(bytes: Uint8Array): boolean;
export function ktx2Header(bytes: Uint8Array): { vkFormat: number; typeSize: number; width: number; height: number; depth: number; layers: number; faces: number; levels: number; supercompression: number } | null;
export function libraryPath(url?: string): string;
