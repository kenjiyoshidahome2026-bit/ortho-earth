// エンジン自身の worker を作る唯一の場所（2026-09-22）。ホストが自分の入口で走らせる時はビルドの alias で「作らない版」に差し替えられる。
// 役割名 "ortho:scene"（シーンの結合）・"ortho:tile"（タイルの取得・解読・三角形化）・"ortho:height"（標高タイル）＝ホストの入口は import("@ortho-earth/core/workers/scene" | "…/tile" | "…/elevation")。
// alias（globe の engineAliases・scripts/deps-map.mjs）は "./builtinWorkers.(js|ts)" を文字どおりに差し替える＝この名と置き場を変えないこと。
import type { WorkerRole } from "./workerFactory.ts";
/** エンジン自身の worker を作る唯一の場所。知らない役割は null。 */
export function builtinWorker(role: WorkerRole): Worker | null {
	if (role === "ortho:scene") return new Worker(new URL("./workers/sceneworker.ts", import.meta.url), { type: "module" });
	if (role === "ortho:tile") return new Worker(new URL("./workers/tileworker.ts", import.meta.url), { type: "module" });
	if (role === "ortho:height") return new Worker(new URL("./elevation/worker.ts", import.meta.url), { type: "module" });   // 標高タイルの復号（2026-09-25 に altpbf から移設）
	return null;
}
