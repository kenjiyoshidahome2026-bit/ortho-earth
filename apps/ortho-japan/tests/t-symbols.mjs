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

console.log(ng ? `\nFAIL  ${ng} / ${ok + ng}` : `\nPASS  ${ok}`);
process.exit(ng ? 1 : 0);
