// "geopbf/topology"＝GintBUF の pack／unpack（§6）
import type { GeoPBF, UnPackGint } from "./geopbf.js";
/** GeoPBF から GintBUF（format 5）を焼く（wasm は初期化済みであること・Node は geopbf/convert/node-gint の initGintWasm） */
export function topology(pbf: GeoPBF, options?: { shared?: boolean }): ArrayBuffer | SharedArrayBuffer;
export function unPackGintBuffer(gintBuf: ArrayBuffer | SharedArrayBuffer | ArrayBufferView): UnPackGint | null;
export function repackGintBuffer(d: UnPackGint): ArrayBuffer;
export function attachLazyStreams<T extends object>(d: T): T & UnPackGint;
export function rebuildStreams(d: UnPackGint): UnPackGint;
export function isSharedView(v: unknown): boolean;
