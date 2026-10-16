// worker の入口を外から差し替える口（2026-09-22・geopbf の modules/workerFactory.js と同じ形）。
// バンドラ（vite）は worker ごとに独立ビルドを回す＝ホストが自分の worker を持つと共有部品（geopbf の核など）が両方に入る。
// ホストは役割名から Worker を作る関数を渡す（null を返せば既定＝このパッケージ自身の worker）。new Worker の直書きは builtinWorkers.ts 1 か所。
export type WorkerRole = "ortho:scene" | "ortho:tile" | "ortho:height";
/** ホストの worker 工場。役割名だけを受け取る（fn(role)）。null／undefined を返せば組み込みの worker。 */
export type WorkerFactory = (role: WorkerRole) => Worker | null | undefined;
let hostFactory: WorkerFactory | null = null;
/** worker の入口を差し替える（役割 "ortho:scene" / "ortho:tile" / "ortho:height"）。null＝既定へ戻す。 */
export function setWorkerFactory(fn: WorkerFactory | null | undefined): void { hostFactory = typeof fn === "function" ? fn : null; }
export function spawnWorker(role: WorkerRole, fallback?: (() => Worker | null) | null): Worker | null {
	if (hostFactory) { try { const w = hostFactory(role); if (w) return w; } catch (e) { console.warn(`[worker] host factory failed for "${role}" = using the built-in worker`, e); } }
	return fallback ? fallback() : null;
}
