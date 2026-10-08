// クイズの芯の検定（Node・DOM なし）。国の台帳は World の seed（packages/world/seed/nations.csv）から形だけ借り、人口は偽物を与える。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tierOf, pool, pickSet, choicesFor, makeQuestion, buildSet, stars, updateMistake, needsRuby, roundPopulation, SET_SIZE } from "../src/quiz.js";

const csv = fs.readFileSync(path.resolve(import.meta.dirname, "../../../packages/world/seed/nations.csv"), "utf8").trim().split("\n").slice(1);
let seed = 1; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;   // 固定の列
const countries = csv.map((l, i) => { const [key, , name_en, , region, territory, conflict, capital] = l.split(",");
	return { key, iso2: key.length === 2 ? key : "", name: name_en, nameEn: name_en, capital: capital || (territory || conflict ? "" : name_en + " City"), region, territory: territory || null, conflict: conflict || null,
		un: territory || conflict ? null : "1950-01-01", population: territory || conflict ? 5e4 : [1.4e9, 3e8, 5e7, 2e7, 8e6, 2e6, 5e5][i % 7], area: 1e5, flagKey: territory ? territory : key, coord: [i % 360 - 180, (i % 170) - 85] }; });

// 層分け
assert.equal(tierOf({ un: "x", population: 1.2e8 }), 1);
assert.equal(tierOf({ un: "x", population: 5e5, area: 2e6 }), 1, "面積 100 万 km² 以上は Lv.1");
assert.equal(tierOf({ un: "x", population: 5e6 }), 2);
assert.equal(tierOf({ un: null, population: 5e7 }), 3, "国連非加盟は Lv.3");
assert.equal(tierOf({ un: "x", population: 3e5 }), 3);

// 範囲
const p1 = pool(countries, { mode: "capital", level: 1 }), p3 = pool(countries, { mode: "capital", level: 3 });
assert.ok(p1.length > 20 && p1.length < p3.length, `Lv.1 ${p1.length} < Lv.3 ${p3.length}`);
assert.ok(pool(countries, { mode: "capital", level: 3, region: "1" }).every(c => c.region === "1"));
assert.ok(pool(countries, { mode: "flag", level: 3 }).every(c => c.flagKey === c.key), "旗のクイズに代替旗の領土は出ない");
assert.ok(pool(countries, { mode: "map", level: 3 }).every(c => c.coord));

// 出題：10 問・重複なし・間違えた国が先に出る・最近の国は避ける
const set = pickSet(p3, { rnd, mistakes: { JP: { wrong: 2, due: 0 }, FR: { wrong: 1, due: 0 }, XX: { wrong: 9, due: 0 }, DE: { wrong: 1, due: Date.now() + 1e9 } }, recent: ["US", "CN"] });
assert.equal(set.length, SET_SIZE);
assert.equal(new Set(set.map(c => c.key)).size, SET_SIZE, "同じ国が 2 回出ない");
assert.ok(set.some(c => c.key === "JP") && set.some(c => c.key === "FR"), "期限の来た間違いが混ざる");
assert.ok(!set.some(c => c.key === "DE"), "期限の来ていない間違いは出ない");
assert.ok(!set.some(c => c.key === "US" || c.key === "CN"), "最近出た国は避ける");
assert.equal(pickSet(p3.slice(0, 3), { rnd }).length, 3, "範囲が狭ければその数だけ");
assert.deepEqual(pickSet([], {}), []);

// 選択肢：4 つ・正解を含む・答えの字が被らない・Lv.2 以上は同じ地域から
const jp = p3.find(c => c.key === "JP");
for (const level of [1, 2, 3]) {
	const ch = choicesFor(jp, p3, { level, mode: "capital", rnd });
	assert.equal(ch.length, 4); assert.ok(ch.includes(jp));
	assert.equal(new Set(ch.map(c => c.capital)).size, 4, "首都の名前が被らない");
	if (level >= 2) assert.ok(ch.every(c => c.region === jp.region), "Lv.2 以上は同じ地域");
}
const narrow = pool(countries, { mode: "capital", level: 1, region: "5" });   // 南米 Lv.1＝少ない
if (narrow.length) assert.equal(choicesFor(narrow[0], narrow, { level: 1, mode: "capital", rnd, all: countries }).length, 4, "範囲が狭くても外から 4 つ揃える");

// 問の形
assert.equal(makeQuestion(jp, p3, { mode: "flag", level: 1, rnd, index: 0 }).kind, "flag");
assert.equal(makeQuestion(jp, p3, { mode: "flag", level: 1, rnd, index: 1 }).kind, "name");
assert.equal(makeQuestion(jp, p3, { mode: "map", level: 2, rnd }).kind, "map");
const tap = makeQuestion(jp, p3, { mode: "map", level: 3, rnd });
assert.equal(tap.kind, "tap"); assert.equal(tap.choices.length, 0);
const built = buildSet(countries, { mode: "capital", level: 2, region: "3" }, { rnd });
assert.equal(built.length, SET_SIZE); assert.ok(built.every(q => q.answer.region === "3" && q.choices.length === 4));

// 採点
assert.equal(stars(10, 10), 3); assert.equal(stars(8, 10), 2); assert.equal(stars(5, 10), 1); assert.equal(stars(4, 10), 0); assert.equal(stars(0, 0), 0);

// 間隔反復
const now = 1e12, DAY = 86400e3;
let m = updateMistake(undefined, false, now); assert.deepEqual(m, { wrong: 1, streak: 0, due: now, last: now });
m = updateMistake(m, true, now); assert.equal(m.due, now + DAY); assert.equal(m.streak, 1);
m = updateMistake(m, true, now); assert.equal(m.due, now + 2 * DAY);
assert.equal(updateMistake(m, true, now), null, "3 回続けて正解なら台帳から消える");
assert.equal(updateMistake(m, false, now).streak, 0);

// 読み・人口
assert.equal(needsRuby("日本", "にほん"), true);
assert.equal(needsRuby("アメリカ合衆国", "あめりかがっしゅうこく"), false, "カナ始まりは振らない");
assert.equal(needsRuby("南アフリカ", "みなみあふりか"), true);
assert.equal(needsRuby("日本", null), false);
assert.equal(roundPopulation(125416877), 125000000); assert.equal(roundPopulation(9876), 9880); assert.equal(roundPopulation(0), null);
console.log("t-quiz: ok");
