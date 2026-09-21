// builtinWorkers.js の「作らない版」（2026-09-22）。ホストが自分の worker 入口で部品を走らせる時に、ビルドの alias で差し替える。
// 中身は汎用＝geopbf・ortho-core・altpbf・geoedit の builtinWorkers.js（同じ形）どれの代わりにも使える。
// ここには new Worker が無い＝バンドラは geopbf 自身の worker を組み立てない。ホストの workerFactory が必ず Worker を返すこと
// （null を返すと geopbf は worker を作れず、その変換は null を返す）。
export function builtinWorker(role) {
	console.warn(`[worker] no built-in worker (builtinWorkers.none.js alias) and the host factory declined "${role}"`);
	return null;
}
