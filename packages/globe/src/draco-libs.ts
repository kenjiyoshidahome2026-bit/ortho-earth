// Draco の復号器をエンジンに同梱する（通信なしで PLATEAU の建物を解く・2026-11-12）。
// loaders.gl の既定は、Draco を unpkg の classic worker（draco-worker.js）で解き、その中で gstatic の
// draco_wasm_wrapper.js と draco_decoder.wasm を importScripts／fetch する＝3 つとも外の CDN。通信なしでは解けず、
// LOD1 の建物が欠けた（Mac 本番 2026-11-12・旭区 鶴ヶ峰）。しかもその classic worker はどの SW の管理下にも無い＝端末の束からも読めない。
// ここでは loaders.gl 4.5 に同梱の 2 ファイル（vendor/draco/・draco 1.5.6・MIT/Apache-2.0）を同じオリジンに置き、
// 呼び手の worker（meshworker・model-worker）の中で解く（worker: false）。復号器は fetchOrPack で取る＝通信なしは端末の束から。
// 中身の読み込みは Draco の塊に初めて当たった時だけ（createDecoderModule が呼ばれた時）＝Draco の無いタイルでは 1 バイトも取らない。
import { fetchOrPack } from "./packfetch.ts";

let lib: Promise<[(o: Record<string, unknown>) => unknown, ArrayBuffer]> | null = null;

/** emscripten の UMD（CommonJS・AMD・Node の枝を持つ）を関数に。module・exports・define・require・process を塞いで頁／worker の枝に乗せる */
export function dracoFactory(src: string): (o: Record<string, unknown>) => unknown {
	return new Function("module", "exports", "define", "require", "process", src + "\n;return DracoDecoderModule;")() as (o: Record<string, unknown>) => unknown;
}

const load = () => lib ??= (async () => {
	const [{ default: jsUrl }, { default: wasmUrl }] = await Promise.all([import("./vendor/draco/draco_wasm_wrapper.js?url"), import("./vendor/draco/draco_decoder.wasm?url")]);
	// loaders.gl は最初の復号器の約束を worker の寿命の間ずっと覚える（失敗も）＝一瞬の途切れで建物が出なくならないよう 3 回まで取り直す
	const get = async (u: string) => { for (let i = 0; ; i++) { try { const r = await fetchOrPack(u); if (r.ok) return r; if (i >= 2) throw new Error(`draco: ${r.status} ${u}`); } catch (e) { if (i >= 2) throw e; } await new Promise(z => setTimeout(z, 1000 * 3 ** i)); } };
	const [js, wasm] = await Promise.all([get(jsUrl).then(r => r.text()), get(wasmUrl).then(r => r.arrayBuffer())]);
	return [dracoFactory(js), wasm] as [(o: Record<string, unknown>) => unknown, ArrayBuffer];
})().catch(e => { lib = null; throw e; });   // 失敗は覚えない＝通信が戻れば次で取れる

/** loaders.gl の modules.draco3d の形（createDecoderModule）。wasm は options を通さず直に渡す（loaders.gl の options の合成は ArrayBuffer を空にする） */
export const draco3d = { createDecoderModule: (o: Record<string, unknown> = {}) => load().then(([f, wasm]) => f({ ...o, wasmBinary: wasm })) };

/** Node（焼きスクリプト bake-plateau.mjs・試験）＝頁でも worker でもない。Node は ?url の import が wasm を ES モジュールとして読みに行って倒れる
 *  （Mac 2026-11-12：横浜の焼きが全タイル「Cannot find package 'a' imported from …draco_decoder.wasm」）＝呼び手が setLoaderOptions で注入した draco3d（npm）に任せる */
const IS_NODE = typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "string";

/** loadParse に混ぜる選択肢＝Draco をこの worker の中で同梱の復号器で解く（CDN の worker を作らない）。Node では何も足さない（従来どおり） */
export const DRACO_OPTS: Record<string, unknown> = IS_NODE ? {} : { core: { worker: false }, modules: { draco3d } };
