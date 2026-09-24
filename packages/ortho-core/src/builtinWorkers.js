// エンジン自身の worker を作る唯一の場所（2026-09-22）。ホストが自分の入口で走らせる時はビルドの alias で「作らない版」に差し替えられる。
// 役割名 "ortho:scene"（シーンの結合）・"ortho:tile"（タイルの取得・解読・三角形化）・"ortho:height"（標高タイル）＝ホストの入口は import("@ortho-earth/core/workers/scene" | "…/tile" | "…/elevation")。
export function builtinWorker(role) {
	if (role === "ortho:scene") return new Worker(new URL("./workers/sceneworker.js", import.meta.url), { type: "module" });
	if (role === "ortho:tile") return new Worker(new URL("./workers/tileworker.js", import.meta.url), { type: "module" });
	if (role === "ortho:height") return new Worker(new URL("./elevation/worker.js", import.meta.url), { type: "module" });   // 標高タイルの復号（2026-09-25 に altpbf から移設）
	return null;
}
