// ブラウザ（main／worker）で laz-perf（WASM・Apache-2.0）を起こして LAZ のチャンクを解く（#178）。この部品は pointcloud.ts から動的 import＝最初の COPC の節まで束に入らない。
//   .wasm は ?url でファイルのまま出す（バンドラが base64 に埋めない）
import { createLazPerf } from "laz-perf";
import lazWasmUrl from "laz-perf/lib/web/laz-perf.wasm?url";
import { decodeLazChunk, decodeLazFile } from "./laz.ts";
import type { LazPerf, LazBatchFn, LazChunkSpec, LazFileInfo } from "./laz.ts";
let LP: Promise<LazPerf> | null = null;
const lazPerf = (): Promise<LazPerf> => LP ??= createLazPerf({ locateFile: () => new URL(lazWasmUrl, self.location.href).href });
export async function decodeLaz(bytes: Uint8Array | ArrayBuffer, opts: LazChunkSpec): Promise<Uint8Array> { return decodeLazChunk(await lazPerf(), bytes, opts); }
export async function decodeLazWhole(bytes: Uint8Array | ArrayBuffer, onBatch: LazBatchFn): Promise<LazFileInfo> { return decodeLazFile(await lazPerf(), bytes, onBatch); }
