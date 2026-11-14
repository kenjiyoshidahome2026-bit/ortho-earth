// 回線なしの地名検索（M4）の検定：MVT の places 層の点を読む・アーカイブから索引を作る・引く。
// 元＝合成の PMTiles（z12 のタイル 2 枚・gzip の MVT・同じ中身の連続あり）。node apps/unmap/tests/t-places.mjs
import { gzipSync, gunzipSync } from "node:zlib";
import { serializeHeader, serializeDir, tileId, openExtractSource } from "@ortho-earth/core/pmtiles-extract";
import { mvtPoints, indexPlaces, searchPlaces, fold, zoomForKind } from "../places.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };

// ── 最小の MVT 書き手 ──
const vint = (a, n) => { while (n >= 128) { a.push(n % 128 | 128); n = Math.floor(n / 128); } a.push(n); };
const key = (a, f, w) => vint(a, f << 3 | w);
const bytes = (a, f, b) => { key(a, f, 2); vint(a, b.length); a.push(...b); };
const str = s => [...Buffer.from(s)];
const zz = n => (n << 1) ^ (n >> 31);
function layer(name, feats, extent = 4096) {
	const keys = [], vals = [], a = [];
	bytes(a, 1, str(name));
	for (const f of feats) {
		const fa = [], tags = [];
		for (const [k, v] of Object.entries(f.props)) { let ki = keys.indexOf(k); if (ki < 0) { keys.push(k); ki = keys.length - 1; } let vi = vals.indexOf(v); if (vi < 0) { vals.push(v); vi = vals.length - 1; } tags.push(ki, vi); }
		const t = []; tags.forEach(x => vint(t, x)); bytes(fa, 2, t);
		key(fa, 3, 0); vint(fa, f.type);
		const g = []; f.geom.forEach(x => vint(g, x)); bytes(fa, 4, g);
		bytes(a, 2, fa);
	}
	for (const k of keys) bytes(a, 3, str(k));
	for (const v of vals) { const va = []; if (typeof v === "string") bytes(va, 1, str(v)); else { key(va, 4, 0); vint(va, v); } bytes(a, 4, va); }
	key(a, 5, 0); vint(a, extent); key(a, 15, 0); vint(a, 2);
	return a;
}
const pt = (x, y) => [9, zz(x), zz(y)];
function tile(places, extra = true) {
	const t = [];
	if (extra) bytes(t, 3, layer("earth", [{ type: 3, props: { kind: "earth" }, geom: [9, 0, 0, 26, zz(4096), 0, 0, zz(4096), zz(-4096), 0, 15] }]));
	bytes(t, 3, layer("places", places.map(p => ({ type: 1, props: p.props, geom: pt(p.x, p.y) }))));
	return gzipSync(Buffer.from(t));
}
// z12 の東京のあたり 2 枚 + 中身の無い（同じ中身）2 枚
const Z = 12, X = 3637, Y = 1612;
const T1 = tile([
	{ x: 1024, y: 2048, props: { kind: "locality", name: "東京", "name:en": "Tokyo", "name:fr": "Tokyo", "name:ar": "طوكيو", population_rank: 15 } },
	{ x: 3000, y: 100, props: { kind: "neighbourhood", name: "新宿", "name:en": "Shinjuku", population_rank: 9 } },
	{ x: 10, y: 10, props: { kind: "locality", name: "" } },
]);
const T2 = tile([{ x: 500, y: 500, props: { kind: "locality", name: "São Gonçalo", population_rank: 11 } }, { x: 600, y: 600, props: { kind: "locality", name: "Tokyo Bay Town", population_rank: 3 } }]);
const EMPTY = tile([], true);
const ents = [[tileId(Z, X, Y), T1], [tileId(Z, X + 1, Y), T2]].sort((a, b) => a[0] - b[0]);
const runId = tileId(Z, X, Y + 1);
const datas = [...ents.map(e => e[1]), EMPTY];
const dirEs = []; let off = 0;
for (const [id, d] of ents) { dirEs.push({ tileId: id, offset: off, length: d.length, runLength: 1 }); off += d.length; }
dirEs.push({ tileId: runId, offset: off, length: EMPTY.length, runLength: 2 }); off += EMPTY.length;
dirEs.sort((a, b) => a.tileId - b.tileId);
const dir = serializeDir(dirEs), data = Buffer.concat(datas);
const h = { rootOffset: 127, rootLength: dir.length, metadataOffset: 127 + dir.length, metadataLength: 0, leafOffset: 127 + dir.length, leafLength: 0, dataOffset: 127 + dir.length, dataLength: data.length,
	addressedTiles: 4, tileEntries: 3, tileContents: 3, clustered: false, internalCompression: 1, tileCompression: 2, tileType: 1, minZoom: 12, maxZoom: 12, minLon: 139, minLat: 35, maxLon: 141, maxLat: 36, centerZoom: 12, centerLon: 140, centerLat: 35.5 };
const file = Buffer.concat([serializeHeader(h), dir, data]);

{
	const raw = new Uint8Array(gunzipSync(T1));
	const p = mvtPoints(raw, "places");
	ok("MVT：places 層の点（属性・位置）", p.length === 3 && p[0].props["name:en"] === "Tokyo" && p[0].props.population_rank === 15 && Math.abs(p[0].x - 0.25) < 1e-9 && Math.abs(p[0].y - 0.5) < 1e-9);
	ok("MVT：他の層は読まない", mvtPoints(raw, "earth").length === 0 && mvtPoints(raw, "roads").length === 0);
}

const src = await openExtractSource(async (o, l) => new Uint8Array(file.subarray(o, o + l)));
const idx = await indexPlaces(src);
ok("索引：名前の無い点は捨てる・同じ中身の連続も 1 度", idx.length === 4, idx.map(p => p.name).join(","));
const tokyo = idx.find(p => p.name === "東京");
const lon = (X + 0.25) / 4096 * 360 - 180;
ok("索引：経緯度（タイル内の位置から）", Math.abs(tokyo.lon - lon) < 1e-4 && tokyo.lat > 35 && tokyo.lat < 36);
ok("索引：6 言語の名・kind・順位", tokyo.names.en === "Tokyo" && tokyo.names.ar === "طوكيو" && tokyo.kind === "locality" && tokyo.rank === 15 && !("ru" in tokyo.names));
{
	const r = searchPlaces(idx, "tok");
	ok("引く：前方一致が先・人口の順", r[0].name === "東京" && r[1].name === "Tokyo Bay Town");
	ok("引く：現地語の名でも", searchPlaces(idx, "新宿")[0]?.name === "新宿");
	ok("引く：アクセントと大文字を無視", searchPlaces(idx, "sao goncalo")[0]?.name === "São Gonçalo" && fold("ÉCOLE") === "ecole");
	ok("引く：語の途中は後（含む）", searchPlaces(idx, "bay")[0]?.name === "Tokyo Bay Town");
	ok("引く：見せる名前は選んだ言語", searchPlaces(idx, "東京", { lang: "ar" })[0].label === "طوكيو" && searchPlaces(idx, "東京", { lang: "ru" })[0].label === "東京");
	ok("引く：空なら空", searchPlaces(idx, "  ").length === 0);
	ok("寄るズーム", zoomForKind("country") < zoomForKind("locality") && zoomForKind("neighbourhood") > zoomForKind("locality"));
}
if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall pass");
