// 互換の爪車（node の場面）＝MapLibre の書き方・読み方そのままで、MapLibre と同じ答えになるか（台帳 maplibre-compat.md・2026-09-26）。
// 描かずに確かめられる純関数の場面だけ（描いて確かめる場面は t-mlcompat.html）。既知の失敗は tests/mlcompat-known.json の "node"。
// 爪車：一覧に無い失敗＝落ちる（退行）／一覧にあるのに通った＝落ちる（直ったので一覧から外す）＝verify:regionless と同じ作法。
// 使い方：node packages/globe/tests/mlcompat.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as mlstyle from "../../ortho-core/src/mlstyle.js";
import { evalExpr, originOfLayer, KNOWN_OPS, unknownOps } from "../../ortho-core/src/expr.js";
import { decodeDEM } from "../../ortho-core/src/dem-src.js";
import { expandTemplate } from "../../ortho-core/src/raster-src.js";
import { symbolItems, poleOf } from "../src/gadgets/symbols-core.js";
import { curveZoomKey, hitExtrusion } from "../src/extrude-ml.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const KNOWN = JSON.parse(fs.readFileSync(path.join(DIR, "mlcompat-known.json"), "utf8")).node;
const deq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fc = fs => ({ type: "FeatureCollection", features: fs });
const F = (geometry, properties = {}) => ({ type: "Feature", properties, geometry });
const MLc = props => ({ zoom: 10, props, geom: "Polygon", vars: {}, origin: "ml" }), NAc = props => ({ zoom: 10, props, geom: "Polygon", vars: {} });
const evZ = (e, z) => evalExpr(e, { zoom: z, props: {}, geom: null, vars: {}, origin: "ml" });   // 押し出しの鍵の入力（globe.js の evalZoomIn と同じ）
// 押し出しの当たりの試しの視点＝南から北を 40° で見下ろす平行投影（経緯度を m と見なす・画面 y は下向き）。roof＝画面の点の光線が高さ hM を通る所
const obliqueEnv = (dep = 40 * Math.PI / 180) => {
	const s = Math.sin(dep), c = Math.cos(dep);
	return {
		vtx: (lon, lat, hM) => [lon, -(lat * s + hM * c), 1000 + lat * c - hM * s],
		roof: (x, y, hM) => { const lat = (-y - hM * c) / s; return { ll: [x, lat], w: 1000 + lat * c - hM * s }; },
	};
};

const SCENES = {
	// ── 記号：MapLibre は面にも線にも点置きのラベルを置く（面＝到達不能極・線＝頂点）──
	"symbol-on-polygon": () => {
		const it = symbolItems(fc([F({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }, { n: "A" })]), { layout: { "text-field": ["get", "n"] } });
		return [it.length === 1, `${it.length} item(s)`];
	},
	"symbol-polygon-pole-inside": () => {   // C の字（外接の中心は面の外）＝錨は面の内側（到達不能極）
		const C = [[[0, 0], [3, 0], [3, 1], [1, 1], [1, 2], [3, 2], [3, 3], [0, 3], [0, 0]]];
		const [x, y] = poleOf(C), inside = (r, px, py) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > py) !== (r[j][1] > py) && px < (r[j][0] - r[i][0]) * (py - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; return c; };
		return [inside(C[0], x, y) && x < 1, `pole=${x.toFixed(2)},${y.toFixed(2)}`];
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
	// ── 式の検査（段 5）＝知らない演算子を拾う・式でない所（ラベル・補間の型・literal の中）は見ない ──
	"op-known-matches-build": () => {
		const src = fs.readFileSync(path.join(DIR, "../../ortho-core/src/expr.js"), "utf8"), body = src.slice(src.indexOf('function build(e, o = "native") {'));
		const cases = new Set([...body.matchAll(/case "([^"]+)":/g)].map(m => m[1]));
		const miss = [...cases].filter(o => !KNOWN_OPS.has(o)), extra = [...KNOWN_OPS].filter(o => !cases.has(o));
		return [!miss.length && !extra.length, `missing=${miss} extra=${extra}`];
	},
	"unknownops-structure": () => {
		const ok = unknownOps(["match", ["get", "k"], ["a", "b"], 1, "c", 2, 0]).size === 0 && unknownOps(["interpolate", ["cubic-bezier", 0, 0, 1, 1], ["zoom"], 1, 2, 3, 4]).size === 0
			&& unknownOps(["literal", ["frob", 1]]).size === 0 && unknownOps(["let", "v", 1, ["var", "v"]]).size === 0 && unknownOps([2, 2]).size === 0;
		const bad = [...unknownOps(["case", ["frobnicate", 1], ["within", {}], 0])];
		return [ok && bad.includes("frobnicate") && bad.includes("within"), `bad=${bad}`];
	},
	"style-skips-unknown-op": () => {
		const r = mlstyle.splitMapLibreStyle({ version: 8, sources: { v: { type: "vector", tiles: ["x/{z}/{x}/{y}"] } }, layers: [{ id: "a", type: "fill", source: "v", "source-layer": "w", paint: { "fill-color": ["frobnicate", 1] } }, { id: "b", type: "fill", source: "v", "source-layer": "w" }] });
		return [r.base.map(L => L.id).join() === "b" && /frobnicate/.test(r.skipped.find(k => k.id === "a")?.why || ""), JSON.stringify(r.skipped)];
	},
	// ── 押し出しの描き直しの鍵（台帳 R22）：止まりの外は値が一定＝鍵も一定（MapLibre の値は変わらない＝上げ直す理由が無い）──
	"extrude-zkey-interp-outside": () => {
		const L = { paint: { "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 15, 0, 16, ["get", "h"]] } }, k = z => curveZoomKey(L, z, evZ);
		return [k(10) === k(14.9) && k(10).endsWith(":lo") && k(16) === k(19.3) && k(17).endsWith(":hi"), `${k(10)} ${k(14.9)} ${k(16)} ${k(19.3)}`];
	},
	"extrude-zkey-interp-inside": () => {   // 中は 0.25 刻み（段 5 の規則のまま）
		const L = { paint: { "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 15, 0, 16, 80] } }, k = z => curveZoomKey(L, z, evZ);
		return [k(15.3) !== k(15.6) && k(15.5) === k(15.55) && k(15.3) !== k(14), `${k(15.3)} ${k(15.6)} ${k(15.55)}`];
	},
	"extrude-zkey-step": () => {
		const L = { paint: { "fill-extrusion-height": ["step", ["zoom"], 0, 15, 20, 17, 80] } }, k = z => curveZoomKey(L, z, evZ);
		return [k(12) === k(14.9) && k(15) === k(16.9) && k(15) !== k(14.9) && k(17) === k(21) && k(17) !== k(16.9), `${k(12)} ${k(15)} ${k(17)}`];
	},
	"extrude-zkey-normalized-input": () => {   // 公開の目盛りの差（dz）を正規化した ["-",["zoom"],1] の入力でも曲線を見る（MapLibre の 15〜16＝エンジンの 16〜17）
		const L = mlstyle.normalizeMLLayer({ id: "x", type: "fill-extrusion", source: "s", paint: { "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 15, 0, 16, 80] } }, 1), k = z => curveZoomKey(L, z, evZ);
		return [k(14) === k(16) && k(16).endsWith(":lo") && k(17) === k(20) && k(17).endsWith(":hi") && k(16.3) !== k(16.6), `${JSON.stringify(L.paint["fill-extrusion-height"][2])} ${k(16)} ${k(17)}`];
	},
	"extrude-zkey-nested-fallback": () => {   // ["zoom"] が一番外の曲線でない所にある＝0.25 刻み（今の規則）
		const L = { paint: { "fill-extrusion-height": ["*", ["get", "h"], ["interpolate", ["linear"], ["zoom"], 15, 0, 16, 1]] } }, k = z => curveZoomKey(L, z, evZ);
		return [k(20) !== k(20.5) && k(10) !== k(10.5), `${k(20)} ${k(20.5)}`];
	},
	"extrude-zkey-no-zoom": () => { const L = { filter: ["has", "h"], paint: { "fill-extrusion-height": ["get", "h"], "fill-extrusion-color": "#f00" } }; return [curveZoomKey(L, 10, evZ) === "" && curveZoomKey(L, 17, evZ) === "", "no zoom"]; },
	"extrude-zkey-filter-zoom": () => { const L = { filter: [">=", ["zoom"], 15], paint: { "fill-extrusion-height": 10 } }, k = z => curveZoomKey(L, z, evZ); return [k(10) !== k(10.5), `${k(10)} ${k(10.5)}`]; },   // filter の zoom は曲線でない＝今の規則
	// ── 押し出しの当たりは立体（台帳 R23）：屋根と壁を投影して当てる（MapLibre の fill-extrusion）。視点＝南から北を見下ろす平行投影（1 度＝1 m と見なす）──
	"extrude-hit-roof-not-footprint": () => {
		const env = obliqueEnv(), sq = [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]];
		const a = hitExtrusion([sq], 0, 100, { pt: env.vtx(0, 0, 100) }, env), b = hitExtrusion([sq], 0, 100, { pt: env.vtx(0, -10, 50) }, env), c = hitExtrusion([sq], 0, 100, { pt: env.vtx(0, 0, 160) }, env);
		return [a != null && b != null && c == null, `roof=${a} wall=${b} above=${c}`];   // 足跡だけの当て方＝屋根の点は地面では足跡の外（北へ 84m）＝外れる
	},
	"extrude-hit-floating-base": () => {   // base より下（足元）は当たらない・浮いた箱の壁は当たる
		const env = obliqueEnv(), sq = [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]];
		const under = hitExtrusion([sq], 50, 80, { pt: env.vtx(0, -10, 20) }, env), wall = hitExtrusion([sq], 50, 80, { pt: env.vtx(0, -10, 65) }, env);
		return [under == null && wall != null, `under=${under} wall=${wall}`];
	},
	"extrude-hit-courtyard": () => {   // 穴（中庭）の屋根は当たらない・縁の屋根は当たる
		const env = obliqueEnv(), ring = [[[-30, -30], [30, -30], [30, 30], [-30, 30], [-30, -30]], [[-10, -10], [-10, 10], [10, 10], [10, -10], [-10, -10]]];
		const p = env.vtx(0, 0, 20), hole = hitExtrusion([ring], 0, 20, { pt: p }, env), rim = hitExtrusion([ring], 0, 20, { pt: env.vtx(20, 20, 20) }, env);
		return [rim != null && (hole == null || hole > p[2] + 1), `hole=${hole} roofPlane=${p[2]} rim=${rim}`];   // 穴を覗く光線は奥の内壁に当たり得る（奥行きは屋根の面より遠い）
	},
	"extrude-hit-depth-order": () => {   // 手前の低い箱の屋根と奥の高い箱の南の壁を同じ光線が通る＝手前の方が近い
		const env = obliqueEnv(), near = [[[-10, -70], [10, -70], [10, -50], [-10, -50], [-10, -70]]], far = [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]];
		const p = env.vtx(0, -10, 5), dn = hitExtrusion([near], 0, 60, { pt: p }, env), df = hitExtrusion([far], 0, 120, { pt: p }, env);
		return [dn != null && df != null && dn < df, `near=${dn} far=${df}`];
	},
	"extrude-hit-box": () => {
		const env = obliqueEnv(), sq = [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]], r = env.vtx(0, 0, 100);
		const inBox = hitExtrusion([sq], 0, 100, { box: [r[0] - 2, r[1] - 2, r[0] + 2, r[1] + 2] }, env), off = hitExtrusion([sq], 0, 100, { box: [r[0] + 50, r[1] - 300, r[0] + 60, r[1] - 290] }, env);
		return [inBox != null && off == null, `in=${inBox} off=${off}`];
	},
	// ── 標高の段彩（color-relief・#114）＝MapLibre 6.11.2 の意味：色の段は interpolate の時だけ（段の標高で色を引き、段の間は事前乗算の RGB で線形）・
	//    範囲の外は端の色・step／match／定数は透明（段の表が空）。段の表は globe の colorrelief.js（reliefRamp → reliefAt＝事前乗算の 0〜1）──
	"elevation-op": () => {
		const e = ["interpolate", ["linear"], ["elevation"], 0, "#000", 1000, "#fff"], z = ["interpolate", ["linear"], ["zoom"], 0, "#000", 1000, "#fff"];
		const v = evalExpr(e, { ...MLc({}), vars: { elevation: 500 } }), w = evalExpr(z, { ...MLc({}), zoom: 500 });
		return [unknownOps(e).size === 0 && v != null && v === w, `elevation 500 → ${v}（zoom 500 → ${w}）unknown=${[...unknownOps(e)]}`];
	},
	"style-color-relief-routed": () => {   // style の color-relief の層は hillshade と同じく利用者の層の口へ（落とさない）
		const r = mlstyle.splitMapLibreStyle({ version: 8, sources: { d: { type: "raster-dem", tiles: ["x/{z}/{x}/{y}.png"] } },
			layers: [{ id: "cr", type: "color-relief", source: "d", paint: { "color-relief-color": ["interpolate", ["linear"], ["elevation"], 0, "#00f", 3000, "#f00"] } }] });
		return [r.geojson.some(L => L.id === "cr") && !r.skipped.length, `geojson=${r.geojson.map(L => L.id)} skipped=${JSON.stringify(r.skipped)}`];
	},
	"color-relief-ramp-interpolate": async () => {   // 段の間は事前乗算の線形：青（不透明）と半透明の赤の中間＝(0.25, 0, 0.5, 0.75)
		const { reliefRamp, reliefAt } = await import("../src/colorrelief.js");
		const R = reliefRamp(["interpolate", ["linear"], ["elevation"], 0, "#0000ff", 1000, "rgba(255,0,0,0.5)"]), c = reliefAt(R, 500);
		return [deq(c.map(v => +v.toFixed(3)), [0.25, 0, 0.5, 0.75]), `500m → ${c.map(v => v.toFixed(3))}`];
	},
	"color-relief-ramp-clamp": async () => {   // 範囲の外は端の色
		const { reliefRamp, reliefAt } = await import("../src/colorrelief.js");
		const R = reliefRamp(["interpolate", ["linear"], ["elevation"], 100, "#0000ff", 1000, "#ff0000"]), lo = reliefAt(R, -50), hi = reliefAt(R, 9000);
		return [deq(lo, [0, 0, 1, 1]) && deq(hi, [1, 0, 0, 1]), `−50m → ${lo} 9000m → ${hi}`];
	},
	"color-relief-ramp-curve-is-linear": async () => {   // exponential でも段の間は線形（色は段の標高でだけ引く＝6.11.2）
		const { reliefRamp, reliefAt } = await import("../src/colorrelief.js");
		const R = reliefRamp(["interpolate", ["exponential", 4], ["elevation"], 0, "#000000", 1000, "#ffffff"]), c = reliefAt(R, 500);
		return [Math.abs(c[0] - 0.5) < 0.01 && c[3] === 1, `500m → ${c.map(v => v.toFixed(3))}`];
	},
	"color-relief-step-transparent": async () => {   // step・定数色は段の表が空＝透明（6.11.2）
		const { reliefRamp, reliefAt } = await import("../src/colorrelief.js");
		const a = reliefAt(reliefRamp(["step", ["elevation"], "#0000ff", 1000, "#ff0000"]), 1500), b = reliefAt(reliefRamp("#ff0000"), 1500);
		return [a[3] === 0 && b[3] === 0, `step → ${a} constant → ${b}`];
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
	try { [ok, note] = await fn(); } catch (e) { ok = false; note = "threw " + (e?.message || e); }
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
