// 保存した範囲の版（M5）の検定：保存の印を読む・古い物を選ぶ・切り直しの仕事・国の箱を 1 範囲に収める。
// node apps/unmap/tests/t-versions.mjs
import { savedOf, staleOf, recutJobs } from "../versions.ts";
import { countryRect, MAX_SIDE } from "../area-jobs.ts";
import { serializeHeader, z8Around, z8Bbox, z8OfBbox } from "@ortho-earth/core/pmtiles-extract";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const SRC = { map: "https://x.test/planet.pmtiles", terrain: "https://x.test/gel.pmtiles" };

// 小さな PMTiles（ヘッダ＋metadata だけ）
const fileOf = (md, rect, { minZoom = 0, maxZoom = 14, compression = 1 } = {}) => {
	const m = new TextEncoder().encode(JSON.stringify(md)), [w, s, e, n] = z8Bbox(rect);
	const h = serializeHeader({ rootOffset: 127, rootLength: 0, metadataOffset: 127, metadataLength: m.length, leafOffset: 127 + m.length, leafLength: 0, dataOffset: 127 + m.length, dataLength: 0,
		addressedTiles: 0, tileEntries: 0, tileContents: 0, clustered: true, internalCompression: compression, tileCompression: 2, tileType: 1, minZoom, maxZoom,
		minLon: w, minLat: s, maxLon: e, maxLat: n, centerZoom: minZoom, centerLon: (w + e) / 2, centerLat: (s + n) / 2 });
	return new Blob([h, m]);
};
const tokyo = z8Around(139.7, 35.68, 3);
{
	const s = await savedOf(fileOf({ name: "x", unmap: { area: "abc", part: tokyo, version: "v1" } }, tokyo), "map", "area-abc.pmtiles");
	ok("savedOf：印とヘッダ", s && s.tag.area === "abc" && s.tag.version === "v1" && s.maxZoom === 14 && s.dir === "unmap/map");
	const g = await savedOf(fileOf({ unmap: { area: "abc" } }, tokyo, { compression: 2 }), "map", "x.pmtiles");
	ok("savedOf：gzip の metadata＝印なし", g && !g.tag.area);
	ok("savedOf：壊れた物＝null", (await savedOf(new Blob([new Uint8Array(10)]), "map", "bad.pmtiles")) === null);
}
const S = (kind, name, tag, rect = tokyo, z = [0, 14]) => ({ kind, dir: `unmap/${kind}`, name, minZoom: z[0], maxZoom: z[1], bounds: z8Bbox(rect), tag });
{
	const saved = [S("map", "world.pmtiles", { world: true, version: "v1" }), S("map", "area-a.pmtiles", { area: "a", part: tokyo, version: "v1" }), S("terrain", "area-a.pmtiles", { area: "a", part: tokyo, version: "g1" }, tokyo, [2, 10])];
	ok("同じ版＝古い物なし", staleOf(saved, { map: "v1", terrain: "g1" }).length === 0);
	ok("planet の版が進む＝地図だけ（世界の土台も）", staleOf(saved, { map: "v2", terrain: "g1" }).map(s => s.name).join() === "world.pmtiles,area-a.pmtiles");
	ok("元が分からない＝比べない", staleOf(saved, { map: undefined, terrain: "g1" }).length === 0);
	const old = [...saved, S("map", "area-old.pmtiles", { area: "old" })];
	ok("印の無い古い保存：揃っている時は数えない", staleOf(old, { map: "v1", terrain: "g1" }).length === 0);
	ok("印の無い古い保存：版が進めば一緒に揃える", staleOf(old, { map: "v2" }).length === 3);

	const jobs = recutJobs(staleOf(old, { map: "v2", terrain: "g2" }), { map: SRC.map, terrain: SRC.terrain }, "2026-12-01T00:00:00Z");
	ok("切り直し：世界 → 地図 → 地形", jobs.map(j => `${j.dir}:${j.name}`).join(" ") === "unmap/map:world unmap/map:area-a unmap/map:area-old unmap/terrain:area-a");
	ok("切り直し：同じ範囲・同じズーム", JSON.stringify(jobs[1].rect) === JSON.stringify(tokyo) && jobs[3].minZoom === 2 && jobs[3].maxZoom === 10 && jobs[0].rect === null);
	ok("切り直し：印の無い保存はヘッダの箱から同じ z8 の四角", JSON.stringify(jobs[2].rect) === JSON.stringify(tokyo));
	ok("切り直し：古い版の印は捨て・範囲の名と切り直した日を残す", jobs[1].tag.area === "a" && !("version" in jobs[1].tag) && jobs[1].tag.recutAt === "2026-12-01T00:00:00Z");
	ok("切り直し：元の無い種類は飛ばす", recutJobs(saved, { map: SRC.map, terrain: null }).every(j => j.dir === "unmap/map"));
}
// 国に合わせる
{
	const small = z8OfBbox(5.7, 49.4, 6.6, 50.2);   // ルクセンブルク
	const r = countryRect(small, small.x0, small.y0);
	ok("小さな国＝箱のまま", !r.clipped && JSON.stringify(r.rect) === JSON.stringify(small));
	const big = z8OfBbox(-73.9, -33.7, -34.8, 5.3);   // ブラジル
	const t = z8Around(-46.6, -23.5, 1);              // サンパウロ
	const c = countryRect(big, t.x0, t.y0), w = ((c.rect.x1 - c.rect.x0) % 256 + 256) % 256 + 1, h = c.rect.y1 - c.rect.y0 + 1;
	ok("大きな国＝1 範囲の大きさに切る", c.clipped && w === MAX_SIDE && h === MAX_SIDE);
	ok("切った四角はタップの所を含み国の箱の中", ((t.x0 - c.rect.x0 + 256) % 256) < w && t.y0 >= c.rect.y0 && t.y0 <= c.rect.y1 && c.rect.y0 >= big.y0 && c.rect.y1 <= big.y1 && ((c.rect.x0 - big.x0 + 256) % 256) + w <= ((big.x1 - big.x0 + 256) % 256) + 1);
	const fiji = z8OfBbox(177, -21, -178, -12.4);     // 日付変更線を跨ぐ
	const f = countryRect(fiji, fiji.x0, fiji.y0);
	ok("跨ぐ国＝跨いだまま（保存で東西に割る）", !f.clipped && f.rect.x0 > f.rect.x1);
}
if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall pass");
