// ブラウザ（main／worker）で laz-perf（WASM・Apache-2.0）を起こして LAZ のチャンクを解く（#178）。この部品は pointcloud.js から動的 import＝最初の COPC の節まで束に入らない。
//   .wasm は ?url でファイルのまま出す（バンドラが base64 に埋めない）
import { createLazPerf } from "laz-perf";
import lazWasmUrl from "laz-perf/lib/web/laz-perf.wasm?url";
import { decodeLazChunk } from "./laz.js";
let LP = null;
const lazPerf = () => LP ??= createLazPerf({ locateFile: () => new URL(lazWasmUrl, self.location.href).href });
export async function decodeLaz(bytes, opts) { return decodeLazChunk(await lazPerf(), bytes, opts); }
