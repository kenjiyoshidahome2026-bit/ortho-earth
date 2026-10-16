// extension/topology.js の型（TS化 段 3・convert/tiler・node-gint が読む分だけ）。extension/topology.js が .ts になったら（段 4）このファイルは消す
import type { GeoPBFBase, UnPackGint } from "../../types/geopbf.js";
/** GintBUF を焼く（gint.initialize() 済みが前提）。shared:true＝SharedArrayBuffer に直に組む */
export function topology(self: GeoPBFBase, opts?: { shared?: boolean }): ArrayBuffer | SharedArrayBuffer;
export function attachLazyStreams(d: UnPackGint): UnPackGint;
/** GintBUF（format 5）を解く。読めなければ null */
export function unPackGintBuffer(GintBUF: ArrayBuffer | SharedArrayBuffer | ArrayBufferView): UnPackGint | null;
export const isSharedView: (v: unknown) => boolean;
export function repackGintBuffer(d: UnPackGint): ArrayBuffer;
export function rebuildStreams(d: UnPackGint): UnPackGint;
