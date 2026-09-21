// geoedit 自身の worker を作る唯一の場所（2026-09-22）。ホストが自分の入口で走らせる時はビルドの alias で「作らない版」に差し替えられる
// （geopbf/no-builtin-workers と同じ・README「ホスト契約」）。役割名 "geoedit:model"＝ホストの入口は import("geoedit/model-worker")。
export function builtinWorker(role) {
	if (role === "geoedit:model") return new Worker(new URL("./model-worker.js", import.meta.url), { type: "module", name: "geoedit-model" });
	return null;
}
