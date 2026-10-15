// @ortho-earth/ktx2 — the worker-side transcoder module (contract: registry.textureTranscoders of @ortho-earth/globe).
// Self-contained on purpose: the globe's model worker import()s this file by URL, so it must not import anything itself.
// basis_universal's transcoder (basis_transcoder.js + .wasm, the build shipped in @loaders.gl/textures) is fetched on the first
// transcode() from the library path, which the plugin passes in the URL hash: transcode.js#lib=<url-encoded directory>.
// Default = unpkg copy of @loaders.gl/textures (pinned). Self-host the two files and pass libraryPath to keep everything first-party.
export const DEFAULT_LIBRARY_PATH = "https://unpkg.com/@loaders.gl/textures@4.4.3/dist/libs/";
const RGBA32 = 13;   // basist::transcoder_texture_format::cTFRGBA32
const KTX2_MAGIC = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];   // «KTX 20»\r\n\x1A\n
export const isKTX2 = (u8: Uint8Array | null | undefined): boolean => u8 != null && u8.length >= 48 && KTX2_MAGIC.every((b, i) => u8[i] === b);
export const isBasis = (u8: Uint8Array | null | undefined): boolean => u8 != null && u8.length >= 2 && u8[0] === 0x73 && u8[1] === 0x42;   // "sB"
/** KTX2 のヘッダ（WASM 無しで読める欄） */
export interface Ktx2Header { vkFormat: number; typeSize: number; width: number; height: number; depth: number; layers: number; faces: number; levels: number; supercompression: number }
/** transcode() の戻り＝素の RGBA8（level 0・layer 0・face 0） */
export interface TranscodeResult { width: number; height: number; rgba: Uint8Array; hasAlpha: boolean }
/** KTX2 header (no WASM needed): vkFormat 0 = Basis Universal (supercompressed or UASTC) */
export function ktx2Header(u8: Uint8Array): Ktx2Header | null {
	if (!isKTX2(u8)) return null;
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), g = (o: number): number => dv.getUint32(o, true);
	return { vkFormat: g(12), typeSize: g(16), width: g(20), height: g(24), depth: g(28), layers: g(32), faces: g(36), levels: g(40), supercompression: g(44) };
}
/** The library directory this module instance uses (from the URL hash, else the default) */
export function libraryPath(url: string = import.meta.url): string {
	try { const lib = new URLSearchParams(new URL(url).hash.replace(/^#/, "")).get("lib"); if (lib) return lib.endsWith("/") ? lib : lib + "/"; } catch { /* fall through */ }
	return DEFAULT_LIBRARY_PATH;
}
// basis_universal の Emscripten module（この道具が触る口だけ）
interface KTX2File {
	isValid(): boolean; getWidth(): number; getHeight(): number; startTranscoding(): boolean;
	getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number;
	transcodeImage(dst: Uint8Array, level: number, layer: number, face: number, format: number, getAlphaForOpaque: number, channel0: number, channel1: number): boolean;
	getHasAlpha(): boolean; close(): void; delete(): void;
}
interface BasisFile {
	startTranscoding(): boolean; getImageWidth(image: number, level: number): number; getImageHeight(image: number, level: number): number;
	getImageTranscodedSizeInBytes(image: number, level: number, format: number): number;
	transcodeImage(dst: Uint8Array, image: number, level: number, format: number, unused: number, getAlphaForOpaque: number): boolean;
	getHasAlpha(): boolean; close(): void; delete(): void;
}
interface BasisModule { initializeBasis(): void; KTX2File: new (bytes: Uint8Array) => KTX2File; BasisFile: new (bytes: Uint8Array) => BasisFile }
type BasisFactory = (opts: { wasmBinary: ArrayBuffer }) => Promise<BasisModule>;
let modP: Promise<BasisModule> | null = null;
async function loadModule(): Promise<BasisModule> {
	return modP ??= (async () => {
		const base = libraryPath();
		async function get(name: string, as: "text"): Promise<string>;
		async function get(name: string, as: "bin"): Promise<ArrayBuffer>;
		async function get(name: string, as: "text" | "bin"): Promise<string | ArrayBuffer> { const r = await fetch(base + name, { credentials: "omit" }); if (!r.ok) throw new Error(`ktx2: HTTP ${r.status} for ${base}${name}`); return as === "text" ? r.text() : r.arrayBuffer(); }
		const [js, wasmBinary] = await Promise.all([get("basis_transcoder.js", "text"), get("basis_transcoder.wasm", "bin")]);
		// The script is a UMD-ish Emscripten wrapper: `var BASIS = (…)(); if (typeof exports === 'object' && typeof module === 'object') module.exports = BASIS;`
		const mod: { exports?: unknown } = {};
		const factory: unknown = new Function("module", "exports", js + "\n;return module.exports || (typeof BASIS !== 'undefined' ? BASIS : null);")(mod, mod.exports = {});
		if (typeof factory !== "function") throw new Error("ktx2: basis_transcoder.js did not yield a module factory");
		const B = await (factory as BasisFactory)({ wasmBinary });   // resolves with the Emscripten module (BASIS.ready)
		B.initializeBasis();
		if (typeof B.KTX2File !== "function" || typeof B.BasisFile !== "function") throw new Error("ktx2: transcoder build lacks KTX2File/BasisFile");
		return B;
	})().catch((e: unknown) => { modP = null; throw e; });
}
/** Transcode one KTX2 (Basis/UASTC) or .basis file to RGBA8 (level 0, layer 0, face 0). Returns { width, height, rgba, hasAlpha } */
export async function transcode(bytes: Uint8Array | ArrayBuffer | ArrayLike<number>): Promise<TranscodeResult> {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const ktx = isKTX2(u8);
	if (!ktx && !isBasis(u8)) throw new Error("ktx2: not a KTX2 or .basis file");
	const B = await loadModule();
	if (ktx) {
		const f = new B.KTX2File(u8);
		try {
			if (!f.isValid()) throw new Error("ktx2: invalid KTX2 file");
			const width = f.getWidth(), height = f.getHeight();
			if (!f.startTranscoding()) throw new Error("ktx2: startTranscoding failed");
			const rgba = new Uint8Array(f.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32));
			if (!f.transcodeImage(rgba, 0, 0, 0, RGBA32, 0, -1, -1)) throw new Error("ktx2: transcodeImage failed");
			return { width, height, rgba, hasAlpha: !!f.getHasAlpha() };
		} finally { f.close(); f.delete(); }
	}
	const f = new B.BasisFile(u8);
	try {
		if (!f.startTranscoding()) throw new Error("ktx2: startTranscoding failed (.basis)");
		const width = f.getImageWidth(0, 0), height = f.getImageHeight(0, 0);
		const rgba = new Uint8Array(f.getImageTranscodedSizeInBytes(0, 0, RGBA32));
		if (!f.transcodeImage(rgba, 0, 0, RGBA32, 0, 0)) throw new Error("ktx2: transcodeImage failed (.basis)");
		return { width, height, rgba, hasAlpha: !!f.getHasAlpha() };
	} finally { f.close(); f.delete(); }
}
