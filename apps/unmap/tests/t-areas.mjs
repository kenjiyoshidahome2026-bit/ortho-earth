// 範囲の保存（M3）の決まりの検定：仕事の組み方（世界の土台・地図・地形・日付変更線で割る）・名前・大きさ・上限ズームの選び直し。
// node apps/unmap/tests/t-areas.mjs
import { jobsFor, areaName, areaIdOf, areaKm, fitZoom, human, MAP_ZOOM, WORLD_NAME } from "../area-jobs.ts";
import { z8Around } from "@ortho-earth/core/pmtiles-extract";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const SRC = { osm: "https://x.test/planet.pmtiles", gel: "https://x.test/gel.pmtiles" };

{
	const rect = z8Around(36.82, -1.29, 3);   // ナイロビ
	const j = jobsFor({ rect, mapZoom: MAP_ZOOM, terrainZoom: 10, world: true }, SRC, "abc");
	ok("世界の土台 → 地図 → 地形", j.map(x => `${x.dir}:${x.name}`).join(" ") === `unmap/map:${WORLD_NAME} unmap/map:area-abc unmap/terrain:area-abc`);
	ok("地図は z0–14・地形は z2–10・世界は z0–5 の全球", j[1].minZoom === 0 && j[1].maxZoom === 14 && j[2].minZoom === 2 && j[2].maxZoom === 10 && j[0].rect === null && j[0].maxZoom === 5);
	ok("箱は z8 の端に揃う（範囲を含む）", j[1].bbox[0] < 36.82 && j[1].bbox[2] > 36.82 && j[1].bbox[1] < -1.29 && j[1].bbox[3] > -1.29);
	ok("印（metadata）", j[1].tag.area === "abc" && j[1].tag.rect.x0 === rect.x0);
	const j2 = jobsFor({ rect, mapZoom: 13, terrainZoom: null, world: false }, SRC, "abc");
	ok("地形 off・世界あり済み＝地図だけ", j2.length === 1 && j2[0].maxZoom === 13);
	ok("GEL の無い時は地形を組まない", jobsFor({ rect, mapZoom: 14, terrainZoom: 10, world: false }, { osm: SRC.osm, gel: null }, "x").length === 1);
}
{
	const rect = z8Around(179.9, -17.7, 3);   // フィジー（日付変更線）
	const j = jobsFor({ rect, mapZoom: 14, terrainZoom: 10, world: false }, SRC, "fj");
	ok("跨ぐ範囲＝東西 2 本ずつ", j.map(x => x.name).join(" ") === "area-fj-w area-fj-e area-fj-w area-fj-e");
	ok("どの箱も跨がない", j.every(x => x.bbox[0] < x.bbox[2]) && j.every(x => x.rect.x0 <= x.rect.x1));
	const [a, b] = areaKm(rect);
	ok("大きさ（km）は跨いでも正", a > 300 && a < 600 && b > 300 && b < 600, `${Math.round(a)}×${Math.round(b)}`);
}
ok("ファイル名 ↔ id", areaIdOf(areaName("k3x", 0, 1) + ".pmtiles") === "k3x" && areaIdOf(areaName("k3x", 1, 2) + ".pmtiles") === "k3x" && areaIdOf("world.pmtiles") === null && areaIdOf("area-x.pmtiles.part") === null);
{
	const plan = { minZoom: 0, maxZoom: 14, entries: [10, 11, 12, 13, 14].map((z, i) => ({ tileId: (4 ** z - 1) / 3, offset: i * 1000, length: 100 * 4 ** (z - 10), runLength: 1 })) };
	const [z, b] = fitZoom([plan], 14, 10000);
	ok("上限に収まる地図の上限ズーム", z === 13 && b === 100 + 400 + 1600 + 6400, `z${z} ${b}`);
	ok("収まらなくても下限で止まる", fitZoom([plan], 14, 0, 10)[0] === 10);
}
ok("human", human(512e6) === "512 MB" && human(1.5e9) === "1.50 GB" && human(null) === "?");
if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall pass");
