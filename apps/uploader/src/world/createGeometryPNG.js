// 原典: packages/world/geometryISO.js の createGeometryPNG + upload_admin の iso 割替え表（旧 #inline("7SzWe6GP")）
// 現代化（Kenji 承認＝改良歓迎 2026-08-31）:
//   - staticOrthoMap → OffscreenCanvas + d3.geoPath（正射投影のclipAngle=90が裏面を自動で落とす＝noFilter/pole判定が不要）
//   - mergeFeatures（polygonClipping）→ 不要化＝FeatureCollection のまま d3.geoCentroid / fitExtent に食わせる
//     （回転後に投影されるので antimeridian 跨ぎ（RU/FJ/US）も bbox 細工なしで正しく収まる）
//   - 背景の世界地図は焼き済み ne_50m_admin_0_countries（256px には 10m は過剰）・対象国は 10m admin1 + disputed
// 出力は原典と同じ: 256x256 @2x PNG（水色#cff 地#ffc 対象#040 実効支配#280 係争#f40）→ GIS/world/geoms.zip
import * as d3 from 'd3';
import { geopbf } from "geopbf";
import { nationKey } from "./db.js";

const NE = res => `https://naturalearth.s3.amazonaws.com/10m_cultural/${res}.zip`;

// 原典 upload_admin の iso 割替え（NE admin1 の name_ja / iso_3166_2 → NationDB の iso アドレス空間）
function fixISO(p) {
	var iso = p.iso_a2, iso2 = p.iso_3166_2, name = p.name_ja;
	if (name == "デケリア") iso = "CY";
	if (name == "アクロティリ") iso = "CY";
	if (name == "北キプロス") iso = "CY";
	if (name == "ソマリランド") iso = "SO";
	if (name == "グアンタナモ湾収容キャンプ") iso = "CU";
	if (name == "バイコヌール") iso = "KZ";
	if (name == "コーラル・シー諸島") iso = "AU";
	if (name == "ココス諸島") iso = "CC";
	if (name == "クリスマス島") iso = "CX";
	if (name == "カシミール") iso = "B45";
	if (name == "南沙諸島") iso = "B46";
	if (name == "クリッパートン島") iso = "FR-CP";
	if (name == "ブーベ島") iso = "BV";
	if (name == "スヴァールバル諸島") iso = "SJ";
	if (name == "ヤンマイエン島") iso = "SJ";
	if (iso == "FR") {
		if (iso2 == "FR-RE") iso = "RE";
		if (iso2 == "FR-YT") iso = "YT";
		if (iso2 == "FR-GF") iso = "GF";
		if (iso2 == "FR-MQ") iso = "MQ";
		if (iso2 == "FR-GP") iso = "GP";
	}
	if (iso == "NL") {
		if (iso2 == "NL-BQ1") iso = "BQ";
		if (iso2 == "NL-BQ2") iso = "BQ";
		if (iso2 == "NL-BQ3") iso = "BQ";
	}
	return iso;
}

export async function createGeometryPNG(ctx, q) {
	const { db } = ctx;
	const ndb = await db.loadNationDB();
	if (!ndb) return q.error("NationDB が未収蔵＝先に NationDB.json をドロップするか createNationDB を実行");
	q.log("世界背景 (ne_50m_admin_0_countries) 読込…");
	const world = (await geopbf("ne_50m_admin_0_countries", { gint: false })).geojson.features;
	q.log("admin1 (ne_10m_admin_1_states_provinces) 読込…");
	const admin1 = (await geopbf(NE("ne_10m_admin_1_states_provinces"), { name: "ne_10m_admin_1_states_provinces", gint: false })).geojson.features;
	q.log("係争地 (ne_10m_admin_0_disputed_areas) 読込…");
	const disputed = (await geopbf(NE("ne_10m_admin_0_disputed_areas"), { name: "ne_10m_admin_0_disputed_areas", gint: false })).geojson.features;
	////-----------------------------------------------------
	const geo_tub = {};
	admin1.forEach(f => {
		const p = f.properties, iso = fixISO(p);
		if (p.name_ja == "ハワイ州" && f.geometry.type == "MultiPolygon")   // 北西ハワイ諸島・ミッドウェー(UM)を分離（原典踏襲）
			f.geometry.coordinates = f.geometry.coordinates.filter(t => t[0][0][0] > -160);
		(geo_tub[iso] = geo_tub[iso] || []).push(f);
	});
	disputed.forEach(f => { const k = f.properties.BRK_A3; (geo_tub[k] = geo_tub[k] || []).push(f); });
	////-----------------------------------------------------
	const size = 256, dpr = 2, margin = 0.05;
	const canvas = new OffscreenCanvas(size * dpr, size * dpr);
	const g = canvas.getContext("2d");
	const files = [];
	for (const t of ndb) {
		// 正キー key（キー台帳=db.js NATION_KEYS）で直に引く。key の地物が無い国（AFX 等）は係争地（B**）経由へ縮退
		const key = t.key || nationKey(t);
		const keys = geo_tub[key] ? [key] : (t.sovereignt || t.claim || []);
		const geos = keys.map(k => geo_tub[k] || []).flat();
		if (!geos.length) { q.error(`${t.name.ja}: 形状なし（keys=[${keys}]）`); continue; }
		const fc = { type: "FeatureCollection", features: geos };
		const coords = d3.geoCentroid(fc);
		const proj = d3.geoOrthographic().rotate([-coords[0], -coords[1], 0])
			.fitExtent([[size * margin, size * margin], [size * (1 - margin), size * (1 - margin)]], fc);
		proj.scale(Math.min(proj.scale(), 10000));
		const path = d3.geoPath(proj, g);
		const draw = (features, fill, stroke, width) => features.forEach(f => {
			g.beginPath(); path(f);
			g.fillStyle = fill; g.fill();
			if (stroke) { g.strokeStyle = stroke; g.lineWidth = width; g.stroke(); }
		});
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.fillStyle = "#cff"; g.fillRect(0, 0, size, size);
		draw(world, "#ffc", "#440", 1);
		draw(geos, "#040");
		(t.sovereignt || []).forEach(id => draw(geo_tub[id] || [], "#280"));
		(t.claim || []).forEach(id => draw(geo_tub[id] || [], "#f40"));
		files.push(new File([await canvas.convertToBlob({ type: "image/png" })], t.name.ja + ".png", { type: "image/png" }));
		q.log(`${t.name.ja}: [${keys}] ${t.sovereignt ? "支配" + t.sovereignt : ""} ${t.claim ? "係争" + t.claim : ""}`);
	}
	await db.saveGeoPNG(files);
	q.success(`geoms.zip: 保存（${files.length} 国）`);
	return files;
}
