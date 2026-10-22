#!/usr/bin/env node
// 実在の style の集計（互換の計画 P0・2026-10-22）＝公開されている MapLibre の style.json を取り置き、
// 「使われている × 同じ絵にならない」物を層の数で数えて順位にする。互換の段の優先度を毎回同じ式で出すための物差し（台帳 §6）。
// 常設の関門には入れない（網を使う）＝手で／段の終わりに回す。
//   ・取り置き＝<repo>/.cache/style-corpus/<名前>.json（--refresh で取り直す・取れない style は飛ばして名前を出す）
//   ・振り分けは本物の入口（core の splitMapLibreStyle）＝基図に入らない層とその理由もそのまま数える
//   ・差の表（GAPS）は台帳 §4 の「未」「近似」の写し＝段で直したらここから外す
// 使い方:
//   node scripts/style-corpus.mjs              （表を出す・取り置きが無い style だけ取りに行く）
//   node scripts/style-corpus.mjs --refresh    （全部取り直す）
//   node scripts/style-corpus.mjs --json       （結果を JSON で）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitMapLibreStyle, convertValue } from "../../ortho-core/src/mlstyle.ts";
import { exprDeps } from "../../ortho-core/src/expr.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CACHE = path.join(ROOT, ".cache/style-corpus");
const GH = "https://raw.githubusercontent.com/";
// 優先の 2 本（2026-10-22 本人裁定）＝OpenFreeMap liberty・地理院の標準地図
export const STYLES = [
	{ name: "ofm-liberty", url: GH + "hyperknot/openfreemap-styles/main/styles/liberty/style.json", primary: true },
	{ name: "gsi-std", url: GH + "gsi-cyberjapan/gsivectortile-mapbox-gl-js/master/std.json", primary: true },
	{ name: "ofm-bright", url: GH + "hyperknot/openfreemap-styles/main/styles/bright/style.json" },
	{ name: "ofm-positron", url: GH + "hyperknot/openfreemap-styles/main/styles/positron/style.json" },
	{ name: "omt-osm-bright", url: GH + "openmaptiles/osm-bright-gl-style/master/style.json" },
	{ name: "omt-positron", url: GH + "openmaptiles/positron-gl-style/master/style.json" },
	{ name: "omt-dark-matter", url: GH + "openmaptiles/dark-matter-gl-style/master/style.json" },
	{ name: "omt-basic", url: GH + "openmaptiles/klokantech-basic-gl-style/master/style.json" },
	{ name: "omt-toner", url: GH + "openmaptiles/toner-gl-style/master/style.json" },
	{ name: "omt-fiord", url: GH + "openmaptiles/fiord-color-gl-style/master/style.json" },
	{ name: "maptiler-basic", url: GH + "openmaptiles/maptiler-basic-gl-style/master/style.json" },
	{ name: "maplibre-demotiles", url: GH + "maplibre/demotiles/gh-pages/style.json" },
	{ name: "gsi-pale", url: GH + "gsi-cyberjapan/gsivectortile-mapbox-gl-js/master/pale.json" },
	{ name: "gsi-optimal-bvmap", url: GH + "gsi-cyberjapan/optimal_bvmap/main/style/std.json" },
	{ name: "versatiles-colorful", url: "https://tiles.versatiles.org/assets/styles/colorful/style.json" },
	{ name: "americana", url: "https://americanamap.org/style.json" },
];

// ── 差の表（台帳 §4 の写し）：test(L, ctx) → 真ならその層は「同じ絵にならない」 ──
const json = v => JSON.stringify(v ?? null);
const usesZoom = v => /"zoom"|"stops"/.test(json(v));
// 出力の数の最大（interpolate／step の出力・旧式の stops・数そのもの）
function maxOut(v) {
	if (typeof v === "number") return v;
	if (v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.stops)) return Math.max(-Infinity, ...v.stops.map(s => maxOut(s[1])));
	if (!Array.isArray(v)) return -Infinity;
	if (v[0] === "interpolate" || v[0] === "interpolate-hcl" || v[0] === "interpolate-lab") return Math.max(-Infinity, ...v.slice(4).filter((_, i) => i % 2 === 0).map(maxOut));
	if (v[0] === "step") return Math.max(maxOut(v[2]), ...v.slice(4).filter((_, i) => i % 2 === 0).map(maxOut));
	return Math.max(-Infinity, ...v.slice(1).map(maxOut));
}
// splitMapLibreStyle の skipped のうち本当に描かれない物（fill-extrusion・circle・2 本目の vector source の層は globe が vtextrude／vtdraw へ回す）
const DROPPED = /pattern|unknown expression operator/;
const has = (L, k) => L.paint?.[k] != null || L.layout?.[k] != null;
export const GAPS = [
	{ key: "basemap-paint-zoom", why: "基図の paint はタイルの z で焼く（ズームに連続でない）", test: (L, c) => c.base.has(L.id) && L.type !== "symbol" && L.type !== "background" && Object.values(L.paint || {}).some(usesZoom) },
	{ key: "after-symbol", why: "注記より後ろの塗り・線（注記は常に最上段）", test: (L, c) => c.afterSymbol.has(L.id) },
	{ key: "dasharray-cpu", why: "ずらす層（line-offset・line-gap-width）と模様 9 個以上の破線は CPU でタイルの z の尺に刻む（他は 2026-10-22 から GL2・WebGPU とも MapLibre と同じ＝S-P1-3）", test: L => has(L, "line-dasharray") && (has(L, "line-offset") || has(L, "line-gap-width") || (Array.isArray(L.paint["line-dasharray"]) && L.paint["line-dasharray"].length > 8)) },
	{ key: "pattern", why: "line-pattern・background-pattern・fill-extrusion-pattern は未（fill-pattern は 2026-10-22 から GL2・WebGPU＝S-P1-4/5・大きさは cos φ 倍）", test: L => ["line-pattern", "background-pattern", "fill-extrusion-pattern"].some(k => has(L, k)) },
	{ key: "translate", why: "fill-extrusion-translate は読まない（塗り・線・円の translate は 2026-10-22 から GL2・WebGPU＝S-P1-4/5）", test: L => has(L, "fill-extrusion-translate") },
	{ key: "line-gradient", why: "line-gradient", test: L => has(L, "line-gradient") },
	{ key: "circle-pitch", why: "circle-pitch-scale・circle-pitch-alignment map", test: L => has(L, "circle-pitch-scale") || L.paint?.["circle-pitch-alignment"] === "map" },
	{ key: "symbol-misc", why: "symbol-avoid-edges・icon-keep-upright", test: L => L.layout?.["symbol-avoid-edges"] === true || L.layout?.["icon-keep-upright"] === true },
	{ key: "glyphs", why: "文字の字形（style の glyphs を読まず端末のフォントで描く）", test: (L, c) => L.type === "symbol" && L.layout?.["text-field"] != null && !!c.style.glyphs },
	{ key: "not-drawn", why: "読めずに落とす層（理由は下・型ごとに別の口へ回る層は数えない）", test: (L, c) => DROPPED.test(c.skipped.get(L.id) || "") },
];

async function load(s, refresh) {
	const f = path.join(CACHE, s.name + ".json");
	if (!refresh && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
	try {
		const r = await fetch(s.url, { signal: AbortSignal.timeout(20000) });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const st = await r.json();
		fs.mkdirSync(CACHE, { recursive: true });
		fs.writeFileSync(f, JSON.stringify(st));
		return st;
	} catch (err) {
		if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
		console.warn(`skip ${s.name}: ${err.message}`);
		return null;
	}
}
// 非 symbol の層で、それより前に symbol の層がある物（style の順で注記の上に来るはずの塗り・線）
function afterSymbolIds(layers) {
	const out = new Set(); let seen = false;
	for (const L of layers) { if (L.type === "symbol") seen = true; else if (seen && L.type !== "background") out.add(L.id); }
	return out;
}
export function analyze(style) {
	const layers = style.layers || [], split = splitMapLibreStyle(style);
	const ctx = { style, base: new Set(split.base.map(L => L.id)), skipped: new Map(split.skipped.map(s => [s.id, s.why])), afterSymbol: afterSymbolIds(layers) };
	const hits = Object.fromEntries(GAPS.map(g => [g.key, 0])), reasons = {};
	for (const L of layers) for (const g of GAPS) if (g.test(L, ctx)) hits[g.key]++;
	for (const why of ctx.skipped.values()) if (DROPPED.test(why)) { const k = why.replace(/"[^"]*"/g, "…"); reasons[k] = (reasons[k] || 0) + 1; }
	// 式の分類（exprDeps の kind・描画の統合ロードマップ 波 1 の 3＝V-Ph3 の paint 表の設計材料）：paint／layout の値ごとに数える。
	// (a) constant・zoom＝毎フレーム表を書けば連続 (b) data＝タイルで焼く行 (c) zoom×data＝z と z+1 を頂点に焼く受け皿
	const kinds = { paint: {}, layout: {} }, mixed = {}, state = { paint: 0, layout: 0 };
	for (const L of layers) for (const part of ["paint", "layout"]) for (const [p, v] of Object.entries(L[part] || {})) {
		if (p === "visibility") continue;
		const d = exprDeps(convertValue(v, p));
		kinds[part][d.kind] = (kinds[part][d.kind] || 0) + 1;
		if (d.state) state[part]++;
		if (d.kind === "zoom×data") mixed[p] = (mixed[p] || 0) + 1;
	}
	return { layers: layers.length, hits, reasons, kinds, mixed, state };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const refresh = process.argv.includes("--refresh"), asJson = process.argv.includes("--json");
	const per = {};
	for (const s of STYLES) { const st = await load(s, refresh); if (st) per[s.name] = analyze(st); }
	const names = Object.keys(per);
	const rows = GAPS.map(g => ({ key: g.key, why: g.why, styles: names.filter(n => per[n].hits[g.key] > 0).length, layers: names.reduce((a, n) => a + per[n].hits[g.key], 0),
		primary: STYLES.filter(s => s.primary && per[s.name]).map(s => `${s.name} ${per[s.name].hits[g.key]}`).join("・") }))
		.filter(r => r.layers > 0).sort((a, b) => b.styles - a.styles || b.layers - a.layers);
	const reasons = {};
	for (const n of names) for (const [k, v] of Object.entries(per[n].reasons)) reasons[k] = (reasons[k] || 0) + v;
	const KINDS = ["constant", "zoom", "data", "zoom×data"], kinds = { paint: {}, layout: {} }, mixed = {};
	for (const n of names) {
		for (const part of ["paint", "layout"]) for (const [k, v] of Object.entries(per[n].kinds[part])) kinds[part][k] = (kinds[part][k] || 0) + v;
		for (const [p, v] of Object.entries(per[n].mixed)) mixed[p] = (mixed[p] || 0) + v;
	}
	if (asJson) { console.log(JSON.stringify({ styles: per, rows, reasons, kinds, mixed }, null, 2)); process.exit(0); }
	const total = names.reduce((a, n) => a + per[n].layers, 0);
	console.log(`style ${names.length} 本・層 ${total}（${names.join(", ")}）\n`);
	console.log("| 差 | style | 層 | 優先の 2 本 | 中身 |\n|---|---|---|---|---|");
	for (const r of rows) console.log(`| ${r.key} | ${r.styles}/${names.length} | ${r.layers} | ${r.primary} | ${r.why} |`);
	if (Object.keys(reasons).length) { console.log("\n描かない層の理由（splitMapLibreStyle）："); for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${v}  ${k}`); }
	console.log("\n式の分類（paint／layout の値の数・exprDeps の kind）：\n\n| kind | paint | layout | style の本数（paint） |\n|---|---|---|---|");
	for (const k of KINDS) console.log(`| ${k} | ${kinds.paint[k] || 0} | ${kinds.layout[k] || 0} | ${names.filter(n => per[n].kinds.paint[k]).length}/${names.length} |`);
	const mixedTop = Object.entries(mixed).sort((a, b) => b[1] - a[1]);
	if (mixedTop.length) console.log(`\nzoom×data の性質：${mixedTop.map(([p, v]) => `${p} ${v}`).join("・")}（style ごと：${names.filter(n => Object.keys(per[n].mixed).length).map(n => `${n} ${Object.values(per[n].mixed).reduce((a, b) => a + b, 0)}`).join("・")}）`);
}
