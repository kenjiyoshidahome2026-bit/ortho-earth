// zoom の分類表（src/zoomscale.js）の漏れ検定（MapLibre 互換の台帳 R1・2026-09-26）。
// globe.d.ts の公開面（OrthoJapanMap・Gadgets・RasterAPI・GintLayerHandle）のメンバーが全部、分類表に載っているか。
// 実行時にだけ在るキー（d.ts に無い物）は t-mlcompat が Object.getOwnPropertyNames で同じ表と突き合わせる。
// 使い方：node packages/globe/tests/zoomscale.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAP_MEMBERS, GADGET_MEMBERS, RASTER_MEMBERS, HANDLE_MEMBERS, ZOOM_SCALES, zoomScaleOf } from "../src/zoomscale.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const dts = fs.readFileSync(path.join(DIR, "../globe.d.ts"), "utf8");
let bad = 0;
const ng = msg => { bad++; console.log("✗ " + msg); };

// interface の本体（最初の階層だけ）からメンバー名を拾う：行頭のタブ 1 つ＋（readonly）名前＋「(」「?」「:」
function membersOf(name) {
	const m = dts.match(new RegExp(`export interface ${name}(?:<[^>]*>)?(?:\\s+extends[^{]+)?\\s*\\{([\\s\\S]*?)\\n\\}`));
	if (!m) { ng(`interface ${name} not found in globe.d.ts`); return []; }
	const out = new Set();
	for (const line of m[1].split("\n")) {
		const k = line.match(/^\t(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[(?:<]/);
		if (k) out.add(k[1]);
	}
	return [...out];
}

const KINDS = new Set(["none", "in", "out", "io", "layer", "event", "gadget", "raster", "engine"]);
const check = (iface, table, label) => {
	const names = membersOf(iface);
	if (!names.length) ng(`${iface}: no members parsed`);
	for (const k of names) if (!(k in table)) ng(`${label}.${k} (${iface} in globe.d.ts) is not classified in src/zoomscale.js`);
	return names.length;
};
const n1 = check("OrthoJapanMap", MAP_MEMBERS, "map");
const n2 = check("Gadgets", GADGET_MEMBERS, "map.gadget");
const n3 = check("RasterAPI", RASTER_MEMBERS, "map.raster");
const n4 = check("GintLayerHandle", HANDLE_MEMBERS, "handle");

// 表の値の検札
for (const [label, table] of [["map", MAP_MEMBERS], ["raster", RASTER_MEMBERS], ["handle", HANDLE_MEMBERS]])
	for (const [k, v] of Object.entries(table)) if (!KINDS.has(v)) ng(`${label}.${k}: unknown kind "${v}"`);
for (const [k, v] of Object.entries(GADGET_MEMBERS))
	if (!(v === "none" || v === "layer" || v === "engine" || (v && Array.isArray(v.opts) && v.opts.length && (v.arg == null || Number.isInteger(v.arg))))) ng(`gadget.${k}: bad entry ${JSON.stringify(v)}`);

// 旗の読み取り（既定 ortho・未知は投げる）
if (zoomScaleOf({}) !== "ortho" || zoomScaleOf({ zoomScale: "maplibre" }) !== "maplibre") ng("zoomScaleOf default/maplibre");
let threw = false; try { zoomScaleOf({ zoomScale: "mapbox" }); } catch { threw = true; }
if (!threw) ng("zoomScaleOf must throw on an unknown scale");
if (ZOOM_SCALES.length !== 2) ng("ZOOM_SCALES");

console.log(bad ? `zoomscale: ${bad} problem(s)` : `✓ zoomscale PASS（d.ts map ${n1}・gadget ${n2}・raster ${n3}・handle ${n4} 件が分類済み）`);
process.exit(bad ? 1 : 0);
