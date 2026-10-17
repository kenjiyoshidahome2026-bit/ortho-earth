// 世界時計（/globe/clock）段 0 の試験＝決まった時刻（2026 年の冬と夏）を渡して、決まった点（国 × NE の面）の時刻を確かめる。
// 時刻はブラウザと同じ Intl（node の ICU）で計算する＝夏時間の規則は同梱しない。点は clock-audit.md の組から（NE の面の zone と tz_name1st をそのまま）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createResolver, describe, groupZones, utcLabel, cityOf } from "../clock-zones.ts";

const table = JSON.parse(readFileSync(new URL("../clock-zones.json", import.meta.url), "utf8"));
const resolve = createResolver(table);
const WINTER = new Date("2026-01-15T03:00:00Z"), SUMMER = new Date("2026-07-15T03:00:00Z");

// [見出し, 点, 冬の差（分）, 夏の差（分）, 名前（省略＝見ない）]
const CASES = [
	["東京", { a3: "JPN", iso2: "JP", zone: 9, tz: "Asia/Tokyo" }, 540, 540, "Asia/Tokyo"],
	["ニューヨーク（夏時間）", { a3: "USA", iso2: "US", zone: -5, tz: "America/New_York" }, -300, -240, "America/New_York"],
	["シドニー（南半球の夏時間）", { a3: "AUS", iso2: "AU", zone: 10, tz: "Australia/Sydney" }, 660, 600, "Australia/Sydney"],
	["ロンドン", { a3: "GBR", iso2: "GB", zone: 0, tz: "Europe/London" }, 0, 60, "Europe/London"],
	["トルコ＝NE は +2（夏時間あり）・今は通年 +3", { a3: "TUR", iso2: "TR", zone: 2, tz: "Europe/Mariehamn" }, 180, 180, "Europe/Istanbul"],
	["ベネズエラ＝NE は −4:30・今は −4", { a3: "VEN", iso2: "VE", zone: -4.5, tz: "America/Caracas" }, -240, -240],
	["カザフスタン＝NE は +6・2024 から全土 +5", { a3: "KAZ", iso2: "KZ", zone: 6, tz: "Asia/Almaty" }, 300, 300],
	["モスクワ＝NE は +4（2012）・今は +3", { a3: "RUS", iso2: "RU", zone: 4, tz: "Europe/Moscow" }, 180, 180, "Europe/Moscow"],
	["ウラル＝NE の +6 の面（名前はアルマトイ）→ エカテリンブルク +5", { a3: "RUS", iso2: "RU", zone: 6, tz: "Asia/Almaty" }, 300, 300, "Asia/Yekaterinburg"],
	["メキシコ −7＝夏時間なし（NE の名前はデンバー）", { a3: "MEX", iso2: "MX", zone: -7, tz: "America/Denver" }, -420, -420, "America/Mazatlan"],
	["米国 −7＝デンバー（夏時間あり）", { a3: "USA", iso2: "US", zone: -7, tz: "America/Denver" }, -420, -360, "America/Denver"],
	["仏領ギアナ（admin0 のフランス）", { a3: "FRA", iso2: "FR", zone: -3, tz: "America/Sao_Paulo" }, -180, -180, "America/Cayenne"],
	["パリ", { a3: "FRA", iso2: "FR", zone: 1, tz: "Europe/Paris" }, 60, 120, "Europe/Paris"],
	["インド（30 分の刻み）", { a3: "IND", iso2: "IN", zone: 5.5, tz: "Asia/Kolkata" }, 330, 330],
	["ネパール（45 分の刻み）", { a3: "NPL", iso2: "NP", zone: 5.75, tz: "Asia/Kathmandu" }, 345, 345],
	["カナリア諸島（スペインの UTC の面）", { a3: "ESP", iso2: "ES", zone: 0, tz: "Europe/Lisbon" }, 0, 60, "Atlantic/Canary"],
	["中国の西の切れ端（NE の +6）＝全土 +8", { a3: "CHN", iso2: "CN", zone: 6, tz: "Asia/Almaty" }, 480, 480, "Asia/Shanghai"],
	["コソボ（zone.tab に無い）", { a3: "KOS", iso2: "XK", zone: 1, tz: "Europe/Paris" }, 60, 120, "Europe/Belgrade"],
	["海の上（国が無い）＝NE の差のまま", { zone: -7, tz: "" }, -420, -420, null],
	["南極＝NE の差のまま", { a3: "ATA", iso2: "AQ", zone: 12, tz: "Antarctica/South_Pole" }, 720, 720, null],
];
for (const [label, place, w, s, name] of CASES) test(label, () => {
	const r = resolve(place, WINTER);
	if (name !== undefined) assert.equal(r.tz, name, `name (${r.how})`);
	assert.equal(describe(r, WINTER).offset, w, "winter");
	assert.equal(describe(resolve(place, SUMMER), SUMMER).offset, s, "summer");
});

test("夏時間の印＝今の差が標準時より大きい時だけ", () => {
	const ny = resolve({ a3: "USA", iso2: "US", zone: -5, tz: "America/New_York" }, WINTER);
	assert.equal(describe(ny, WINTER).dst, false);
	assert.equal(describe(ny, SUMMER).dst, true);
	const syd = resolve({ a3: "AUS", iso2: "AU", zone: 10, tz: "Australia/Sydney" }, WINTER);
	assert.equal(describe(syd, WINTER).dst, true);   // 南半球の 1 月＝夏
	assert.equal(describe(syd, SUMMER).dst, false);
	assert.equal(describe({ tz: null, fixed: -420 }, SUMMER).dst, false);
});

test("時刻・日付・名前は表示言語で（Intl）", () => {
	const r = resolve({ a3: "JPN", iso2: "JP", zone: 9, tz: "Asia/Tokyo" }, WINTER);
	const en = describe(r, WINTER, "en"), ja = describe(r, WINTER, "ja");
	assert.equal(en.utc, "UTC+9");
	assert.match(en.time, /^12:00\s?PM$/);   // 03:00Z＝東京 12:00
	assert.equal(ja.time, "12:00");
	assert.match(en.name, /Japan Standard Time/);
	assert.match(ja.name, /日本標準時/);
	const ist = describe(resolve({ a3: "TUR", iso2: "TR", zone: 2, tz: "Europe/Mariehamn" }, WINTER), WINTER, "en");
	assert.ok(!/^GMT/.test(ist.name), `Istanbul has no Intl name → the city (${ist.name})`);
	assert.equal(ist.utc, "UTC+3");
	const sea = describe({ tz: null, fixed: 330 }, WINTER, "en");
	assert.equal(sea.utc, "UTC+5:30");
	assert.equal(sea.name, "UTC+5:30");
	assert.match(sea.time, /^8:30\s?AM$/);
});

test("国の一覧（Shift）＝同じ時計を束ねる・西から東", () => {
	const us = groupZones(table.US, WINTER, "en");
	assert.ok(us.length >= 6, `US groups ${us.length}`);
	for (let i = 1; i < us.length; i++) assert.ok(us[i - 1].offset <= us[i].offset);
	assert.equal(us.find(g => g.zones.includes("America/Denver")), us.find(g => g.zones.includes("America/Phoenix")), "winter: Arizona and Denver read the same");
	const usS = groupZones(table.US, SUMMER, "en");
	const den = usS.find(g => g.zones.includes("America/Denver")), phx = usS.find(g => g.zones.includes("America/Phoenix"));
	assert.notEqual(den, phx, "summer: Arizona is a separate clock");
	assert.equal(groupZones(table.KZ, WINTER, "en").length, 1, "Kazakhstan is one clock since 2024");
	assert.equal(groupZones(table.JP, WINTER, "en").length, 1);
});

test("小さな道具", () => {
	assert.equal(utcLabel(0), "UTC");
	assert.equal(utcLabel(-570), "UTC−9:30");
	assert.equal(utcLabel(765), "UTC+12:45");
	assert.equal(cityOf("America/Argentina/Buenos_Aires"), "Buenos Aires");
});
