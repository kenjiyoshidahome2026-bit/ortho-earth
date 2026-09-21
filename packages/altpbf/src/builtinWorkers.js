// altpbf 自身の worker を作る唯一の場所（2026-09-22）。ホストが自分の入口で走らせる時はビルドの alias で「作らない版」に差し替えられる。
// 役割名 "altpbf:height"（標高タイルの復号）＝ホストの入口は import("altpbf/worker")。
export function builtinWorker(role) {
	if (role === "altpbf:height") return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
	return null;
}
