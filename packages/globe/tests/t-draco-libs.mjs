// 同梱の Draco 復号器（src/draco-libs.ts・2026-11-12）の検定。node packages/globe/tests/t-draco-libs.mjs
//  ① vendor/draco の wrapper を dracoFactory で関数にし、wasm を直に渡して loaders.gl の DracoLoader が解ける（worker を作らない）
//  ② 復号の呼び手（meshdecode.ts の 2 か所・tiles3d-decode.ts）が DRACO_OPTS を混ぜている＝CDN の worker・復号器へ戻らない
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "@loaders.gl/core";
import { DracoLoader } from "@loaders.gl/draco";
import { dracoFactory } from "../src/draco-libs.ts";

const V = new URL("../src/vendor/draco/", import.meta.url);
const f = dracoFactory(readFileSync(new URL("draco_wasm_wrapper.js", V), "utf8"));
assert.equal(typeof f, "function");
const wasm = new Uint8Array(readFileSync(new URL("draco_decoder.wasm", V))).buffer;
// 小さな Draco の塊を作る代わりに draco3d の見本（bunny.drc）があれば使う・無ければ wasm の起動だけを見る
let drc = null;
try { drc = new Uint8Array(readFileSync(new URL("../../../node_modules/draco3d/bunny.drc", import.meta.url))).buffer; } catch { /* 無い環境 */ }
const draco3d = { createDecoderModule: o => f({ ...o, wasmBinary: wasm }) };
if (drc) {
	const m = await parse(drc, DracoLoader, { core: { worker: false }, modules: { draco3d } });
	assert.ok(m.header.vertexCount > 1000 && m.attributes.POSITION, "Draco の見本が解けない");
	console.log(`  ✓ 同梱の復号器で Draco を解く（頂点 ${m.header.vertexCount}・worker なし）`);
} else {
	const mod = await draco3d.createDecoderModule();
	assert.equal(typeof mod.Decoder, "function");
	console.log("  ✓ 同梱の復号器が起動する（見本なし）");
}
for (const [file, n] of [["meshdecode.ts", 2], ["tiles3d-decode.ts", 1]]) {
	const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
	const hits = src.match(/\.\.\.DRACO_OPTS/g)?.length ?? 0;
	assert.equal(hits, n, `${file}：DRACO_OPTS を混ぜる loadParse が ${hits} 件（期待 ${n}）`);
}
console.log("  ✓ 復号の呼び手 3 か所とも同梱の復号器を使う");
