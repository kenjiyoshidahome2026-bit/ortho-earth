// 分類と塗り表の検定
import assert from "node:assert/strict";
import { buildChoropleth, RAMPS, POLITICAL } from "../src/choropleth.js";
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const items = Array.from({ length: 50 }, (_, i) => ({ v: i + 1 }));
// 1) 分位：7 段・各段の凡例が単調・塗り表の α は値あり=255/なし=0
const r = buildChoropleth(items.concat([{ v: null }]), { type: "quantile", ramp: "blue", classes: 7, value: n => n.v });
ok(r.legend.length === 7, "7 段");
ok(r.rgba[50 * 4 + 3] === 0 && r.rgba[0 * 4 + 3] === 255, "α＝値の有無");
const lum = i => r.rgba[i * 4] + r.rgba[i * 4 + 1] + r.rgba[i * 4 + 2];
ok(lum(0) > lum(49), "値が大きいほど濃い");
// 2) 種類が少ない値＝段は種類数まで（「2.7k – 2.7k」を並べない）
const r2 = buildChoropleth([{ v: 1 }, { v: 1 }, { v: 2 }, { v: 3 }], { type: "quantile", ramp: "green", value: n => n.v });
ok(r2.legend.length <= 3 && r2.legend.every(l => !/^(\S+) – \1$/.test(l.label)), `段の畳み込み: ${r2.legend.map(l => l.label).join(" | ")}`);
// 3) 等間隔
const r3 = buildChoropleth(items, { type: "equal", ramp: "orange", classes: 5, value: n => n.v });
ok(r3.legend.length === 5 && r3.legend[0].label.startsWith("1 –"), "等間隔");
// 4) 質的：並び順は名前順・色は CATEGORICAL を巡回
const r4 = buildChoropleth([{ c: "B" }, { c: "A" }, { c: "B" }, { c: null }], { type: "categorical", value: n => n.c });
ok(r4.legend.map(l => l.label).join() === "A,B" && r4.rgba[3 * 4 + 3] === 0, "質的");
// 5) 政治地図：色番号 1..13 → POLITICAL
const r5 = buildChoropleth([{ p: 1 }, { p: 13 }, { p: 14 }], { type: "political", value: n => n.p });
ok(r5.rgba[0] === parseInt(POLITICAL[0].slice(1, 3), 16) && r5.rgba[4] === parseInt(POLITICAL[12].slice(1, 3), 16) && r5.rgba[8] === r5.rgba[0], "政治地図の色番号（14 は巡回で 1）");
ok(Object.keys(RAMPS).length >= 4, "ランプ");
console.log(`t-choropleth: ${n} ok`);
// 6) 発散：0 が中央・奇数段・負は青系（R<B）正は橙系（R>B）
const r6 = buildChoropleth([{ v: -10 }, { v: -1 }, { v: 0.5 }, { v: 8 }, { v: null }], { type: "diverging", value: n => n.v });
ok(r6.legend.length % 2 === 1 && r6.rgba[0] < r6.rgba[2] && r6.rgba[3 * 4] > r6.rgba[3 * 4 + 2] && r6.nodata === 1, `発散 ${r6.legend.length} 段・No data ${r6.nodata}`);
// 7) 対数の等間隔：区切りが桁で並ぶ
const r7 = buildChoropleth([{ v: 1 }, { v: 10 }, { v: 100 }, { v: 1000 }, { v: 1e6 }], { type: "equal", scale: "log", classes: 3, value: n => n.v });
ok(r7.legend.length === 3 && r7.legend[0].label.startsWith("1 – 100"), `対数 ${r7.legend.map(l => l.label).join(" | ")}`);
// 8) 年：value(item, i, year)
const r8 = buildChoropleth([{ p: [2025, 5, 4, 3] }], { type: "quantile", year: 2023, value: (n, _i, y) => n.p[n.p[0] - y + 1] });
ok(r8.values[0] === 3, "年指定の値");
console.log(`t-choropleth+: ${n} ok`);
