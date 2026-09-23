#!/usr/bin/env node
// 記号の層の評価（gadgets/symbols-core.js）の常設検定＝MapLibre の symbol 層の layout/paint → 描く記号の列。
// 見るもの：icon-image の式と "{name}" トークン・format・filter・symbol-sort-key の順・記号帳に無い名前（文字だけ残る）・既定値・色・ズーム域。
import { symbolItems, textOf } from "@ortho-earth/globe/gadgets/symbols-core.js";

let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const P = (props, c = [139.7, 35.6]) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: c } });
const fc = { type: "FeatureCollection", features: [P({ name: "A", kind: "pin", rank: 3 }), P({ name: "B", kind: "dot", rank: 1 }), P({ name: "C", kind: "ghost", rank: 2 }), P({ name: "D", kind: "pin", rank: 0, hide: true })] };
const images = new Map([["pin", {}], ["dot", {}]]);

t("text-field：\"{name}\" トークン", textOf("{name}さん", { props: { name: "A" } }) === "Aさん");
t("text-field：format（文字だけ繋ぐ）", textOf(["format", ["get", "name"], {}, "!", {}], { zoom: 10, props: { name: "A" }, vars: {} }) === "A!");
const items = symbolItems(fc, { filter: ["!", ["has", "hide"]], layout: { "icon-image": ["get", "kind"], "text-field": ["get", "name"], "symbol-sort-key": ["get", "rank"] }, paint: { "text-color": "#ff0000" } }, 10, images);
t("filter で D が落ちる", items.length === 3 && !items.some(i => i.text === "D"), items.map(i => i.text).join());
t("symbol-sort-key の昇順（B→C→A）", items.map(i => i.text).join() === "B,C,A");
t("記号帳に無い名前（ghost）＝記号は描かず文字だけ", items.find(i => i.text === "C").icon === null && items.find(i => i.text === "A").icon === "pin");
t("既定値（icon-size 1・anchor center・text-size 16・overlap false）", items[0].size === 1 && items[0].anchor === "center" && items[0].textSize === 16 && items[0].iconOverlap === false && items[0].textOverlap === false);
t("色（text-color #ff0000・icon-color 既定 #000）", items[0].textColor === "rgba(255,0,0,1)" && items[0].color === "rgba(0,0,0,1)");
t("ズーム域（minzoom 12 は z10 で出ない）", symbolItems(fc, { minzoom: 12, layout: { "text-field": "{name}" } }, 10).length === 0);
t("icon-size の zoom 式", symbolItems(fc, { layout: { "icon-image": "pin", "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 2] } }, 12, images)[0].size === 1.5);
t("icon も text も無い地物は落ちる", symbolItems(fc, { layout: {} }, 10).length === 0);

// #39：text-variable-anchor と icon-text-fit（評価＝symbols-core・配置＝symbols-2d を偽の canvas で回す）
{
	const v = symbolItems(fc, { layout: { "text-field": "{name}", "text-variable-anchor": ["top", "bottom", "left"], "text-radial-offset": 1, "icon-text-fit": "both", "icon-text-fit-padding": [2, 4, 2, 4] } }, 10);
	t("text-variable-anchor＝文字列の配列はそのまま（式にしない）", JSON.stringify(v[0].textVariableAnchor) === '["top","bottom","left"]' && v[0].textRadialOffset === 1);
	t("icon-text-fit と余白", v[0].iconTextFit === "both" && v[0].iconTextFitPadding.join() === "2,4,2,4");
	const S = await import("@ortho-earth/globe/symbols-2d.js");
	const drawn = [], ctx = { setTransform() {}, clearRect() {}, measureText: s => ({ width: s.length * 10 }), fillText: (s, x, y) => drawn.push(["t", s, x, y]), strokeText() {}, drawImage: (im, x, y, w, h) => drawn.push(["i", x, y, w, h]), save() {}, restore() {}, translate() {}, rotate() {}, set font(_) {}, set fillStyle(_) {}, set strokeStyle(_) {}, set lineWidth(_) {}, set lineJoin(_) {}, set textAlign(_) {}, set textBaseline(_) {}, set globalAlpha(_) {} };
	S.init({ getContext: () => ctx });
	const api = { dpr: 1, project: (lon, lat) => [100 + (lon - 139.7) * 1e4, 100 - (lat - 35.6) * 1e4, 1] };
	const run = items => { drawn.length = 0; S.message({ type: "layer", id: "L", items, order: 0 }); S.frame({}, {}, { w: 400, h: 300 }, api); return drawn.filter(d => d[0] === "t"); };
	const two = extra => symbolItems({ type: "FeatureCollection", features: [P({ name: "AAAA" }, [139.7, 35.6]), P({ name: "BBBB" }, [139.7, 35.6])] }, { layout: { "text-field": "{name}", "text-size": 10, ...extra } }, 10);
	t("同じ所に 2 つ＝固定の錨では 1 つしか出ない", run(two({})).length === 1);
	const tv = run(two({ "text-variable-anchor": ["top", "bottom"], "text-radial-offset": 0.5 }));
	t("text-variable-anchor＝2 つ目は別の候補（下→上）で出る", tv.length === 2 && tv[0][3] > 100 && tv[1][3] < 100, JSON.stringify(tv));
	S.message({ type: "image", name: "box", bitmap: { width: 10, height: 10 }, pixelRatio: 1, sdf: false });
	drawn.length = 0;
	S.message({ type: "layer", id: "L", items: [{ ...symbolItems(fc, { layout: { "text-field": "{name}", "text-size": 10, "icon-image": "box", "icon-text-fit": "both", "icon-text-fit-padding": [2, 4, 2, 4] } }, 10, new Map([["box", {}]]))[0] }], order: 0 });
	S.frame({}, {}, { w: 400, h: 300 }, api);
	const ic = drawn.find(d => d[0] === "i");
	t("icon-text-fit＝記号が文字の箱＋余白へ伸びる（幅 10+8・高さ 12+4）", ic && Math.abs(ic[3] - 18) < 0.01 && Math.abs(ic[4] - 16) < 0.01, JSON.stringify(ic));
}

console.log(ng ? `\nFAIL  ${ng} / ${ok + ng}` : `\nPASS  ${ok}`);
process.exit(ng ? 1 : 0);
