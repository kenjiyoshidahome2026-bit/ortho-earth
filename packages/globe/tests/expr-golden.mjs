// 評価器の黄金の写し（MapLibre 互換の台帳 R6・2026-09-26）。
// 内蔵の基図 style（mono/gsi/dark/sepia・汎用 PMTiles の pmLayers）の filter・paint・layout を、ズームと属性の見本で総当たりに評価し、
// 層×性質ごとの結果の指紋（sha1 の頭 16 桁）を tests/expr-golden.json と突き合わせる。
// 互換の段で評価器（ortho-core expr.js）に手を入れても、ネイティブの式（内蔵 style）の結果が 1 つも変わっていないことの証拠。
// 変わった時：出た層×性質を 1 件ずつ見て、意図した変更（例：知らなかった演算子を足した）なら --write で写しを取り直し、理由をコミットに書く。
// 使い方：node packages/globe/tests/expr-golden.mjs [--write] [--show <鍵の一部>]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { evalExpr } from "../../ortho-core/src/expr.js";
import mono from "../src/style-mono.js";
import gsi from "../src/style-gsi.js";
import dark from "../src/style-dark.js";
import sepia from "../src/style-sepia.js";
import { pmLayers } from "../src/style-pm.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const GOLD = path.join(DIR, "expr-golden.json");
const PM_INFO = { layers: ["earth", "water", "waterway", "landuse", "landcover", "roads", "transportation", "buildings", "boundaries", "places", "pois", "transit", "other"] };
const STYLES = {
	mono: mono.layers, gsi: gsi.layers, dark: dark.layers, sepia: sepia.layers,
	"pm-mono": pmLayers(PM_INFO, { style: mono }), "pm-dark": pmLayers(PM_INFO, { style: dark }),
};

// 式の中の属性キーとリテラル（見本の値の候補）を拾う
const BASE_VALS = [0, 1, 5, 100, 1e6, -1, "", "x", true, false, null, "12", "abc"];   // null・数に見える文字列＝MapLibre の型の約束で意味が分かれる所
function scan(e, keys, vals) {
	if (Array.isArray(e)) {
		if ((e[0] === "get" || e[0] === "has") && typeof e[1] === "string") keys.add(e[1]);
		for (let i = typeof e[0] === "string" ? 1 : 0; i < e.length; i++) scan(e[i], keys, vals);
	} else if (typeof e === "string" || typeof e === "number") vals.add(e);
}
const ZOOMS = [...Array.from({ length: 23 }, (_, i) => i), 6.5, 12.3, 15.7];
const GEOMS = ["Point", "LineString", "Polygon", "MultiPolygon"];
const ser = v => v === undefined ? "∅" : typeof v === "number" && Number.isNaN(v) ? "NaN" : JSON.stringify(v);

function fingerprint(expr, keys, vals) {
	const js = JSON.stringify(expr ?? null);
	const zooms = js.includes('"zoom"') ? ZOOMS : [10];
	const geoms = js.includes('"geometry-type"') ? GEOMS : ["Polygon"];
	const probes = [{}];
	for (const k of keys) for (const v of vals) probes.push({ [k]: v });
	const out = [];
	for (const zoom of zooms) for (const geom of geoms) for (const props of probes) {
		let r; try { r = ser(evalExpr(expr, { zoom, props, geom, vars: {}, id: 1 })); } catch (err) { r = "throw:" + (err?.name || "Error"); }
		out.push(r);
	}
	return { hash: crypto.createHash("sha1").update(out.join("|")).digest("hex").slice(0, 16), n: out.length, sample: out.slice(0, 12) };
}

const now = {};
let evals = 0;
for (const [sname, layers] of Object.entries(STYLES)) {
	for (const L of layers) {
		const keys = new Set(), vals = new Set(BASE_VALS);
		const props = [["filter", L.filter], ...Object.entries(L.paint || {}).map(([k, v]) => ["paint." + k, v]), ...Object.entries(L.layout || {}).map(([k, v]) => ["layout." + k, v])];
		for (const [, v] of props) scan(v, keys, vals);
		const valList = [...vals].slice(0, 60);   // 候補が多い層は頭 60（決定的＝Set は挿入順）
		now[`${sname}/${L.id}/zoom`] = `${L.minzoom ?? "-"}..${L.maxzoom ?? "-"}`;
		for (const [pk, v] of props) {
			if (v === undefined) continue;
			const f = fingerprint(v, keys, valList);
			now[`${sname}/${L.id}/${pk}`] = f.hash;
			evals += f.n;
			if (process.argv.includes("--show") && `${sname}/${L.id}/${pk}`.includes(process.argv[process.argv.indexOf("--show") + 1])) console.log(`${sname}/${L.id}/${pk}`, f.sample.join(" "));
		}
	}
}

if (process.argv.includes("--write")) {
	fs.writeFileSync(GOLD, JSON.stringify({ _: "expr-golden.mjs が作る写し（層×性質の評価結果の指紋）。手で直さない＝--write で取り直す", entries: now }, null, "\t") + "\n");
	console.log(`expr-golden: wrote ${Object.keys(now).length} entries (${evals} evaluations)`);
	process.exit(0);
}
const gold = JSON.parse(fs.readFileSync(GOLD, "utf8")).entries;
let bad = 0;
for (const k of new Set([...Object.keys(gold), ...Object.keys(now)])) {
	if (gold[k] !== now[k]) { bad++; console.log(`✗ ${k}: golden ${gold[k] ?? "(none)"} now ${now[k] ?? "(none)"}`); }
}
const unknown = [...(globalThis.__orthovtUnknownOps || [])];
console.log(bad ? `expr-golden: ${bad} change(s) — inspect with --show <key>, then --write if intended`
	: `✓ expr-golden PASS（${Object.keys(now).length} entries・${evals} evaluations${unknown.length ? `・unknown ops: ${unknown.join(",")}` : ""}）`);
process.exit(bad ? 1 : 0);
