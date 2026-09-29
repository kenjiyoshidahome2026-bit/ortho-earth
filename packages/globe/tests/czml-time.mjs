#!/usr/bin/env node
// CZML の時刻再生の純関数（src/czml-time.js・#113 段 2）を CesiumJS 1.145.0 の正解表（fixtures/czml/ref.json）と突き合わせる。
// 試料は geopbf で読み（czmlToFeatures→GeoPBF の書き込み＝±180° の切断まで通す）、地物から軌跡を組み直して引く。
//   ・地球固定の経緯度の試料（dateline.czml）＝Cesium と同じ ECEF の補間＝差は mm 以下
//   ・慣性系の衛星（simple.czml）＝geopbf が標本の時刻で地球固定へ回し、こちらは固定系で補間（Cesium は慣性系で補間）＝差は測って決めた許しで
//   ・出ている区間・path の区間・時刻付きの数（leadTime）・GPX（線形・縫い目の点を除く）
// 使い方：node packages/globe/tests/czml-time.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { czmlToFeatures } from "../../geopbf/src/modules/czml.js";
import { GeoPBF } from "../../geopbf/src/pbf-base.js";
import { trackOf, positionAt, availableAt, visibleAt, llhToEcef, pathTimes, numberAt } from "../src/czml-time.js";
globalThis.ImageData ??= class ImageData {};

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/czml");
const REF = JSON.parse(fs.readFileSync(path.join(DIR, "ref.json"), "utf8"));
let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓ " + m); else { fails++; console.error("  ✗ " + m); } };
const enc = async fs_ => (await new GeoPBF({ name: "t" }).set({ type: "FeatureCollection", features: fs_ })).features;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

async function compare(file, tolOf, only = null) {
	const { features } = czmlToFeatures(JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")));
	const fsx = await enc(features), ref = REF.files[file], t0 = Date.parse(ref.clock.start), res = {};
	for (const f of fsx) {
		const tr = trackOf(f), rows = ref.entities[f.properties.id];
		if (!tr || !rows || (only && !only.includes(f.properties.id))) continue;
		let worst = 0, n = 0, availBad = 0, posBad = 0;
		for (const [s, lon, lat, h, avail] of rows) {
			const ms = t0 + s * 1000, q = positionAt(tr, ms);
			if (availableAt(tr, ms) !== avail) availBad++;
			if (lon == null) { if (q) posBad++; continue; }
			if (!q) { posBad++; continue; }
			worst = Math.max(worst, dist(q, llhToEcef(lon, lat, h))); n++;
		}
		res[f.properties.id] = worst; const tol = typeof tolOf === "number" ? tolOf : tolOf[f.properties.id];
		ok(worst < tol && !availBad && !posBad, `${file} ${f.properties.id}：${n} 標本・Cesium との差 最大 ${worst < 0.01 ? worst.toExponential(1) : worst.toFixed(2)} m（許し ${tol} m）・出ている区間の食い違い ${availBad}・位置の有無の食い違い ${posBad}`);
	}
	return res;
}

console.log("― 地球固定の経緯度（dateline.czml）＝Cesium と同じ補間 ―");
await compare("dateline.czml", 0.2);   // 残る差＝geopbf の座標の量子化（小数 6 桁＝約 0.1 m）
console.log("― 慣性系の衛星（simple.czml）＝慣性系へ戻して補間（Cesium と同じ手順）―");
// 残る差＝地球の回転の模型（Cesium＝IAU 2006 の XYS・こちら＝IAU 1976 歳差＋1980 章動 18 項）＝半径に比例（低軌道 約 1 m・モルニヤ 約 6 m）
await compare("simple.czml", { "Satellite/ISS": 2, "Satellite/Geoeye1": 2, "Satellite/Molniya_1-92": 8 }, ["Satellite/ISS", "Satellite/Geoeye1", "Satellite/Molniya_1-92"]);

console.log("― 区間・path・時刻付きの数 ―");
{
	const { features } = czmlToFeatures(JSON.parse(fs.readFileSync(path.join(DIR, "dateline.czml"), "utf8")));
	const [a] = (await enc(features)).filter(f => f.properties.id === "Flight/A").map(trackOf);
	const T = s => Date.parse("2026-01-01T00:00:00Z") + s * 1000;
	ok(a.t.length === 13 && a.degree === 1, `縫い目の点を除いて元の 13 標本に戻る（${a.t.length}）`);
	ok(visibleAt(a, T(1000)) && !visibleAt(a, T(3300)) && visibleAt(a, T(3700)) && !visibleAt(a, T(8000)), "出ている区間の外（00:50〜01:00）と標本の後は見えない");
	const pt = pathTimes(a, T(3000), { lead: 0, trail: 1800, resolution: 120 });
	ok(pt[0] === T(1200) && pt[pt.length - 1] === T(3000) && pt.includes(T(1800)) && pt.includes(T(2400)), `path＝[t−30 分, t]・標本の時刻を含む（${pt.length} 点）`);
	const pt2 = pathTimes(a, T(3700), { lead: 0, trail: 1800, resolution: 120 });
	ok(pt2[0] === T(3600), `path は今の出ている区間で切る（01:00 から・${new Date(pt2[0]).toISOString().slice(11, 19)}）`);
	const lead = JSON.parse(fs.readFileSync(path.join(DIR, "simple.czml"), "utf8")).find(p => p.id === "Satellite/ISS").path.leadTime;
	const v0 = numberAt(lead, Date.parse("2012-03-15T10:00:00Z")), v1 = numberAt(lead, Date.parse("2012-03-15T10:20:00Z"));
	ok(Math.abs(v0 - 5537.55) < 0.01 && Math.abs(v1 - (v0 - 1200)) < 0.01, `leadTime（区間ごとの数列＝周回の残り秒）を時刻で引く（${v0.toFixed(2)} → ${v1?.toFixed(2)}＝20 分で 1200 秒減る）`);
}

console.log("― GPX（線形・±180° を跨ぐ）―");
{
	const gpx = fs.readFileSync(path.join(DIR, "dateline.gpx"), "utf8");
	const pts = [...gpx.matchAll(/lat="([^"]+)" lon="([^"]+)"><ele>([^<]+)<\/ele><time>([^<]+)<\/time>/g)].map(m => [+m[2], +m[1], +m[3], m[4]]);
	const f = { type: "Feature", geometry: { type: "LineString", coordinates: pts.map(q => [q[0], q[1]]) }, properties: { name: "walk", ele: pts.map(q => q[2]), time: pts.map(q => q[3]) } };
	const [g] = await enc([f]);
	const tr = trackOf(g);
	ok(g.geometry.type === "MultiLineString" && tr.t.length === pts.length, `跨いで 2 本に切れても標本は ${pts.length} のまま（${tr.t.length}）`);
	const i = pts.findIndex(q => q[0] < 0), a = llhToEcef(pts[i - 1][0], pts[i - 1][1], pts[i - 1][2]), b = llhToEcef(pts[i][0], pts[i][1], pts[i][2]);
	const mid = positionAt(tr, (Date.parse(pts[i - 1][3]) + Date.parse(pts[i][3])) / 2);
	ok(dist(mid, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]) < 1e-6, "跨ぐ辺の真ん中＝ECEF の弦の真ん中（線形）");
}

if (fails) { console.error(`FAIL ${fails}`); process.exit(1); }
console.log("PASS czml-time");
