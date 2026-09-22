// 国の中身＝Natural Earth 10m（ne-cultural）を「その国の分だけ」地図へ載せる。
// データは equal（/equal/）と同じ 2 本を共有する＝packages/world が焼いた bucket の GIS/world/：
//   base   … admin_1（州境・国の内訳）ほか   detail … roads / railroads / urban_areas（国境で切って key ごとに束ね済み）
// 全地物が properties.key（world の国キー）と properties.layer を持つ＝**丸ごと 1 枚載せて式で絞る**
// （エンジンの addGint + setPaint(paint, filter)）。国ごとに焼き直した配信物は作らない（本人裁定 2026-09-23）。
// 初回だけ 16.5MB・以降は geopbf が IDB に持つ。detail は z4.5 から＝国を見る時だけ取りに行く。
const BASE_URL = "https://api.ortho-earth.com/bucket/GIS/world/ne-cultural-";
const DETAIL_Z = 4.5;   // 道路・鉄道・市街地を取りに行くズーム（equal の loadZoom と同値）

// 色＝equal の PALETTE と同じ顔（apps/equal/src/layers.js）＝2 つのアプリで同じ世界に見える
const C = { admin1: "rgba(169,156,178,0.55)", road: "#d9a86c", rail: "#7d7f86", urban: "rgba(154,90,82,0.5)" };

const got = {};   // group → Promise<GeoPBF>（1 ページ 1 回）
const fetchGroup = (geopbf, g) => got[g] ||= geopbf(BASE_URL + g + ".geopbf", { name: `ne-cultural-${g}.geopbf` })
	.catch(e => { got[g] = null; console.warn("[world] ne-cultural", g, e); return null; });

/** 地図に「国の中身」の 2 層を用意する。戻り＝show(key) / clear()（層は使い回して filter だけ差し替える） */
export function countryLayers(map, geopbf) {
	if (!geopbf || !map.addGint) return { show: async () => {}, clear: () => {} };   // 古いエンジン（口が無い版）＝静かに何もしない
	const layer = {};   // group → addGint のハンドル
	let key = null;
	const ensure = async g => {
		if (layer[g] !== undefined) return layer[g];
		layer[g] = null;   // 取得中の二重起動を止める
		const pbf = await fetchGroup(geopbf, g);
		if (!pbf) return null;
		// fillMaxEdges＝面を塗る上限（市街地の塗りが要る detail だけ開ける）。interactive:false＝識別はスポットライトの領分
		return layer[g] = map.addGint(pbf, { order: g === "base" ? -6 : -5, interactive: false, minZoom: g === "base" ? 2.5 : DETAIL_Z, fillMaxEdges: g === "base" ? 0 : undefined });
	};
	const paintOf = g => g === "base"
		? { "line-color": C.admin1, "line-width": 0.6 }                                   // 州境（その国の内訳）
		: { "fill-color": ["case", ["==", ["get", "layer"], "urban_areas"], C.urban, "rgba(0,0,0,0)"],   // 市街地だけ塗る
			"line-color": ["match", ["get", "layer"], "roads", C.road, "railroads", C.rail, "rgba(0,0,0,0)"],
			"line-width": ["match", ["get", "layer"], "railroads", 0.8, 1.0] };
	const filterOf = g => g === "base"
		? ["all", ["==", ["get", "key"], key], ["==", ["get", "layer"], "admin_1"]]
		: ["all", ["==", ["get", "key"], key], ["match", ["get", "layer"], ["roads", "railroads", "urban_areas"], true, false]];
	return {
		async show(k) {
			key = k;
			for (const g of ["base", "detail"]) {
				const h = await ensure(g);
				if (!h) continue;
				await h.ready;   // 焼き上がり（初回 ack）を待ってから塗る＝早すぎる paint は層がまだ無くて落ちる
				h.setVisible(true);
				await h.setPaint(paintOf(g), filterOf(g));
			}
		},
		clear() { for (const h of Object.values(layer)) h?.setVisible(false); },
	};
}
