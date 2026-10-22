#!/usr/bin/env node
// 点の集約とヒートマップの計算部分（gadgets/aggregate-core.js）の常設検定。描画（オーバーレイ）は CDP で別に見る。
// 見るもの：①点の読み出し（Point/MultiPoint・他は落ちる）②集約＝全段で件数が保存・粗い段ほど少ない・ばらける段 ez
// ③MapLibre の既定の配色（step）・point_count_abbreviated ④ヒートマップの表（ズームの半径・密度の色表・heatmap-density）。
import { pointsOf, buildClusters, clusterFeatures, heatStyle, abbr, CLUSTER_DEFAULT } from "../src/gadgets/aggregate-core.ts";

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
t("件数の略記（point_count_abbreviated）", abbr(150) === "150" && abbr(2921) === "2.9k" && abbr(15000) === "15k" && abbr(2.5e6) === "2.5M");
t("既定の配色＝MapLibre の公式例（step：100 未満は青・750 未満は黄・半径 20/30/40）・単点は #11b4da 半径 4 白縁 1",
	JSON.stringify(CLUSTER_DEFAULT.paint["circle-color"]) === JSON.stringify(["step", ["get", "point_count"], "#51bbd6", 100, "#f1f075", 750, "#f28cb1"]) && CLUSTER_DEFAULT.unclustered.paint["circle-color"] === "#11b4da" && CLUSTER_DEFAULT.unclustered.paint["circle-radius"] === 4);

const hs = heatStyle({ "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 2, 10, 30], "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "#000000", 1, "#ff0000"] });
t("ヒートマップ：半径の表（z0＝2・z10＝30・0.5 刻み）", hs.radius[0] === 2 && hs.radius[20] === 30 && hs.zStep === 0.5);
t("ヒートマップ：heatmap-density の色表（0＝黒・1＝赤・中間）", hs.ramp[0] === 0 && hs.ramp[255 * 4] === 255 && Math.abs(hs.ramp[128 * 4] - 128) <= 1, [hs.ramp[0], hs.ramp[128 * 4], hs.ramp[255 * 4]].join());
// ⑤ cluster as data（clusterFeatures）＝どの段でも [cz0, cz1) に居る地物の件数の和＝点の数・段の端は先まで・集約は id＝cluster_id と ez
{
	const cf = clusterFeatures(pts, cl), Z0 = "ortho:cz0", Z1 = "ortho:cz1", EZ = "ortho:cez";
	const at = z => cf.fc.features.filter(f => z >= f.properties[Z0] && z < f.properties[Z1]);
	const sumAt = z => at(z).reduce((a, f) => a + (f.properties.cluster ? f.properties.point_count : 1), 0);
	const zs = [-1, 0, 3, 7.5, 14, 15, 22];
	t("cluster as data：どの段も件数の和＝点の数", zs.every(z => sumAt(z) === pts.length), zs.map(z => `${z}:${sumAt(z)}`).join(" "));
	t("cluster as data：点の数・段ごとの数（gadget.cluster の戻り）", cf.points === pts.length && cf.counts.join() === cl.levels.map(L => L.length).join());
	t("cluster as data：段ごとの地物＝buildClusters の段", [0, 5, 10, 14, 15].every(z => at(z).length === cl.levels[Math.min(z, cl.levels.length - 1)].length));
	const c0 = at(5).find(f => f.properties.cluster);
	t("cluster as data：集約は id＝cluster_id・ez・byCid", !!c0 && c0.id === c0.properties.cluster_id && c0.properties[EZ] === cf.byCid.get(c0.id) && typeof c0.properties.point_count_abbreviated === "string");
	const raw = at(30);
	t("cluster as data：最も細かい段の先＝元の点（属性はそのまま）", raw.length === pts.length && raw.every(f => !f.properties.cluster) && raw.some(f => f.properties.k === 7));
	const idp = pointsOf({ type: "FeatureCollection", features: [{ type: "Feature", id: 42, properties: {}, geometry: { type: "Point", coordinates: [10, 10] } }] });
	t("cluster as data：単点は元の id", clusterFeatures(idp, buildClusters(idp)).fc.features.every(f => f.id === 42));
}
const def = heatStyle({});
t("ヒートマップ：既定（半径 30・強さ 1・不透明 1・密度 0 は透明）", def.radius[0] === 30 && def.intensity[0] === 1 && def.opacity === 1 && def.ramp[3] === 0);

console.log(ng ? `\nFAIL  ${ng} / ${ok + ng}` : `\nPASS  ${ok}`);
process.exit(ng ? 1 : 0);
