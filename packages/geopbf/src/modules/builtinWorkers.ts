// geopbf 自身の worker を作る唯一の場所（2026-09-22）。入口は src/worker.ts 1 本＝役割（形式）は Worker の name で指名する。
//   "decoder:<形式>"・"encoder:<形式>"・"decoder:pbf"・"decoder:gint"・"geopbf:cog"（COG の復号）・"geopbf:tile"（PMTiles のタイル書き出し）
// new Worker(new URL(…, import.meta.url)) の直書きはバンドラ（vite）が worker として組み立てる目印＝ここ 1 か所にしか書かない。
// name は変数＝vite の options 静的解析は通らない＝@vite-ignore（worker の組み立て自体は vite が行う・実行時の env 注入だけ省かれる）。
// ホストが自分の入口で geopbf を走らせる時（createGeopbf の workerFactory / setWorkerFactory）は、ビルドの alias でこのファイルを
// builtinWorkers.none.ts に差し替えると geopbf 自身の worker は組み立てられない＝配布物から消える（README「Worker entry」）。
// URL は "../worker.ts" と書く（vite はそのまま解決・npm の dist では pack-ts が ".js" に直す・TS 化 段 3）
export function builtinWorker(role: string): Worker | null {
	return new Worker(new URL("../worker.ts", import.meta.url), /* @vite-ignore */ { type: "module", name: role });
}
