// Get started の「コードで作る」の手順（index.html の最初の section.card.path の pre.code）が、手順書 public/start.md に一字一句あるか。
// start.md のコード片は packages/globe の verify:npm が公開物で実走させる＝頁の片がそこから外れると「どの手順も検定済み」が嘘になる（2026-09-25）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const unesc = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const html = read("index.html"), start = read("public/start.md");
const panel = html.slice(html.indexOf('id="panel-start"'));
const code = panel.slice(panel.indexOf('<section class="card path">'), panel.indexOf("</section>"));
const blocks = [...code.matchAll(/<pre class="code"[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)].map(m => unesc(m[1]));

test("コードの道に手順のコード片がある", () => assert.ok(blocks.length >= 5, `pre.code が ${blocks.length} 個`));
for (const [i, b] of blocks.entries())
	test(`片 ${i + 1}（${b.split("\n")[0].slice(0, 40)}…）が start.md にそのままある`, () => assert.ok(start.includes(b), `start.md に無い：\n${b}`));
