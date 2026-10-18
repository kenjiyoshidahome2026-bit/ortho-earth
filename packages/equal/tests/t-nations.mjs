// 国の主題（nations.ts）・属性名の大小無視（choropleth field）・描画の口の選択（backend pickBackend）の検定。
//   ・latest／at／yearsOf＝統計の配列 [最新年, 値(最新年), 値(前年), …]・年 -1（不明）は範囲に入れない
//   ・PRESETS の value・year・years（人口密度＝人口÷面積・GDP は 1e6 倍・0 以下は無し）・REGION_NAMES・tr・loadI18n("en")
//   ・colorGraph＝隣り合う国は違う色・次数の大きい順（Welsh–Powell）
//   ・pickBackend＝?gl2=1 は WebGL2・navigator.gpu が無ければ WebGL2・?gpu=1 は Android でも WebGPU・Android は既定 WebGL2
import { latest, at, yearsOf, PRESETS, REGION_NAMES, tr, colorGraph, loadI18n } from "../src/nations.ts";
import { field } from "../src/choropleth.ts";
import { pickBackend } from "../src/backend.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 統計の配列 ──
ok("latest：最初の欠測でない値と、その年", same(latest([2023, null, 5, 4]), { year: 2022, value: 5 }));
ok("latest：配列でない・全部欠測＝null", latest(null) === null && latest("x") === null && latest([2023, null, null]) === null);
ok("at：指定年の値", at([2023, 10, 9, 8], 2021) === 8 && at([2023, 10, 9, 8], 2023) === 10);
ok("at：範囲の外・欠測・年なし・配列でない＝null", at([2023, 10], 2030) === null && at([2023, 10], 2022) === null && at([2023, null, 9], 2023) === null && at([2023, 1], null) === null && at(5, 2023) === null);
const items = [{ key: "A", population: [2023, 1, 2, 3], area: 10, region: 3, gdp: [2022, 2], hdi: [2023, 0] }, { key: "B", population: [2020, 5], area: 0, region: 9 }, { key: "C", population: [-1, 0] }, { key: "D", population: [2024] }];
ok("yearsOf：全国の最古年〜最新年（年 -1 と値なしは除く）", same(yearsOf(items, "population"), [2020, 2023]));
ok("yearsOf：一つも無い＝null", yearsOf(items, "nope") === null);

// ── 主題 ──
const P = PRESETS;
ok("population：最新値・年・年の範囲", P.population.value(items[0], 0) === 1 && P.population.year(items[0]) === 2023 && same(P.population.years(items), [2020, 2023]));
ok("population：年の指定＝その年（欠測は null）", P.population.value(items[0], 0, 2021) === 3 && P.population.value(items[0], 0, 2019) === null && P.population.year(items[0], 2021) === 2021);
ok("gdp：百万ドル→ドル（1e6 倍）", P.gdp.value(items[0], 0) === 2e6 && P.gdp.unit === "US$");
ok("hdi：0 以下は無し", P.hdi.value(items[0], 0) === null);
ok("density：人口÷面積・面積 0＝無し・年指定", P.density.value(items[0], 0) === 0.1 && P.density.value(items[1], 1) === null && P.density.value(items[0], 0, 2022) === 0.2 && P.density.year(items[0]) === 2023 && P.density.year(items[0], 2020) === 2020 && same(P.density.years(items), [2020, 2023]));
ok("area：正の面積だけ", P.area.value(items[0]) === 10 && P.area.value(items[1]) === null);
ok("region：番号→地域名・知らない番号は無し", P.region.value(items[0]) === "Asia" && P.region.value(items[1]) === null && Object.keys(REGION_NAMES).length === 6);
ok("political は値を持たない（隣接の彩色）", P.political.type === "political" && P.political.value === undefined);
ok("主題はみな label と ref を持つ", Object.values(P).every(p => p.label && p.ref));

// ── 語の引き当て ──
ok("tr：表にある語は訳・無い語と表なしは英語のまま", tr({ ui: { Population: "人口" } }, "Population") === "人口" && tr({ ui: {} }, "Area") === "Area" && tr(null, "Area") === "Area" && tr(undefined, null) === null);
ok("loadI18n(en)＝null（英語が基軸＝取りに行かない）", await loadI18n("en") === null);

// ── 彩色 ──
{
	const edges = [[0, 1], [1, 2], [2, 0], [2, 3], [3, 9]];   // 9 は count の外＝捨てる
	const c = colorGraph(5, edges);
	ok("colorGraph：辺の両端は違う色", [[0, 1], [1, 2], [2, 0], [2, 3]].every(([a, b]) => c[a] !== c[b]), String([...c]));
	ok("colorGraph：三角形＝3 色・孤立点は 1・最大次数の点が 1", Math.max(...c) === 3 && c[4] === 1 && c[2] === 1);
	ok("colorGraph：辺なし＝全部 1", same([...colorGraph(3, [])], [1, 1, 1]));
}

// ── 属性名 ──
ok("field：そのまま・大小無視・無い＝undefined", field({ NAME: "a" }, "NAME") === "a" && field({ Name: "b" }, "name") === "b" && field({ x: 1 }, "y") === undefined && field({ v: 0 }, "V") === 0);

// ── 描画の口 ──
{
	const setNav = (o) => Object.defineProperty(globalThis, "navigator", { value: o, configurable: true, writable: true });
	const q = s => new URLSearchParams(s);
	setNav({ userAgent: "Mac", gpu: {} });
	ok("gpu あり＝WebGPU", pickBackend(q(""), "") === "webgpu");
	ok("?gl2=1（引数・location のどちらでも）＝WebGL2", pickBackend(q("gl2=1"), "") === "webgl2" && pickBackend(q(""), "?a=2&gl2=1") === "webgl2");
	setNav({ userAgent: "Mac" });
	ok("gpu なし＝WebGL2（?gpu=1 でも）", pickBackend(q("gpu=1"), "") === "webgl2");
	setNav({ userAgent: "Linux; Android 14", gpu: {} });
	ok("Android＝WebGL2・?gpu=1 で WebGPU", pickBackend(q(""), "") === "webgl2" && pickBackend(q(""), "?gpu=1") === "webgpu");
	setNav({ userAgent: "X11", gpu: {}, userAgentData: { platform: "Android" } });
	ok("userAgentData の Android も同じ", pickBackend(q(""), "") === "webgl2");
	globalThis.location = { search: "?gl2=1" };
	setNav({ userAgent: "Mac", gpu: {} });
	ok("既定の引数＝location.search", pickBackend() === "webgl2");
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ t-nations 全 PASS");
process.exit(fail ? 1 : 0);
