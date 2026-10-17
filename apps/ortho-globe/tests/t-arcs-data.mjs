// 弧の頁（/globe/arcs）の純関数の検定（node・ブラウザ不要）＝arcs-data.ts。
//   大円と等角航路の距離（既知の値）・点列が日付変更線で跳ばない・arcs-gl と同じ持ち上げ・OpenFlights の読み・CSV の列の当て方と記号の引き
import { test } from "node:test";
import assert from "node:assert/strict";
import * as D from "../arcs-data.ts";

const NRT = [140.386, 35.765], JFK = [-73.779, 40.640], LHR = [-0.4614, 51.4775];
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b} (±${tol})`);

test("大円の距離（haversine・平均半径）", () => {
	near(D.gcDistance(NRT, JFK), 10830, 15, "NRT–JFK");
	near(D.gcDistance(JFK, LHR), 5540, 15, "JFK–LHR");
	near(D.gcDistance([0, 0], [180, 0]), Math.PI * D.EARTH_KM, 1e-6, "対蹠点");
	assert.equal(D.gcDistance(NRT, NRT), 0);
});

test("等角航路は大円より長い・東西の赤道上では同じ・向きは一定", () => {
	const g = D.gcDistance(NRT, JFK), r = D.rhumbDistance(NRT, JFK);
	assert.ok(r > g * 1.15 && r < g * 1.2, `東京→ニューヨークは等角航路が 15〜20% 長い: ${r} / ${g}`);
	near(D.rhumbDistance([10, 0], [40, 0]), D.gcDistance([10, 0], [40, 0]), 1e-6, "赤道");
	near(D.rhumbDistance([10, 0], [10, 50]), D.gcDistance([10, 0], [10, 50]), 1e-6, "子午線");
	near(D.rhumbBearing([0, 0], [0, 10]), 0, 1e-9, "真北");
	near(D.rhumbBearing([0, 0], [10, 0]), 90, 1e-9, "真東");
	// 等角航路の点列はメルカトルの上で一直線（y が x に比例）
	const p = D.rhumbPath(NRT, JFK, 10), y = q => D.mercY(q[1]);
	for (const q of p) near((y(q) - y(p[0])) * (p[10][0] - p[0][0]), (y(p[10]) - y(p[0])) * (q[0] - p[0][0]), 1e-9, "直線");
});

test("大円の点列：両端・経度は連続（日付変更線で跳ばない）・東京→ニューヨークはアラスカの近くを通る", () => {
	const p = D.gcPath(NRT, JFK, 64);
	assert.equal(p.length, 65);
	near(p[0][0], NRT[0], 1e-9); near(p[0][1], NRT[1], 1e-9);
	near(D.wrap180(p[64][0]), JFK[0], 1e-9); near(p[64][1], JFK[1], 1e-9);
	for (let i = 1; i < p.length; i++) assert.ok(Math.abs(p[i][0] - p[i - 1][0]) < 20, `跳び ${i}`);
	const north = p.reduce((m, q) => q[1] > m[1] ? q : m);
	assert.ok(north[1] > 65 && D.wrap180(north[0]) > -170 && D.wrap180(north[0]) < -140, `北端はアラスカの辺り: ${north}`);
});

test("弧の持ち上げは arcs-gl と同じ（中点で h×弦長・両端 0）", () => {
	const h = 0.2, mid = D.gcPoint(NRT, JFK, 0.5, h), chord = 2 * Math.sin(D.gcDistance(NRT, JFK) / D.EARTH_KM / 2);
	near(mid[2], h * chord, 1e-9);
	assert.equal(D.gcPoint(NRT, JFK, 0, h)[2], 0);
	near(D.gcPoint(NRT, JFK, 1, h)[2], 0, 1e-12);
	const tr = D.tripOf(NRT, JFK, { h, n: 8, phase: 2, kmPerSec: 1000 });
	assert.equal(tr.path.length, 9); assert.equal(tr.timestamps[0], 2);
	near(tr.timestamps[8] - 2, D.gcDistance(NRT, JFK) / 1000, 1e-9, "速さ一定");
});

const AIRPORTS = `1,"Narita International Airport","Tokyo","Japan","NRT","RJAA",35.7647018433,140.386001587,141,9,"U","Asia/Tokyo","airport","OurAirports"
2,"John F Kennedy International Airport","New York","United States","JFK","KJFK",40.63980103,-73.77890015,13,-5,"A","America/New_York","airport","OurAirports"
3,"Heathrow Airport, London","London","United Kingdom","LHR","EGLL",51.4706,-0.461941,83,0,"E","Europe/London","airport","OurAirports"
4,"Nowhere","\\N","\\N","\\N","\\N",abc,0,0,0,"U","\\N","airport","OurAirports"`;
const ROUTES = `JL,1,NRT,1,JFK,2,,0,773
AA,2,NRT,1,JFK,2,Y,0,773
BA,3,JFK,2,LHR,3,,0,744
XX,4,NRT,1,LHR,3,,1,744
YY,5,NRT,1,ZZZ,99,,0,744`;
test("OpenFlights：引用符の中のカンマ・欠測（\\N）・同じ対は 1 本に・乗り継ぎと台帳に無い空港は捨てる", () => {
	const ap = D.parseAirports(AIRPORTS);
	assert.equal(ap.size, 3);
	assert.equal(ap.get(3).name, "Heathrow Airport, London");
	assert.equal(ap.get(1).iata, "NRT");
	const r = D.parseRoutes(ROUTES, ap);
	assert.equal(r.length, 2);
	const nj = r.find(x => x.s === 1 && x.t === 2);
	assert.equal(nj.n, 2); near(nj.km, 10830, 20);
});

test("CSV：区切り（, ; タブ）・BOM・列の当て方（座標・記号・名前が無ければ先頭 2 列）・太さの列", () => {
	assert.deepEqual(D.parseTable("﻿a;b\n1;2").cols, ["a", "b"]);
	assert.deepEqual(D.parseTable("a\tb\n1\t2").rows, [["1", "2"]]);
	assert.deepEqual(D.detectColumns(["from_lon", "from_lat", "to_lon", "to_lat", "count"]), { kind: "coords", sLon: 0, sLat: 1, tLon: 2, tLat: 3, weight: 4 });
	assert.deepEqual(D.detectColumns(["origin_lat", "origin_lon", "dest_lat", "dest_lon"]), { kind: "coords", sLon: 1, sLat: 0, tLon: 3, tLat: 2, weight: -1 });
	assert.deepEqual(D.detectColumns(["date", "origin", "destination", "passengers"]), { kind: "codes", s: 1, t: 2, weight: 3 });
	assert.deepEqual(D.detectColumns(["a", "b"]), { kind: "codes", s: 0, t: 1, weight: -1 });
	assert.equal(D.detectColumns(["a"]), null);
});

test("記号の引き：空港（IATA・ICAO）と国（ISO2・ISO3・名前）・列ごとの多数決・混ざった列も引ける", () => {
	const res = D.makeResolver({ airports: D.parseAirports(AIRPORTS), nations: [{ iso: ["JP", "JPN"], coord: [139, 36], name: "日本", nameEn: "Japan" }, { iso: ["FR", "FRA"], coord: [2, 46], nameEn: "France" }, { iso: ["US", "USA"], coord: [-98, 39], nameEn: "United States" }] });
	const t1 = D.tableToArcs(D.parseTable("from,to,flights\nNRT,JFK,10\nRJAA,EGLL,3\nXXX,JFK,1"), { kind: "codes", s: 0, t: 1, weight: 2 }, res);
	assert.equal(t1.arcs.length, 2); assert.equal(t1.skipped, 1); assert.equal(t1.how, "iata");
	assert.equal(t1.arcs[0].w, 10); assert.equal(t1.arcs[0].sLabel, "NRT Tokyo");
	const t2 = D.tableToArcs(D.parseTable("o,d\nJP,US\nJPN,FRA\njapan,france"), { kind: "codes", s: 0, t: 1, weight: -1 }, res);
	assert.equal(t2.arcs.length, 3, JSON.stringify(t2));
	assert.ok(res.needsAirports(["NRT"]) && !res.needsAirports(["JP"]));
	const t3 = D.tableToArcs(D.parseTable("from_lon,from_lat,to_lon,to_lat\n139.7,35.7,-0.1,51.5\nx,1,2,3\n0,95,0,0"), D.detectColumns(["from_lon", "from_lat", "to_lon", "to_lat"]));
	assert.equal(t3.arcs.length, 1); assert.equal(t3.skipped, 2);
});
