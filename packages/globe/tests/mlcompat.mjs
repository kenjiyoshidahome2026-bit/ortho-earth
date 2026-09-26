// 互換の爪車（node の場面）＝MapLibre の書き方・読み方そのままで、MapLibre と同じ答えになるか（台帳 maplibre-compat.md・2026-09-26）。
// 描かずに確かめられる純関数の場面だけ（描いて確かめる場面は t-mlcompat.html）。既知の失敗は tests/mlcompat-known.json の "node"。
// 爪車：一覧に無い失敗＝落ちる（退行）／一覧にあるのに通った＝落ちる（直ったので一覧から外す）＝verify:regionless と同じ作法。
// 使い方：node packages/globe/tests/mlcompat.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as mlstyle from "../../ortho-core/src/mlstyle.js";
import { evalExpr } from "../../ortho-core/src/expr.js";
import { decodeDEM } from "../../ortho-core/src/dem-src.js";
import { expandTemplate } from "../../ortho-core/src/raster-src.js";
import { symbolItems } from "../src/gadgets/symbols-core.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const KNOWN = JSON.parse(fs.readFileSync(path.join(DIR, "mlcompat-known.json"), "utf8")).node;
const deq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fc = fs => ({ type: "FeatureCollection", features: fs });
const F = (geometry, properties = {}) => ({ type: "Feature", properties, geometry });

const SCENES = {
	// ── 記号：MapLibre は面にも線にも点置きのラベルを置く（面＝到達不能極・線＝頂点）──
	"symbol-on-polygon": () => {
		const it = symbolItems(fc([F({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }, { n: "A" })]), { layout: { "text-field": ["get", "n"] } });
		return [it.length === 1, `${it.length} item(s)`];
	},
	"symbol-on-line": () => {
		const it = symbolItems(fc([F({ type: "LineString", coordinates: [[0, 0], [1, 0], [2, 1]] }, { n: "L" })]), { layout: { "text-field": ["get", "n"] } });
		return [it.length >= 1, `${it.length} item(s)`];
	},
	// ── raster-dem の encoding "custom"（redFactor・greenFactor・blueFactor・baseShift）──
	"dem-custom": () => {
		const h = decodeDEM(new Uint8Array([7, 200, 100, 255]), "custom", { redFactor: 1, greenFactor: 0, blueFactor: 0, baseShift: 0 });
		return [Math.abs(h[0] - 7) < 1e-6, `h=${h[0]}`];
	},
	// ── タイル URL の {quadkey}（MapLibre の記法）──
	"tile-quadkey-vector": () => {
		const u = mlstyle.tileUrlOf({ tiles: ["https://t.example/{quadkey}.pbf"] })(3, 5, 2);
		return [u === "https://t.example/121.pbf", u];
	},
	"tile-quadkey-raster": () => {
		const u = expandTemplate("https://t.example/{quadkey}.png", 3, 5, 2);
		return [u === "https://t.example/121.png", u];
	},
	// ── 旧式の関数：属性が無い地物は default へ（MapLibre）──
	"legacy-fn-interp-default": () => {
		const e = mlstyle.convertValue({ property: "pop", stops: [[0, 1], [100, 5]], default: 9 }, "circle-radius");
		const v = evalExpr(e, { zoom: 10, props: {}, geom: "Point", vars: {} });
		return [v === 9, `v=${v}`];
	},
	"legacy-fn-categorical-default": () => {   // 通る場面（退行の見張り）
		const e = mlstyle.convertValue({ property: "k", type: "categorical", stops: [["a", "#f00"]], default: "#00f" }, "fill-color");
		const v = evalExpr(e, { zoom: 10, props: {}, geom: "Polygon", vars: {} });
		return [v === "#00f", `v=${v}`];
	},
	// ── zoom のずらしは往復で元に戻る（二度ずらし・入れ子の畳み＝台帳 R4）──
	"shift-roundtrip": () => {
		const L = { id: "x", type: "line", minzoom: 5, paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 10, 4] } };
		const back = mlstyle.shiftLayerZoom(mlstyle.shiftLayerZoom(L, 1), -1);
		return [deq(back, L), JSON.stringify(back.paint["line-width"])];
	},
	// ── ML の層の入口は 1 本（normalizeMLLayer・二度通しても同じ＝台帳 R4）──
	"normalize-idempotent": () => {
		if (typeof mlstyle.normalizeMLLayer !== "function") return [false, "normalizeMLLayer missing"];
		const L = { id: "y", type: "fill", source: "s", filter: ["==", "k", "a"], minzoom: 3, paint: { "fill-color": { stops: [[0, "#000"], [10, "#fff"]] } } };
		const a = mlstyle.normalizeMLLayer(L, 1), b = mlstyle.normalizeMLLayer(a, 1);
		return [deq(a, b), "twice"];
	},
};

let unexpected = [], fixed = [], okN = 0;
for (const [id, fn] of Object.entries(SCENES)) {
	let ok, note;
	try { [ok, note] = fn(); } catch (e) { ok = false; note = "threw " + (e?.message || e); }
	if (ok) okN++;
	const known = id in KNOWN;
	if (!ok && !known) unexpected.push(`${id}(${note})`);
	if (ok && known) fixed.push(id);
	console.log(`${ok ? "ok" : "NG"}${known ? "·known" : ""}  ${id}  ${note ?? ""}`);
}
for (const id of Object.keys(KNOWN)) if (!(id in SCENES)) unexpected.push(`${id}(listed in mlcompat-known.json but no such scene)`);
if (unexpected.length) console.log("✗ unexpected failures: " + unexpected.join(" "));
if (fixed.length) console.log("✗ fixed but still listed (remove from mlcompat-known.json → node): " + fixed.join(" "));
console.log(unexpected.length || fixed.length ? "mlcompat(node): FAIL" : `✓ mlcompat(node) PASS（${okN}/${Object.keys(SCENES).length} ok・known ${Object.keys(KNOWN).length}）`);
process.exit(unexpected.length || fixed.length ? 1 : 0);
