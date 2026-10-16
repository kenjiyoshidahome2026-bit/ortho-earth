// innerHTML へ入る文字列の関門（src/html-safe.ts・2026-10-16）の検定。node packages/globe/tests/html-safe.mjs
//  ① escHtml：& < > " ' を実体参照へ（属性の値に <img onerror> が来ても文字のまま）
//  ② tip の既定整形（propLines＝既定層・gint 層 tip:true／columnar の tipLinesFor）がキーも値も逃がす
//  ③ scrubTree（setSafeHTML の木の掃除）：script 等は中身ごと・on* 属性・javascript:/data: の URL を落とし、class・style・<b> は残す
//  ④ unsafeURL：空白・制御文字・大文字で隠した javascript: も見抜く・data:image/ は src だけ可
// DOM の解析（<template>）は node に無い＝③ は手組みの木で掃除の規則だけを見る（解析はブラウザの物そのまま）
import assert from "node:assert/strict";
import { escHtml, propLines, scrubTree, unsafeURL } from "../src/html-safe.ts";
import { tipLinesFor } from "../src/columnar/view.ts";

const XSS = `<img src=x onerror="alert(1)">`;
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

ok("escHtml", () => {
	assert.equal(escHtml(XSS), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
	assert.equal(escHtml(`a & b 'c'`), "a &amp; b &#39;c&#39;");
	assert.equal(escHtml(12.5), "12.5");
	assert.equal(escHtml(null), "null");   // `${v}` と同じ文字列化
	assert.ok(!/[<>"']/.test(escHtml(`"'<>`)));
});

ok("propLines（既定層・gint 層 tip:true の既定整形）", () => {
	const lines = propLines({ name: XSS, [`<b onclick=x>`]: 3, plain: "東京" });
	assert.deepEqual(lines, ["name: &lt;img src=x onerror=&quot;alert(1)&quot;&gt;", "&lt;b onclick=x&gt;: 3", "plain: 東京"]);
	for (const l of lines) assert.ok(!l.includes("<"), l);
});

ok("tipLinesFor（columnar の既定整形）", () => {
	const t = s => `T(${s})`;
	const lines = tipLinesFor({ a: XSS, skip: null, d: new Date(0), o: { x: "<i>" }, k: 1 }, t);
	assert.deepEqual(lines, ["a: &lt;img src=x onerror=&quot;alert(1)&quot;&gt;", "d: 1970-01-01T00:00:00.000Z", "o: {&quot;x&quot;:&quot;&lt;i&gt;&quot;}", "k: 1"]);
	assert.deepEqual(tipLinesFor({ n: null }, t), ["T((no attributes))"]);
	assert.equal(tipLinesFor(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])), t).length, 30);
});

ok("unsafeURL", () => {
	for (const v of ["javascript:alert(1)", " JavaScript:alert(1)", "java\tscript:alert(1)", "\u0001javascript:x", "vbscript:x", "data:text/html,<script>x</script>"]) assert.ok(unsafeURL(v, "href"), v);
	assert.ok(unsafeURL("data:image/svg+xml,<svg/>", "href"));   // data:image/ は src だけ
	assert.ok(!unsafeURL("data:image/png;base64,AAAA", "src"));
	for (const v of ["https://example.com/a?b=javascript:", "/rel/path", "#frag", "mailto:a@b.c", ""]) assert.ok(!unsafeURL(v, "href"), v);
});

// 手組みの木（Element の最小の形：localName・attributes・removeAttribute・remove・children）
function el(localName, attrs = {}, kids = []) {
	const e = { localName, parent: null, attrs: { ...attrs }, kids: [] };
	Object.defineProperty(e, "attributes", { get: () => Object.entries(e.attrs).map(([name, value]) => ({ name, value })) });
	Object.defineProperty(e, "children", { get: () => e.kids.slice() });
	e.removeAttribute = n => { delete e.attrs[n]; };
	e.remove = () => { if (e.parent) e.parent.kids = e.parent.kids.filter(k => k !== e); };
	for (const k of kids) { k.parent = e; e.kids.push(k); }
	return e;
}
const names = e => [e.localName, ...e.kids.flatMap(names)];

ok("scrubTree", () => {
	const img = el("img", { src: "x", onerror: "alert(1)", alt: "a" });
	const a = el("a", { href: " javascript:alert(1)", class: "lnk", title: "t" });
	const a2 = el("a", { href: "https://example.com/", target: "_blank" });
	const svgA = el("a", { "xlink:href": "javascript:x" }, [el("animate", { attributeName: "href", to: "javascript:x" }), el("set", {})]);
	const div = el("div", { class: "cat-pop", style: "color:red", onMouseOver: "x" }, [el("b"), el("br"), img, a, a2,
		el("script", {}, [el("b")]), el("style"), el("iframe", { srcdoc: "<script>x</script>" }), el("object"), el("embed"), el("svg", { onload: "x" }, [svgA]), el("form", { action: "javascript:x" })]);
	const root = el("#fragment", {}, [div, el("script")]);
	scrubTree(root);
	assert.deepEqual(names(root), ["#fragment", "div", "b", "br", "img", "a", "a", "svg", "a", "form"]);
	assert.deepEqual(div.attrs, { class: "cat-pop", style: "color:red" });   // class・style は残る（アプリの吹き出しの見た目）・on* は大文字でも落ちる
	assert.deepEqual(img.attrs, { src: "x", alt: "a" });
	assert.deepEqual(a.attrs, { class: "lnk", title: "t" });
	assert.deepEqual(a2.attrs, { href: "https://example.com/", target: "_blank" });
	assert.deepEqual(svgA.attrs, {});
	assert.deepEqual(div.kids.find(k => k.localName === "svg").attrs, {});
	assert.deepEqual(div.kids.find(k => k.localName === "form").attrs, {});
});

console.log(`✓ html-safe PASS（${n} 件）`);
