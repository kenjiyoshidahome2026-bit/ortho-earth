// geopbf 自身の worker を作る唯一の場所（2026-09-22）。入口は src/worker.js 1 本＝役割（形式）は Worker の name で指名する。
//   "decoder:<形式>"・"encoder:<形式>"・"decoder:pbf"・"decoder:gint"・"geopbf:cog"（COG の復号）・"geopbf:tile"（PMTiles のタイル書き出し）
// new Worker(new URL(…, import.meta.url)) の直書きはバンドラ（vite）が worker として組み立てる目印＝ここ 1 か所にしか書かない。
// name は変数＝vite の options 静的解析は通らない＝@vite-ignore（worker の組み立て自体は vite が行う・実行時の env 注入だけ省かれる）。
// ホストが自分の入口で geopbf を走らせる時（createGeopbf の workerFactory / setWorkerFactory）は、ビルドの alias でこのファイルを
// builtinWorkers.none.js に差し替えると geopbf 自身の worker は組み立てられない＝配布物から消える（README「Worker entry」）。
export function builtinWorker(role) {
	return new Worker(new URL("../worker.js", import.meta.url), /* @vite-ignore */ { type: "module", name: role });
}
