// /globe/hex の純関数の検定（node・DOM なし）：
//  ① 人口の置き形 H3P1（hex-pop.ts）＝書いて読むと同じ・親ごとの束・res − parentRes の上限・壊れた物は投げる
//  ② 親への足し上げ（sumToParent）＝合計が保たれる・粗い段のセルは細かい段の親
//  ③ 段の選び方（resAt）＝ズームが上がると細かく・上限を守る
//  ④ ファイル → 点（csvPoints・toPoints）＝緯度経度の列名・引用符・区切り・線と面は代表点
import assert from "node:assert/strict";
import { encodeHexPop, decodeHexPop, sumToParent, bytesOf } from "../hex-pop.ts";
import { h3 } from "@ortho-earth/h3/core";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✔ ${name}`); };

await t("H3P1＝書いて読むと同じ（r4・親 res 0）", async () => {
	const rows = [];
	for (const [lat, lng, pop] of [[35.68, 139.77, 1234567], [-33.9, 151.2, 42], [64.1, -21.9, 7], [0, 179.99, 3], [0, -170, 9]]) rows.push([h3.latLngToCell(lat, lng, 4), pop]);
	rows.push([h3.cellToCenterChild(h3.getPentagons(0)[0], 4), 1]);   // 五角形の子
	const u8 = encodeHexPop(rows, { parentRes: 0 });
	const d = decodeHexPop(u8);
	assert.equal(d.res, 4); assert.equal(d.parentRes, 0); assert.equal(d.cells.length, rows.length);
	const m = new Map(rows);
	d.cells.forEach((c, i) => assert.equal(d.pop[i], m.get(c), c));
	assert.equal(d.parents.reduce((a, p) => a + p.n, 0), rows.length);
	assert.deepEqual(d.parents.map(p => p.id), [...d.parents.map(p => p.id)].sort(), "親は id 順");
	assert.equal(u8.length, 16 + d.parents.length * 12 + ((rows.length * 2 + 3) & ~3) + rows.length * 4, "1 セル 6 バイト＋親の見出し");
});
await t("H3P1＝r6 を res 1 の親 1 本に・人口は整数に丸める", async () => {
	const home = h3.latLngToCell(35.68, 139.77, 1), kids = h3.cellToChildren(home, 6).slice(0, 2000);
	const rows = kids.map((c, i) => [c, i + 0.4]);
	const d = decodeHexPop(encodeHexPop(rows, { parentRes: 1 }));
	assert.equal(d.parents.length, 1); assert.equal(d.parents[0].id, home);
	assert.deepEqual(new Set(d.cells), new Set(kids));
	assert.equal(d.pop.reduce((a, b) => a + b, 0), rows.reduce((a, r) => a + Math.round(r[1]), 0));
});
await t("H3P1＝混ざった解像度・深すぎる差・壊れた物は投げる", async () => {
	assert.throws(() => encodeHexPop([[h3.latLngToCell(0, 0, 4), 1], [h3.latLngToCell(0, 0, 5), 1]]), /mixed/);
	assert.throws(() => encodeHexPop([[h3.latLngToCell(0, 0, 7), 1]], { parentRes: 1 }), /more than 5/);
	assert.throws(() => decodeHexPop(new Uint8Array(20)), /not an H3P1/);
	const u8 = encodeHexPop([[h3.latLngToCell(0, 0, 4), 1]]);
	assert.throws(() => decodeHexPop(u8.slice(0, u8.length - 2)), /truncated/);
});
await t("bytesOf＝gzip のままでも素でも読む", async () => {
	const u8 = encodeHexPop([[h3.latLngToCell(10, 10, 4), 5]]);
	const gz = new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
	assert.deepEqual(await bytesOf(new Response(gz)), u8);
	assert.deepEqual(await bytesOf(new Response(u8)), u8);
});
await t("sumToParent＝合計が保たれる・親の段のセル", async () => {
	const kids = h3.cellToChildren(h3.latLngToCell(35, 135, 3), 4);
	const pop = kids.map((_, i) => i + 1);
	const m = sumToParent(kids, pop, 3);
	assert.equal(m.size, 1); assert.equal([...m.values()][0], pop.reduce((a, b) => a + b, 0)); assert.equal(h3.getResolution([...m.keys()][0]), 3);
});

const { resAt, csvPoints, toPoints } = await import("../hex.ts").catch(e => { console.error("hex.ts を node で読めない（ブラウザ専用の import が上に来た？）", e.message); process.exit(1); });
await t("resAt＝寄ると細かく・上限を守る", async () => {
	const rs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(z => resAt(z));
	for (let i = 1; i < rs.length; i++) assert.ok(rs[i] >= rs[i - 1], rs.join(","));
	assert.equal(rs[0], 3); assert.equal(rs.at(-1), 6);
	assert.equal(resAt(9, 4), 4, "r6 が無い＝4 まで");
});
await t("csvPoints＝緯度経度の列名・引用符・区切り", async () => {
	const fc = csvPoints('﻿name,Latitude,Longitude,pop\r\n"Tokyo, JP",35.68,139.77,37400000\n"say ""hi""",1,2,\nbad,x,y,1\nfar,95,0,1\n');
	assert.equal(fc.features.length, 2);
	assert.deepEqual(fc.features[0].geometry.coordinates, [139.77, 35.68]);
	assert.equal(fc.features[0].properties.name, "Tokyo, JP"); assert.equal(fc.features[0].properties.pop, 37400000);
	assert.equal(fc.features[1].properties.name, 'say "hi"');
	assert.equal(csvPoints("lat;lng\n1;2\n").features.length, 1);
	assert.equal(csvPoints("緯度\t経度\n1\t2\n").features[0].geometry.coordinates[0], 2);
	assert.throws(() => csvPoints("a,b\n1,2\n"), /latitude/);
});
await t("toPoints＝点はそのまま・線と面は代表点", async () => {
	const fc = toPoints({ type: "FeatureCollection", features: [
		{ type: "Feature", properties: { a: 1 }, geometry: { type: "Point", coordinates: [1, 2] } },
		{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]] } },
		{ type: "Feature", properties: {}, geometry: null },
	] });
	assert.equal(fc.features.length, 2); assert.deepEqual(fc.features[1].geometry.coordinates, [1, 1]);
});
console.log(`hex: ${n} passed`);
