// 「いまの事実」の門（2026-11-11・AI エージェント向け）：facts.js が正本から数えた版と互換の数が、
// llms.txt・llms-full.txt・/facts.json・トップの JSON-LD・README で食い違わないこと。数が変わったら README を直す（ここが止める）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { buildFacts, fillFacts, latestRelease } from "../facts.js";
import { buildLlmsFull, FULL_DOCS, htmlToMarkdown } from "../llms-full.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const f = buildFacts();
const readme = read("../../../README.md");

test("版と公開日：CHANGELOG の先頭と core・globe の package.json が同じ版", () => {
	assert.match(f.release.date, /^\d{4}-\d\d-\d\d$/);
	assert.equal(f.packages["@ortho-earth/core"].version, f.release.version);
	assert.equal(f.packages["@ortho-earth/globe"].version, f.release.version);
	assert.deepEqual(latestRelease("x\n## geopbf 2.1.1 — 2026-11-03\n## 2.4.1 — 2026-11-11\n"), { version: "2.4.1", date: "2026-11-11" });
});

test("互換の数：ギャラリーの採点が揃っている（各段の和＝採点数・参照版が読める）", () => {
	for (const k of ["maplibre", "cesium"]) {
		const c = f.compatibility[k];
		assert.ok(c.graded > 100, k);
		assert.equal(c.samePicture + c.sameAnswers + c.runsPartly + c.doesNotRun, c.graded, k);
		assert.match(c.referenceVersion, /^\d+\.\d+\.\d+$/, k);
	}
});

test("README の数が今の採点と同じ", () => {
	const m = f.compatibility.maplibre, c = f.compatibility.cesium;
	assert.ok(readme.includes(`of the ${m.graded} scorable official examples, ${m.samePicture} give the same picture, ${m.sameAnswers} the same answer and ${m.runsPartly} run`), "README: MapLibre の数");
	assert.ok(readme.includes(`Of ${c.graded} graded Sandcastle examples, ${c.samePicture} give the same picture and ${c.sameAnswers} the same answer`), "README: CesiumJS の数");
	assert.ok(readme.includes(`\`@ortho-earth/cesium\` ${f.packages["@ortho-earth/cesium"].version})`), "README: @ortho-earth/cesium の版");
	assert.ok(readme.includes(`MapLibre: ${m.graded - m.samePicture} of ${m.graded} graded`), "README Limits: MapLibre");
	assert.ok(readme.includes(`CesiumJS: ${c.graded - c.samePicture} of ${c.graded} (`), "README Limits: CesiumJS");
});

test("README のパッケージ表の版が package.json と同じ", () => {
	const rows = [...readme.matchAll(/^\| \[`([^`]+)`\]\(((?:packages|sdk|plugins)\/[^)]+)\) \| ([^|]+) \|/gm)];
	assert.ok(rows.length > 10);
	for (const [, name, dir, ver] of rows) {
		const p = new URL(`../../../${dir}/package.json`, import.meta.url);
		if (!existsSync(p)) continue;
		const pkg = JSON.parse(readFileSync(p, "utf8"));
		assert.equal(ver.trim().split(" ")[0], pkg.version, `${name} の版`);
	}
});

test("llms.txt：{{…}} が全部埋まる・古い互換の数を手で書いていない", () => {
	const tpl = read("../llms.template.txt");
	const out = fillFacts(tpl, f);
	assert.ok(!/\{\{/.test(out));
	assert.ok(out.includes(`Latest release: ${f.release.version} (${f.release.date})`));
	// Current facts と Build with it の互換の数は {{…}} だけ（手書きの数が残るとまた食い違う）
	const live = tpl.slice(0, tpl.indexOf("## Apps"));
	for (const stale of [/\b(of|all) (13\d|30\d) /, /\b(226|234) (draw|give)/]) assert.ok(!stale.test(live), `手書きの数：${stale}`);
	assert.throws(() => fillFacts("{{no.such}}", f));
});

test("llms-full.txt：llms.txt・start.md・CHANGELOG・選んだ docs が入り、HTML の残りかすが無い", () => {
	const llms = fillFacts(read("../llms.template.txt"), f);
	const full = buildLlmsFull(llms);
	assert.ok(full.startsWith(llms.trim()));
	assert.ok(full.includes("Source: https://www.ortho-earth.com/start.md"));
	assert.ok(full.includes(`### ${f.release.version} — ${f.release.date}`));
	for (const d of FULL_DOCS) assert.ok(full.includes(`Source: https://www.ortho-earth.com/docs/${d}\n`), d);
	const prose = full.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");   // コードの中の HTML は本物
	assert.ok(!/<\/?(p|div|span|td|li|a)\b|&(middot|nbsp|amp|lt|gt);/.test(prose), "HTML が残っている");
	assert.ok(full.length < 1_000_000);
});

test("htmlToMarkdown：見出し・表・リンク・コード", () => {
	const md = htmlToMarkdown('<body><div class="header-bar"><a href="/">x</a><div>n</div></div><h1>T</h1><h2>A &amp; B</h2><p>See <a href="core.html#x">core</a> and <code>a&lt;b</code>.</p><table><tr><th>k</th><th>v</th></tr><tr><td>1</td><td>2</td></tr></table><pre><code>x = 1;</code></pre></body>', "https://www.ortho-earth.com/docs/y.html");
	assert.equal(md, "### A & B\n\nSee [core](https://www.ortho-earth.com/docs/core#x) and `a<b`.\n\n| k | v |\n| --- | --- |\n| 1 | 2 |\n\n```\nx = 1;\n```");
});

test("トップの JSON-LD に版と更新日の差し込み口がある", () => {
	const html = read("../index.html");
	assert.ok(html.includes('"softwareVersion":"__RELEASE_VERSION__","dateModified":"__RELEASE_DATE__"'));
	assert.ok(html.includes('href="/llms.txt"') && html.includes('href="/facts.json"'));
});

test("GitHub Release の本文（scripts/release-notes.mjs）＝CHANGELOG の先頭の版の節", async () => {
	const { releaseNotes } = await import("../../../scripts/release-notes.mjs");
	const r = releaseNotes(read("../../../CHANGELOG.md"));
	assert.equal(r.version, f.release.version);
	assert.ok(r.body.length > 100 && !/^## /m.test(r.body));
	assert.throws(() => releaseNotes("# x\n", "9.9.9"));
});

test("htmlToMarkdown：大文字・崩れた閉じタグの script、注釈、nav を中身ごと落とす", () => {
	assert.equal(htmlToMarkdown("<body><SCRIPT>x</script\t\n bar><p>a<!-- c -->b</p><nav>n</nav><p>z</p></body>", "https://a/b"), "ab\n\nz");
});
