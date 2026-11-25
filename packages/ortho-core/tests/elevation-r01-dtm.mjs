// 申告域（dtm）の R01 は JAXA の AW3D30 一覧に依らず bucket を引く（2026-11-25）。
// 動機＝JAXA の一覧（List_of_all_tiles_in_AW3D30.txt）が 404 になり、R01 の有無の判定が「一覧に無い＝無し」へ倒れて日本の R01（bucket の DEM10B）まで止まった。
// z13 から標高アトラスが空＝gint の点・線が海面に描かれ、当たり（地形の高さ）と数百 px ずれた（川場・草津で傾けると施設の点が押せない）。
// node tests/elevation-r01-dtm.mjs（網は使わない＝fetch を差し替えて、どこへ取りに行ったかだけを見る）
import { dtmBaked, createTileLoader } from "../src/elevation/createGetHeight.ts";
let fails = 0;
const ok = (c, msg) => { if (!c) fails++; console.log(`${c ? "✓" : "✗"} ${msg}`); };
const dtm = { bbox: [122, 20, 154, 46], range: 1, brand: "GSI" };

// ① 純関数
ok(dtmBaked(dtm, 139, 36, 1) === true, "日本の R01＝bucket に焼いてある");
ok(dtmBaked(dtm, 139, 36, 10) === false, "R10 は対象外（段が違う）");
ok(dtmBaked(dtm, 10, 50, 1) === false, "域外の R01＝一覧の判定のまま");
ok(dtmBaked(null, 139, 36, 1) === false, "申告なし＝一覧の判定のまま");

// ② 一覧が 404 の時：申告域の R01 は bucket を引き、JAXA の zip へは行かない／域外の R01 は今までどおり無し
const seen = [];
globalThis.fetch = async (u) => {
	const url = String(u); seen.push(url);
	return new Response("not found", { status: 404 });
};
const load = await createTileLoader({ dtm, apiUrl: "https://example.invalid" });
const t0 = await load(139, 36, 1);
ok(t0 === null, "bucket に無い（この検定の網）＝null");
ok(seen.some(u => /R01N036E139/.test(u)), "申告域の R01 は一覧が無くても bucket を見に行く");
ok(!seen.some(u => /release_v\d+.*\.zip/.test(decodeURIComponent(u))), "一覧に無いセルは JAXA の 5° zip へ行かない（bakedOnly）");
const n = seen.length;
const t1 = await load(10, 50, 1);
ok(t1 === null && !seen.slice(n).some(u => /R01N050E010/.test(u)), "域外の R01＝一覧が無ければ取りに行かない（従来どおり）");
console.log(fails ? `FAIL ${fails}` : "PASS");
process.exit(fails ? 1 : 0);
