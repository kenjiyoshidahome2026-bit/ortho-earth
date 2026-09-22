// 国の形と中身＝world が自分で持っているデータで賄う（本人 2026-09-23「world の DB に全てデータがある・全て ISO で対応が取れる」）。
// 出所は equal（/equal/）と同じ 2 本＝packages/world が焼いた bucket の GIS/world/：
//   base   … admin_1（州＝束ねれば国の形）・admin_0（係争主体）・populated_places
//   detail … roads / railroads / urban_areas（国境で切って key ごとに 1 地物）
// 全地物が properties.key（world の国キー＝NationDB の key）と properties.layer を持つ＝
// **丸ごと 1 枚載せて式で絞る**（エンジンの addGint + setPaint(paint, filter)）。国ごとに焼き直した配信物は作らない。
// 初回だけ 16.5MB・以降は geopbf が IDB に持つ。detail は z4.5 から＝国を見る時だけ取りに行く。
const BASE_URL = "https://api.ortho-earth.com/bucket/GIS/world/ne-cultural-";
const DETAIL_Z = 4.5;   // 道路・鉄道・市街地を取りに行くズーム（equal の loadZoom と同値）

// 色＝equal の PALETTE と同じ顔（apps/equal/src/layers.js）＝2 つのアプリで同じ世界に見える
const C = { admin1: "rgba(169,156,178,0.55)", road: "#d9a86c", rail: "#7d7f86", urban: "rgba(154,90,82,0.5)" };

const got = {};   // group → Promise<GeoPBF>（1 ページ 1 回）
const fetchGroup = (geopbf, g) => got[g] ||= geopbf(BASE_URL + g + ".geopbf", { name: `ne-cultural-${g}.geopbf` })
	.catch(e => { got[g] = null; console.warn("[world] ne-cultural", g, e); return null; });

// 寄り先の矩形＝国の形のうち中心の近くにある塊だけ。中心と広さは NationDB（coord・area）が持っている＝
// 「どこまでが本体か」を規則で書かずデータに決めさせる。許容＝広さから出した半径の 3 倍・最低 10°
// （France は海外県が外れ、日本は南鳥島が外れ、United States はアラスカが入る）。
const nearBbox = (feats, coord, area) => {
	const limit = Math.max(10, 3 * Math.sqrt((area || 0) / Math.PI) / 111.32);
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	// ⚠ 地物ごとではなく**塊（ポリゴン）ごと**に測る：東京都は 1 地物で小笠原・南鳥島まで含む＝
	// 地物の外接矩形で見ると「本体の近く」と判定されて 154°E まで引っぱられる（2026-09-23 実測）。
	for (const f of feats) {
		const g = f.geometry;
		const parts = g?.type === "MultiPolygon" ? g.coordinates : g?.type === "Polygon" ? [g.coordinates] : [];
		for (const poly of parts) {
			const ring = poly?.[0]; if (!ring?.length) continue;
			let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity, lon = null;
			for (const p of ring) {
				if (!p || p.length < 2) continue;
				lon = lon == null ? p[0] : p[0] + 360 * Math.round((lon - p[0]) / 360);   // 前の頂点に近い方へ解く
				if (lon < a) a = lon; if (lon > c) c = lon; if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1];
			}
			if (a > c) continue;
			const shift = coord ? 360 * Math.round((coord[0] - (a + c) / 2) / 360) : 0;   // 矩形を中心の側へ寄せてから測る（日付変更線）
			if (coord && Math.hypot(Math.max(0, a + shift - coord[0], coord[0] - (c + shift)), Math.max(0, b - coord[1], coord[1] - d)) > limit) continue;
			x0 = Math.min(x0, a + shift); x1 = Math.max(x1, c + shift); y0 = Math.min(y0, b); y1 = Math.max(y1, d);
		}
	}
	return x0 <= x1 ? [x0, y0, x1, y1] : null;
};

/** 国の形（スポットライトへ渡す）と中身（州境・道路・鉄道・市街地）。shape(key,nation) / show(key) / clear() */
export function countryLayers(map, geopbf) {
	if (!geopbf || !map.addGint) return { shape: async () => null, show: async () => {}, clear: () => {} };   // 古いエンジン＝静かに何もしない
	const layer = {}, held = {};   // group → addGint のハンドル／原本
	let key = null;
	const ensure = async g => {
		if (layer[g] !== undefined) return layer[g];
		layer[g] = null;   // 取得中の二重起動を止める
		const pbf = await fetchGroup(geopbf, g);
		if (!pbf) return null;
		held[g] = pbf;
		// fillMaxEdges＝面を塗る上限（市街地の塗りが要る detail だけ開ける）。interactive:false＝識別はスポットライトの領分
		const h = map.addGint(pbf, { order: g === "base" ? -6 : -5, interactive: false, minZoom: g === "base" ? 2.5 : DETAIL_Z, fillMaxEdges: g === "base" ? 0 : undefined });
		h?.setVisible(false);   // 国で絞るまで出さない＝焼き上がり直後の 1 枚で他国の市街地が閃くのを断つ
		return layer[g] = h;
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
		/** その国の形（州を束ねたもの）と寄り先の矩形。nation＝一覧が持っている NationDB の 1 件（coord・area） */
		async shape(k, nation = {}) {
			await ensure("base");
			const pbf = held.base; if (!pbf) return null;
			const n = pbf.fmap?.length ?? 0, feats = [];
			for (let i = 0; i < n; i++) {
				const p = pbf.getProperties(i) || {};
				if (p.key !== k || (p.layer !== "admin_1" && p.layer !== "admin_0")) continue;   // admin_0＝admin_1 に形の無い係争主体
				const f = pbf.getFeature(i); if (f?.geometry) feats.push(f);
			}
			if (!feats.length) return null;
			return { fc: { type: "FeatureCollection", features: feats }, bbox: nearBbox(feats, nation.coord, nation.area) };
		},
		/** その国の州境・道路・鉄道・市街地を出す（カメラが止まってから呼ぶ＝遷移中に他国が閃かない） */
		async show(k) {
			key = k;
			for (const g of ["base", "detail"]) {
				const h = await ensure(g);
				if (!h) continue;
				await h.ready;   // 焼き上がり（初回 ack）を待ってから塗る＝待たずに塗ると全件が既定色で出る
				await h.setPaint(paintOf(g), filterOf(g));
				if (k !== key) return;   // 待っている間に別の国が押された＝古い方は出さない
				h.setVisible(true);      // 絞り終えてから出す
			}
		},
		clear() { for (const h of Object.values(layer)) h?.setVisible(false); },
	};
}
