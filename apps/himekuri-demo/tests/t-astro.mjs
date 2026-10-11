// 太陽・月の出入りの検定＝国立天文台の暦（東京・ホノルル）と実際の朔望の時刻に合わせる（許容＝太陽 1 分・月の位相 10 分・月の出入り 3 分）
import assert from "node:assert/strict";
import * as A from "../src/astro.js";
const TOKYO = [35.6762, 139.6503], HNL = [21.3069, -157.8583];
const hm = (ms, tz) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
const near = (ms, tz, want, tolMin, what) => {
	const [h, m] = want.split(":").map(Number), p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(ms));
	const g = Object.fromEntries(p.filter(x => x.type !== "literal").map(x => [x.type, +x.value]));
	const diff = (g.hour % 24) * 60 + g.minute + g.second / 60 - (h * 60 + m);
	assert.ok(Math.abs(diff) <= tolMin, `${what}: got ${hm(ms, tz)} want ${want} (±${tolMin} min)`);
};
let n = 0;
// 東京（NAOJ こよみの計算）：夏至 2024-06-21 4:25/19:00・冬至 2024-12-21 6:47/16:32
for (const [[y, m, d], rise, set] of [[[2024, 6, 21], "04:25", "19:00"], [[2024, 12, 21], "06:47", "16:32"], [[2026, 10, 8], "05:41", "17:16"]]) {
	const [t0, t1] = A.dayBounds(y, m, d, "Asia/Tokyo"), s = A.sunDay(t0, t1, ...TOKYO, 0);
	near(s.rise, "Asia/Tokyo", rise, 1, `Tokyo sunrise ${y}-${m}-${d}`); near(s.set, "Asia/Tokyo", set, 1, `Tokyo sunset ${y}-${m}-${d}`); n += 2;
	assert.ok(s.noon > s.rise && s.noon < s.set && s.noonAlt > 0, "noon between rise and set");
	assert.ok(s.civil.dawn < s.rise && s.nautical.dawn < s.civil.dawn && s.astro.dawn < s.nautical.dawn, "twilight order (dawn)");
	assert.ok(s.civil.dusk > s.set && s.nautical.dusk > s.civil.dusk && s.astro.dusk > s.nautical.dusk, "twilight order (dusk)"); n += 3;
}
// ホノルル 2024-06-21：5:50 / 19:16 HST
{ const [t0, t1] = A.dayBounds(2024, 6, 21, "Pacific/Honolulu"), s = A.sunDay(t0, t1, ...HNL, 0); near(s.rise, "Pacific/Honolulu", "05:50", 1, "Honolulu sunrise"); near(s.set, "Pacific/Honolulu", "19:16", 1, "Honolulu sunset"); n += 2; }
// 標高＝地平線の降下：富士山頂（3,776 m）は海抜 0 より日の出が早く日の入りが遅い（dip 1.8°≒ 9 分）
{ const [t0, t1] = A.dayBounds(2026, 10, 8, "Asia/Tokyo"), s = A.sunDay(t0, t1, 35.3606, 138.7274, 3776);
	assert.ok(Math.abs(s.dip - 1.803) < 0.01, "dip 1.76'√h"); assert.ok(s.rise0 - s.rise > 7 * 6e4 && s.rise0 - s.rise < 11 * 6e4, "earlier sunrise on a summit"); assert.ok(s.set - s.set0 > 7 * 6e4, "later sunset on a summit"); n += 3; }
// 極地：トロムソの夏至＝白夜（出入り無し・昼 24h）・冬至＝極夜（市民薄明はある）
{ const [t0, t1] = A.dayBounds(2024, 6, 21, "Europe/Oslo"), s = A.sunDay(t0, t1, 69.65, 18.96, 0); assert.equal(s.polar, "day"); assert.equal(s.rise, null); assert.equal(s.dayLength, 864e5);
	const [u0, u1] = A.dayBounds(2024, 12, 21, "Europe/Oslo"), w = A.sunDay(u0, u1, 69.65, 18.96, 0); assert.equal(w.polar, "night"); assert.equal(w.dayLength, 0); assert.ok(w.civil.dawn != null); n += 6; }
// 朔望：2024-04-08 18:21 UTC（日食の新月）・2024-09-18 02:34 UTC（満月）・2024-09-11 06:06 UTC（上弦）
{ const nm = A.lastNewMoon(Date.UTC(2024, 3, 9)); assert.ok(Math.abs(nm - Date.UTC(2024, 3, 8, 18, 21)) < 10 * 6e4, "new moon 2024-04-08"); n++;
	const ph = A.nextPhases(Date.UTC(2024, 8, 1), 20); const full = ph.find(p => p.phase === 2), fq = ph.find(p => p.phase === 1);
	assert.ok(Math.abs(full.t - Date.UTC(2024, 8, 18, 2, 34)) < 10 * 6e4, "full moon 2024-09-18"); assert.ok(Math.abs(fq.t - Date.UTC(2024, 8, 11, 6, 6)) < 10 * 6e4, "first quarter 2024-09-11"); n += 2;
	assert.ok(A.illumination(Date.UTC(2024, 8, 18, 2, 34)) > 0.99 && A.illumination(Date.UTC(2024, 3, 8, 18, 21)) < 0.01, "illumination at full/new"); n++;
	const age = A.moonAge(Date.UTC(2024, 3, 10, 18, 21)); assert.ok(Math.abs(age - 2) < 0.02, `moon age 2 days after new moon: ${age}`); n++; }
// 月の出入り（東京 2024-06-21・NAOJ 18:36 / 翌 3:03 付近）＝月は中心で判定・視差込み
{ const [t0, t1] = A.dayBounds(2024, 6, 21, "Asia/Tokyo"), m = A.moonDay(t0, t1, ...TOKYO, 0); near(m.rise, "Asia/Tokyo", "18:36", 3, "Tokyo moonrise"); near(m.set, "Asia/Tokyo", "03:03", 3, "Tokyo moonset"); assert.ok(m.illum > 0.97, "near full"); n += 3; }
// 時間帯の道具：夏時間の境を跨ぐ zonedToUTC・offsetAt
{ assert.equal(A.offsetAt(Date.UTC(2024, 6, 1), "America/New_York"), -4 * 36e5); assert.equal(A.offsetAt(Date.UTC(2024, 0, 1), "America/New_York"), -5 * 36e5);
	assert.equal(A.zonedToUTC(2024, 3, 10, 3, 0, 0, "America/New_York"), Date.UTC(2024, 2, 10, 7));   // DST 開始直後 3:00 EDT = 07:00 UTC
	assert.equal(A.zonedToUTC(2026, 10, 8, 0, 0, 0, "Asia/Tokyo"), Date.UTC(2026, 9, 7, 15)); n += 4; }
console.log(`t-astro: ${n} checks OK`);
