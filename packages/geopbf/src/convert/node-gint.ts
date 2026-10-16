// convert/node-gint.js ── Node で GintBUF を焼く（CLI 用）。wasm を fetch でなくバイト列で初期化する（tests/edit/t-large.mjs と同じ手）。
// JS 位相フォールバックは共有点を落とす既知バグがある（8/26 実測）ので、wasm が読めなければ明示エラー。
import { readFile } from "node:fs/promises";

let ready = null;
export async function initGintWasm() {
	return ready ??= (async () => {
		const wasmJs = new URL("../../wasm/pkg/gint_wasm.js", import.meta.url);
		const mod = await import(wasmJs.href);
		await mod.default({ module_or_path: await readFile(new URL("../../wasm/pkg/gint_wasm_bg.wasm", import.meta.url)) });
		const { gint } = await import("../extension/gint.js");
		await gint.initialize();
		return true;
	})();
}

export async function bakeGint(pbf) {
	await initGintWasm();
	const { topology } = await import("../extension/topology.js");
	return topology(pbf);
}
