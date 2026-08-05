// 町丁名の二系統(Anno 210/800)の畳み込みを実タイルで検証する Node ハーネス。
//   node tests/t-chome.mjs            … 既定4都市（東京/札幌/京都/高知）
//   node tests/t-chome.mjs 東京       … 都市を絞る
// mergeChome は app.js の実ソースから切り出して評価する（写経した複製を試験しても意味が無いため）。
// themes.js は純関数モジュール＝そのまま import して分類（施設/地形/丁目）を本番と同一条件で通す。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodeMVT } from "../../../packages/ortho-core/src/decode.js";
import { createThemes, defaultLayerState, isFacility, isTerrain, CHOME_MINZOOM, CHOME800_MINZOOM } from "../themes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "../app.js"), "utf8");
const from = src.indexOf("const chomeCanon"), to = src.indexOf("function rebuildLabels(order)");
if (from < 0 || to < 0 || to < from) { console.error("app.js から mergeChome を切り出せない（実装が移動した？）"); process.exit(1); }
const mergeChome = new Function("CHOME800_MINZOOM", src.slice(from, to) + "\nreturn mergeChome;")(CHOME800_MINZOOM);

const Z = 16;
const AREAS = {
	東京: [139.70, 35.66, 139.78, 35.72],
	札幌: [141.32, 43.04, 141.38, 43.08],
	京都: [135.74, 34.98, 135.79, 35.03],
	高知: [133.51, 33.54, 133.56, 33.58],
};
const url = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`;
const tileXY = (lon, lat) => [Math.floor((lon + 180) / 360 * 2 ** Z),
	Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** Z)];

// タイル→ラベル（labels.js と同じ「Anno の点＋vt_text＋vt_code」だけを取り出す最小版）
async function labelsOf([W, S, E, N]) {
	const [x0, y1] = tileXY(W, S), [x1, y0] = tileXY(E, N);
	const out = [];
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
		const r = await fetch(url(Z, x, y)); if (!r.ok) continue;
		const A = decodeMVT(new Uint8Array(await r.arrayBuffer()))["Anno"]; if (!A) continue;
		for (const f of A.features) {
			const text = (f.props.vt_text || "").trim(); if (!text) continue;   // 文字なし＝記号注記（labels.js も落とす）
			const px = f.geom.coords[0], py = f.geom.coords[1];
			const lon = (x + px / A.extent) / 2 ** Z * 360 - 180;
			const n = Math.PI - 2 * Math.PI * (y + py / A.extent) / 2 ** Z;
			const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
			out.push({ code: f.props.vt_code, text, anchor: [lon, lat], size: 12, color: [0, 0, 0, 1] });
		}
	}
	return out;
}

const themes = createThemes({ layers: [] });   // hiddenLi は使わない＝空 style で十分（liOf は -1 になるだけ）
const zoom = Math.max(CHOME_MINZOOM, CHOME800_MINZOOM) + 0.5;   // 丁目の門を開けた状態で見る
const only = process.argv.slice(2);
let fail = 0;
const ng = (cond, msg) => { if (!cond) { console.log("  NG " + msg); fail++; } };

for (const [city, bbox] of Object.entries(AREAS)) {
	if (only.length && !only.includes(city)) continue;
	const all = await labelsOf(bbox);
	const n210 = all.filter(L => L.code === 210).length, n800 = all.filter(L => L.code === 800).length;
	const merged = mergeChome(all, zoom);
	const kept = merged.length - all.filter(L => L.code !== 800).length;   // 800 のうち残った数
	console.log(`\n【${city}】210=${n210} 800=${n800} → 重複除去 ${n800 - kept} / 残り ${kept}`);

	// ① 800 は1件も残らない（残ったものは 210 に化けている）
	ng(!merged.some(L => L.code === 800), "code 800 が畳み込み後も残っている");
	// ② 丁目集合に「N丁目」表記が残らない＝（N）へ統一されている
	// （対象は畳み込みが預かる 210/800 だけ。地区名 220 の「一丁目」等＝別カテゴリの既存挙動には手を出さない）
	const chome = merged.filter(L => L.code === 210);
	const long = chome.filter(L => /[一二三四五六七八九十百]+丁目$/.test(L.text));
	ng(long.length === 0, `「N丁目」表記が ${long.length}件残る（例 ${long.slice(0, 3).map(L => L.text).join("/")}）`);
	// ③ 同じ町丁名が 30m 以内に二つ出ない（210/800 の二系統重複＋隣タイル由来の同一注記の重複が消えている）
	const key = L => L.text.replace(/[（(]([一二三四五六七八九十百]+)[)）]$/, "$1丁目");
	const dupPairs = [];
	for (let i = 0; i < chome.length; i++) for (let j = i + 1; j < chome.length; j++) {
		const a = chome[i], b = chome[j]; if (key(a) !== key(b)) continue;
		const cos = Math.cos(a.anchor[1] * Math.PI / 180);
		if (Math.hypot((a.anchor[0] - b.anchor[0]) * 111320 * cos, (a.anchor[1] - b.anchor[1]) * 111320) < 30) dupPairs.push(a.text);
	}
	ng(dupPairs.length === 0, `同名の町丁が30m以内に重複 ${dupPairs.length}件（例 ${[...new Set(dupPairs)].slice(0, 3).join("/")}）`);

	// ④ 分類：施設バケツに町丁名が落ちない／地形の 810・832 が施設に落ちない
	const facilityOn = { ...defaultLayerState, place: true, facility: true, terrain: true };
	const shown = themes.filterLabels(merged, facilityOn, zoom, false);
	const asFacility = shown.filter(L => isFacility(L));
	const chomeInFacility = asFacility.filter(L => /丁目$|[（(][一二三四五六七八九十百]+[)）]$/.test(L.text));
	ng(chomeInFacility.length === 0, `施設バケツに町丁名が ${chomeInFacility.length}件（例 ${chomeInFacility.slice(0, 3).map(L => L.text).join("/")}）`);
	const terrainish = all.filter(L => L.code === 810 || L.code === 832);
	for (const L of terrainish) ng(isTerrain(L.code) && !isFacility(L), `${L.text}(code ${L.code}) が地形に分類されない`);
	console.log(`  施設として出る注記 ${asFacility.length}件（例 ${asFacility.slice(0, 3).map(L => L.text).join(" / ")}）`);
	console.log(`  地名(丁目)として出る注記 ${shown.filter(L => L.code === 210).length}件（例 ${shown.filter(L => L.code === 210).slice(0, 4).map(L => L.text).join(" / ")}）`);
	if (terrainish.length) console.log(`  地形へ移した 810/832: ${terrainish.map(L => L.text).join(" / ")}`);
}
console.log(fail ? `\n✗ ${fail}件 NG` : "\n✓ 全て OK");
process.exit(fail ? 1 : 0);
