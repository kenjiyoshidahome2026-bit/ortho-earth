// worker の入口を外から差し替える口（2026-09-22）。
// geopbf は形式ごとの変換・解析・COG・タイル書き出しを自分の worker（src/worker.js・cog/worker.js・convert/tile-worker.js）で走らせる。
// バンドラ（vite）は worker ごとに独立ビルドを回すので、ホストが自分の worker を持つと geopbf の核（pbf-base 等）が両方に入って
// 別々に読み込まれる。ホストが自分の入口 1 本へ寄せたい時は、役割名から Worker を作る関数を渡す（null を返せば既定＝geopbf 自身）。
//   役割名："decoder:<形式>"・"encoder:<形式>"（src/worker.js の表と同じ）・"geopbf:cog"・"geopbf:tile"
//   ホストの worker では、その名前の時に import("geopbf/worker") すればよい（入口は self.name で役割を読む）。
let hostFactory = null;
export function setWorkerFactory(fn) { hostFactory = typeof fn === "function" ? fn : null; }
export const hasWorkerFactory = () => !!hostFactory;
// role＝役割名・fallback＝geopbf 自身の worker を作る関数（new Worker(new URL(…)) の直書き＝バンドラに見せたまま）
export function spawnWorker(role, fallback) {
	if (hostFactory) { try { const w = hostFactory(role); if (w) return w; } catch (e) { console.warn(`[geopbf] host worker factory failed for "${role}" = using the built-in worker`, e); } }
	return fallback ? fallback() : null;
}
