// 互換の爪車（node の場面）＝MapLibre の書き方・読み方そのままで、MapLibre と同じ答えになるか（台帳 maplibre-compat.md・2026-09-26）。
// 描かずに確かめられる純関数の場面だけ（描いて確かめる場面は t-mlcompat.html）。既知の失敗は tests/mlcompat-known.json の "node"。
// 爪車：一覧に無い失敗＝落ちる（退行）／一覧にあるのに通った＝落ちる（直ったので一覧から外す）＝verify:regionless と同じ作法。
// 使い方：node packages/globe/tests/mlcompat.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as mlstyle from "../../ortho-core/src/mlstyle.js";
import { evalExpr, originOfLayer } from "../../ortho-core/src/expr.js";
import { decodeDEM } from "../../ortho-core/src/dem-src.js";
import { expandTemplate } from "../../ortho-core/src/raster-src.js";
import { symbolItems } from "../src/gadgets/symbols-core.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const KNOWN = JSON.parse(fs.readFileSync(path.join(DIR, "mlcompat-known.json"), "utf8")).node;
const deq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fc = fs => ({ type: "FeatureCollection", features: fs });
const F = (geometry, properties = {}) => ({ type: "Feature", properties, geometry });
const MLc = props => ({ zoom: 10, props, geom: "Polygon", vars: {}, origin: "ml" }), NAc = props => ({ zoom: 10, props, geom: "Polygon", vars: {} });

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
	// ── 式の意味（段 3・MapLibre の文書から来た式＝ctx.origin "ml"）──
	"ml-compare-null": () => { const v = evalExpr(["<", ["get", "pop"], 1000], MLc({ pop: null })); return [v === undefined, `v=${v}`]; },   // 型の合わない大小比較＝評価エラー
	"ml-get-missing-is-null": () => { const v = evalExpr(["==", ["get", "x"], null], MLc({})); return [v === true, `v=${v}`]; },
	"ml-case-nonboolean": () => { const v = evalExpr(["case", ["get", "s"], 1, 2], MLc({ s: "abc" })); return [v === undefined, `v=${v}`]; },
	"ml-to-number-fallback": () => { const v = evalExpr(["to-number", ["get", "x"], 7], MLc({ x: "abc" })); return [v === 7, `v=${v}`]; },
	"ml-number-assert-fallback": () => { const v = evalExpr(["number", ["get", "x"], 5], MLc({ x: "abc" })); return [v === 5, `v=${v}`]; },
	"ml-interpolate-input-type": () => { const v = evalExpr(["interpolate", ["linear"], ["get", "x"], 0, 0, 10, 10], MLc({ x: "a" })); return [v === undefined, `v=${v}`]; },
	"native-compare-null-kept": () => { const v = evalExpr(["<", ["get", "pop"], 1000], NAc({ pop: null })); return [v === true, `v=${v}`]; },   // ネイティブの寛容な意味は据え置き（契約）
	"origin-cache-isolation": () => {
		const e = ["<", ["get", "pop"], 1000];
		const a = evalExpr(e, MLc({ pop: null })), b = evalExpr(e, NAc({ pop: null })), c = evalExpr(e, MLc({ pop: null }));
		return [a === undefined && b === true && c === undefined, `${a}/${b}/${c}`];
	},
	"origin-mark-survives-clone": () => { const L = structuredClone(mlstyle.normalizeMLLayer({ id: "a", type: "fill", source: "s" }, 0)); return [originOfLayer(L) === "ml", JSON.stringify(L.metadata)]; },   // worker へ postMessage しても残る平の印
	// ── 足した演算子（両方の出自）──
	"op-at": () => { const e = ["at", 1, ["literal", [5, 6, 7]]]; return [evalExpr(e, NAc({})) === 6 && evalExpr(e, MLc({})) === 6, "at"]; },
	"op-trig": () => [evalExpr(["sin", 0], NAc({})) === 0 && evalExpr(["cos", 0], MLc({})) === 1 && Math.abs(evalExpr(["atan", 1], NAc({})) - Math.PI / 4) < 1e-12, "sin/cos/atan"],
	"op-to-rgba": () => { const v = evalExpr(["to-rgba", "#ff0000"], MLc({})); return [deq(v, [255, 0, 0, 1]), JSON.stringify(v)]; },
	"op-cubic-bezier": () => {
		const e = ["interpolate", ["cubic-bezier", 0.42, 0, 0.58, 1], ["zoom"], 0, 0, 10, 10];
		const mid = evalExpr(e, { ...NAc({}), zoom: 5 }), early = evalExpr(e, { ...NAc({}), zoom: 2 });
		return [Math.abs(mid - 5) < 1e-6 && early < 2, `mid=${mid} early=${early}`];
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
