#!/usr/bin/env node
// 点の集約とヒートマップの計算部分（gadgets/aggregate-core.js）の常設検定。描画（オーバーレイ）は CDP で別に見る。
// 見るもの：①点の読み出し（Point/MultiPoint・他は落ちる）②集約＝全段で件数が保存・粗い段ほど少ない・ばらける段 ez
// ③MapLibre の既定の配色（step）・point_count_abbreviated ④ヒートマップの表（ズームの半径・密度の色表・heatmap-density）。
import { pointsOf, buildClusters, clusterDraw, heatStyle, abbr } from "../gadgets/aggregate-core.js";

let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const P = (lon, lat, props = {}) => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lon, lat] } });

const fc = { type: "FeatureCollection", features: [
	...Array.from({ length: 150 }, (_, i) => P(139.76 + (i % 10) * 1e-4, 35.68 + Math.floor(i / 10) * 1e-4, { k: i })),   // 東京に 150 点（密）
	P(135.5, 34.69), P(135.5001, 34.6901),                                                                            // 大阪に 2 点
	{ type: "Feature", properties: {}, geometry: { type: "MultiPoint", coordinates: [[141.35, 43.06], [130.4, 33.59]] } },
	{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } },
] };
const pts = pointsOf(fc);
t("点の読み出し（MultiPoint は 1 点ずつ・線は落ちる）", pts.length === 154, String(pts.length));
const cl = buildClusters(pts, { clusterRadius: 50, clusterMaxZoom: 14 });
const sum = L => L.reduce((a, it) => a + it.n, 0);
t("全段で件数が保存される", cl.levels.every(L => sum(L) === 154), cl.levels.map(sum).join(","));
t("最も細かい段＝ばらした点・段が粗いほど減る（増えない）", cl.levels[cl.levels.length - 1].length === 154 && cl.levels.every((L, i) => i === 0 || cl.levels[i - 1].length <= L.length) && cl.levels[0].length === 1, cl.levels.map(L => L.length).join(","));   // 東京 150 点は 100m 四方＝z14 でも半径 50px に収まる＝ばらけるのは最後の段だけ
const tokyo = cl.levels[8].find(it => it.n === 150);
t("z8 で東京 150 点が 1 つ・ばらける段 ez が z8 より上", !!tokyo && tokyo.ez > 8, JSON.stringify(tokyo && { n: tokyo.n, ez: tokyo.ez }));
const draw = clusterDraw(pts, cl);
const dT = draw[8].find(c => c.n === 150), dO = draw[8].find(c => c.n === 2), dS = draw[8].find(c => c.n === 1);
t("既定の配色＝MapLibre の step（150→黄 #f1f075・2→青 #51bbd6）", dT?.fill === "rgba(241,240,117,1)" && dO?.fill === "rgba(81,187,214,1)", JSON.stringify([dT?.fill, dO?.fill]));
t("既定の半径（100 以上＝30）・件数の略記", dT?.r === 30 && dT?.text === "150" && abbr(2921) === "2.9k" && abbr(15000) === "15k");
t("ばらした点＝unclustered の既定（#11b4da・半径 4・白縁 1）", dS?.fill === "rgba(17,180,218,1)" && dS?.r === 4 && dS?.sw === 1 && dS?.text === "");
const own = clusterDraw(pts, cl, { paint: { "circle-color": ["case", [">", ["get", "point_count"], 100], "#ff0000", "#00ff00"] } });
t("MapLibre の式で配色（point_count）", own[8].find(c => c.n === 150)?.fill === "rgba(255,0,0,1)" && own[8].find(c => c.n === 2)?.fill === "rgba(0,255,0,1)");

const hs = heatStyle({ "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 2, 10, 30], "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "#000000", 1, "#ff0000"] });
t("ヒートマップ：半径の表（z0＝2・z10＝30・0.5 刻み）", hs.radius[0] === 2 && hs.radius[20] === 30 && hs.zStep === 0.5);
t("ヒートマップ：heatmap-density の色表（0＝黒・1＝赤・中間）", hs.ramp[0] === 0 && hs.ramp[255 * 4] === 255 && Math.abs(hs.ramp[128 * 4] - 128) <= 1, [hs.ramp[0], hs.ramp[128 * 4], hs.ramp[255 * 4]].join());
const def = heatStyle({});
t("ヒートマップ：既定（半径 30・強さ 1・不透明 1・密度 0 は透明）", def.radius[0] === 30 && def.intensity[0] === 1 && def.opacity === 1 && def.ramp[3] === 0);

console.log(ng ? `\nFAIL  ${ng} / ${ok + ng}` : `\nPASS  ${ok}`);
process.exit(ng ? 1 : 0);
