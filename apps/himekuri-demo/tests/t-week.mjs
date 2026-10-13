// 一日分の簡略データ（暦＋太陽・月）が himekuri と astro の両方を正しく束ねているか
import assert from "node:assert/strict";
import { dayInfo, createDayCache, iso, parseISO, addDays, diffDays } from "../src/week.js";
let n = 0;
const loc = { lat: 35.6762, lon: 139.6503, elev: 40, dip: true };
const d = dayInfo([2026, 10, 8], loc, "Asia/Tokyo");
assert.equal(d.cal.曜日, "木"); assert.equal(d.cal.六曜, "大安"); assert.equal(d.cal.旧暦名, "八月廿八日"); assert.equal(d.cal.節気, "寒露"); n += 4;
assert.ok(d.sun.rise > d.t0 && d.sun.set < d.t1 && d.sun.rise < d.sun.noon && d.sun.noon < d.sun.set, "sun within the day"); assert.ok(d.moon.age > 26 && d.moon.age < 28, `moon age ${d.moon.age}`); n += 2;
// 祝日＝2026-11-03 文化の日・標高の補正を切ると出入りが海抜 0 と一致
const h = dayInfo([2026, 11, 3], loc, "Asia/Tokyo"); assert.equal(h.cal.休日, "文化の日"); n++;
const a = dayInfo([2026, 10, 8], { ...loc, elev: 3776, dip: false }, "Asia/Tokyo"); assert.equal(a.sun.rise, dayInfo([2026, 10, 8], { ...loc, elev: 0 }, "Asia/Tokyo").sun.rise); n++;
// 場所なし＝暦だけ
const c = dayInfo([2026, 10, 8], null, "Asia/Tokyo"); assert.equal(c.sun, null); assert.equal(c.cal.日, 8); n += 2;
// 日付の道具
assert.equal(iso([2026, 1, 5]), "2026-01-05"); assert.deepEqual(parseISO("2026-01-05"), [2026, 1, 5]); assert.deepEqual(addDays([2026, 12, 31], 1), [2027, 1, 1]); assert.equal(diffDays([2027, 1, 1], [2026, 12, 25]), 7); n += 4;
// 記憶
const cache = createDayCache(loc, "Asia/Tokyo"); assert.equal(cache.get([2026, 10, 8]), cache.get([2026, 10, 8])); n++;
console.log(`t-week: ${n} checks OK`);
