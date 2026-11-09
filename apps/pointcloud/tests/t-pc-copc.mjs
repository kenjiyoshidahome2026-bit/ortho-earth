// COPC 版の台帳（pc-copc.ts・2026-11-09）の検定。node tests/t-pc-copc.mjs
//  ① 台帳の形を確かめる（壊れた物・知らない図郭の名・大きさ 0 は落とす）
//  ② S3 の鍵 → COPC の置き場（組・図郭の大文字・.zip を外す）・台帳に無ければ null
import assert from "node:assert/strict";
import { parseCopcIndex, copcOf, HF_BASE } from "../pc-copc.ts";

let tn = 0;
const t = (name, fn) => { fn(); tn++; console.log("  ✔", name); };

t("① 台帳の形", () => {
	assert.deepEqual(parseCopcIndex(null), { version: 1, sets: {} });
	assert.deepEqual(parseCopcIndex({ version: 2, sets: { "2021/LP/Original": { "08ND7794": 1 } } }), { version: 1, sets: {} });
	const ix = parseCopcIndex({ version: 1, sets: { "2021/LP/Original": { "08ND7794": 58121104, "08ZZ0000": 5, "08ND7795": 0, "x": 3 }, "../evil": { "08ND7794": 1 } } });
	assert.deepEqual(ix, { version: 1, sets: { "2021/LP/Original": { "08ND7794": 58121104 } } });
});

t("② S3 の鍵 → COPC の置き場", () => {
	const ix = parseCopcIndex({ version: 1, sets: { "2021/LP/Original": { "08ND7794": 58121104 } } });
	assert.deepEqual(copcOf(ix, "2021/LP/Original/08/ND/77/08ND7794.zip"), { path: "2021/LP/Original/08ND7794.copc.laz", url: HF_BASE + "2021/LP/Original/08ND7794.copc.laz", size: 58121104 });
	assert.equal(copcOf(ix, "2021/LP/Original/08/nd/77/08nd7794.zip")?.path, "2021/LP/Original/08ND7794.copc.laz");   // 小文字の階層・名
	assert.equal(copcOf(ix, "2021/LP/Ground/08/ND/77/08ND7794.zip"), null);   // 組が違う
	assert.equal(copcOf(ix, "2021/LP/Original/08/ND/77/08ND7795.zip"), null);   // 台帳に無い
	assert.equal(copcOf(ix, "08ND7794.zip"), null);
	assert.equal(copcOf(ix, "2021/LP/Original/08/ND/77/08ND7794.zip", "https://x/")?.url, "https://x/2021/LP/Original/08ND7794.copc.laz");
});

console.log(`t-pc-copc: ${tn} passed`);
