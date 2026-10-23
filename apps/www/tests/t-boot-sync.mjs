// 起動画面（#boot）の写しの門（2026-10-23）＝正本 packages/globe/src/boot/screen.ts から配った物がずれていないか。
//   ・静的な頁（public/maplibre の一覧と 139 の例）＝boot-sync.mjs の写しが今の正本と同じ（ずれたら node apps/www/scripts/boot-sync.mjs）
//   ・www のトップ＝印（<!-- ortho:boot -->）と vite の bootScreen（デモ一覧の頁は t-demo-pages.mjs が見る）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { withBootStatic, BOOT_SLOT } from "../../../packages/globe/src/boot/screen.ts";
import { targets } from "../scripts/boot-sync.mjs";

const WWW = path.dirname(import.meta.dirname);

test("静的な頁（maplibre の一覧と例）の起動画面＝正本と同じ写し", () => {
	const t = targets();
	assert.ok(t.length > 100, `${t.length} files`);
	const stale = t.filter(([f, until]) => { const s = readFileSync(f, "utf8"); return withBootStatic(s, until) !== s; }).map(([f]) => path.relative(WWW, f));
	assert.deepEqual(stale, [], "run node apps/www/scripts/boot-sync.mjs");
});

test("www のトップ＝起動画面の印と bootScreen", () => {
	assert.ok(readFileSync(path.join(WWW, "index.html"), "utf8").includes(BOOT_SLOT));
	assert.ok(/\bbootScreen\b/.test(readFileSync(path.join(WWW, "vite.config.js"), "utf8")));
});
