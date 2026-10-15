// 共有エンジンの「旧版を握ったまま」の救い（packages/globe/scripts/lib/engine-stale.mjs）の書き換えの検定。
// 実ブラウザでの 1 回だけの読み直し（新しい版がある時だけ・同じ版では読み直さない・輪にならない）は 2026-10-14 に Chromium で確認済み。
import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapDynamicImports, engineStale } from "../../../packages/globe/scripts/lib/engine-stale.mjs";

const TAIL = ".catch(e=>{throw globalThis.__oeR?.(),e})";
test("相対の動的 import だけを包む", () => {
	assert.equal(wrapDynamicImports("import(`./assets/cog-x.js`)"), "import(`./assets/cog-x.js`)" + TAIL);
	assert.equal(wrapDynamicImports('import("../a.js")'), 'import("../a.js")' + TAIL);
	for (const s of ["import(url)", "import(`https://x/a.js`)", "import(`./${n}.js`)", "import.meta.url"]) assert.equal(wrapDynamicImports(s), s);
});
test("入口にだけ助け手を置く", () => {
	const p = engineStale();
	assert.match(p.renderChunk("import(`./a.js`)", { isEntry: true }).code, /^globalThis\.__oeR\?\?=/);
	assert.doesNotMatch(p.renderChunk("import(`./a.js`)", { isEntry: false }).code, /__oeR\?\?=/);
	assert.equal(p.renderChunk("let a=1", { isEntry: false }), null);
});
test("助け手の current.json は入口の階に依らず /globe/engine/current.json", () => {
	const code = engineStale().renderChunk("", { isEntry: true }).code;
	assert.doesNotMatch(code, /\(\/\//);   // 正規表現の / が template literal で落ちて // （行の注釈）にならない
	const src = code.match(/import\.meta\.url\.replace\(\/(.*?)\/,"\/current\.json"\)/)[1];
	const re = new RegExp(src);
	for (const u of ["https://x/globe/engine/0123456789/globe.js", "https://x/globe/engine/0123456789/regions/app.js"])
		assert.equal(u.replace(re, "/current.json"), "https://x/globe/engine/current.json");
});
