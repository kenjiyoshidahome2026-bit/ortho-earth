// クイズの芯の検定（Node・DOM なし）。国の台帳は World の seed（packages/world/seed/nations.csv）から形だけ借り、人口は偽物を与える。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tierOf, terrainTier, TERRAIN_GROUP, pool, pickSet, choicesFor, makeQuestion, buildSet, stars, updateMistake, roundPopulation, reachOf, tapHits, TAP_SLOP, SET_SIZE } from "../src/quiz.ts";

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

// 人口
assert.equal(roundPopulation(125416877), 125000000); assert.equal(roundPopulation(9876), 9880); assert.equal(roundPopulation(0), null);
// 地図を押して当てる：小さい国の押し損ねを救う
const proj = (lon, lat) => [lon * 10, -lat * 10, lon > 170 ? -1 : 1];   // 1° = 10px の平面・東経 170° 超は裏半球
const sq = { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };   // 画面 20px 角の小さい国
let r = reachOf(sq, proj, [10, -40]); assert.equal(r.px, 20, "上の辺まで 20px"); assert.equal(r.size, 20);
r = reachOf({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "MultiPolygon", coordinates: [sq.coordinates, [[[100, 0], [101, 0], [101, 1], [100, 0]]]] } }] }, proj, [1005, 5]);
assert.ok(r.px < 6 && r.size > 900, "多面体はいちばん近い島で測る");
assert.equal(reachOf({ type: "Point", coordinates: [175, 0] }, proj, [1750, 0]).px, Infinity, "裏半球の点は数えない");
assert.equal(reachOf(null, proj, [0, 0], [3, 4]).px, 50, "形が無ければ代表点");
assert.ok(tapHits({ inside: true, hitOther: false, px: Infinity, size: 0 }));
assert.ok(tapHits({ inside: false, hitOther: false, px: TAP_SLOP, size: 500 }), "海を押した＝国の大小を問わず近ければ正解");
assert.ok(tapHits({ inside: false, hitOther: true, px: 10, size: 12 }), "小さい国の隣を押した＝近ければ正解");
assert.ok(!tapHits({ inside: false, hitOther: true, px: 10, size: 300 }), "大きい国の隣の国は外れ");
assert.ok(!tapHits({ inside: false, hitOther: false, px: TAP_SLOP + 1, size: 10 }), "遠ければ外れ");
// 地形モード：TerrainDB の 1 件を同じ形に（src/terrains.ts の loadTerrains の写し・物理量は省く）
assert.equal(terrainTier(0), 1); assert.equal(terrainTier(1), 1); assert.equal(terrainTier(3), 2); assert.equal(terrainTier(null), 2, "手で足した名所は Lv.2"); assert.equal(terrainTier(6), 3);
assert.equal(TERRAIN_GROUP.river, "water"); assert.equal(TERRAIN_GROUP.plate, undefined, "プレートは出さない");
const CATS = ["river", "lake", "range", "peak", "desert", "strait"];
const terrains = Array.from({ length: 120 }, (_, i) => { const category = CATS[i % CATS.length];
	return { key: "Q" + (1000 + i), iso2: "", name: `${category} ${i}`, nameEn: `${category} ${i}`, capital: "", capitalEn: "", region: String(1 + (i % 6)), population: 0, area: 0, un: null, territory: null, conflict: null, flagKey: null,
		coord: [i - 60, (i % 50) - 25], category, group: TERRAIN_GROUP[category], tier: terrainTier([0, 1, 2, 3, 5, null][i % 7 % 6]) }; });
const tp = pool(terrains, { mode: "terrain", level: 3 });
assert.equal(tp.length, 120); assert.ok(pool(countries, { mode: "terrain", level: 3 }).length === 0, "国は地形モードに出ない");
assert.equal(pool(terrains, { mode: "map", level: 3 }).length, 0, "地形は国の地図モードに出ない");
assert.equal(pool(terrains, { mode: "capital", level: 3 }).length, 0);
assert.ok(pool(terrains, { mode: "terrain", level: 1 }).every(c => c.tier === 1));
for (const level of [1, 2, 3]) for (const a of tp.slice(0, 12)) {
	const q = makeQuestion(a, tp, { mode: "terrain", level, rnd, all: terrains });
	assert.equal(q.kind, "terrain"); assert.equal(q.choices.length, 4); assert.ok(q.choices.includes(a));
	assert.ok(q.choices.every(c => c.category === a.category), "選択肢は同じ分類（川の問に砂漠を混ぜない）");
	assert.equal(new Set(q.choices.map(c => c.name)).size, 4);
}
const tnarrow = pool(terrains, { mode: "terrain", level: 1, region: "2" });
const tq = makeQuestion(tnarrow[0], tnarrow, { mode: "terrain", level: 1, rnd, all: terrains });
assert.equal(tq.choices.length, 4, "範囲が狭くても外から 4 つ"); assert.ok(tq.choices.every(c => c.category === tnarrow[0].category), "外から足す時も同じ分類を先に");
const tset = buildSet(terrains, { mode: "terrain", level: 3, region: "0" }, { rnd });
assert.equal(tset.length, SET_SIZE); assert.ok(tset.every(q => q.kind === "terrain" && q.answer.category));
console.log("t-quiz: ok");
