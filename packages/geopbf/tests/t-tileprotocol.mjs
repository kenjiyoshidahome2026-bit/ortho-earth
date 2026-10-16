#!/usr/bin/env node
// t-tileprotocol: geopbf://…/{z}/{x}/{y} のベクタタイル protocol（改良点 ⑥・2026-10-12）。
//   ① createTileSource のタイルは toPMTiles（同 options・tinyPolygon 0）のタイルとバイト列が一致（全 z/x/y・列の分担で結果が変わらない）
//   ② MVT の feature.id＝fid・属性・型（promoteId 無しで feature-state が効く形）
//   ③ makeGeopbfProtocol 1 本で GeoJSON（type:"json"）とタイル（type:"arrayBuffer"・末尾 /z/x/y）を捌く・gzip 透過・空タイル＝0 B・source は URL ごと 1 回
//   ④ parseTileUrl・範囲外・dispose
// node:http でフィクスチャをメモリ配信（t-maplibre と同じ手）。CPU 経路・決定的。
globalThis.ImageData ??= class ImageData { };
import { createServer } from "node:http";
import { GeoPBF } from "../src/pbf-base.ts";
import { bakeGint, initGintWasm } from "../src/convert/node-gint.ts";
import { toPMTiles } from "../src/convert/tiler.ts";
import { readPMTiles } from "../src/convert/pmtiles.ts";
import { decodeTile } from "../src/convert/mvt-decode.ts";
import { createTileSource } from "../src/convert/tilesource.ts";
import { makeGeopbfProtocol, geopbfTileProtocol, parseTileUrl } from "../src/maplibre.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
await initGintWasm();

// ---- フィクスチャ（t-pmtiles と同じ：共有辺・穴・多面・線・点・極小・小島）-----------------
const shared = [[11, 10], [11.0004, 10.2], [10.9996, 10.4], [11.0003, 10.6], [11, 10.8], [11, 11]];
const A = [[10, 10], ...shared, [10, 11], [10, 10]], B = [[12, 10], [12, 11], ...shared.slice().reverse(), [12, 10]];
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const fc = { type: "FeatureCollection", features: [
	{ type: "Feature", properties: { n: "A", v: 1 }, geometry: { type: "Polygon", coordinates: [A] } },
	{ type: "Feature", properties: { n: "B", v: 2, b: true }, geometry: { type: "Polygon", coordinates: [B] } },
	{ type: "Feature", properties: { n: "H" }, geometry: { type: "Polygon", coordinates: [sq(20, 20, 30, 30), sq(23, 23, 27, 27)] } },
	{ type: "Feature", properties: { n: "MP" }, geometry: { type: "MultiPolygon", coordinates: [[sq(40, 40, 41, 41)], [sq(42, 40, 43, 41)]] } },
	{ type: "Feature", properties: { n: "L", d: new Date(0) }, geometry: { type: "LineString", coordinates: [[10, 9], [10.5, 8.5], [11, 9]] } },
	{ type: "Feature", properties: { n: "P", u: "駅・café", neg: -7, z: 0, f: false }, geometry: { type: "Point", coordinates: [10.5, 10.5] } },
	{ type: "Feature", properties: { n: "MPt" }, geometry: { type: "MultiPoint", coordinates: [[1, 1], [2, 2]] } },
	{ type: "Feature", properties: { n: "Dust" }, geometry: { type: "MultiPolygon", coordinates: Array.from({ length: 100 }, (_, i) => [sq(35 + (i % 10) * 0.1, 35 + Math.floor(i / 10) * 0.1, 35.05 + (i % 10) * 0.1, 35.05 + Math.floor(i / 10) * 0.1)]) } },
] };
const pbf = await new GeoPBF({ name: "fix", precision: 6, attribution: "t-tile" }).set(structuredClone(fc));
const gint = await bakeGint(pbf);
const OPTS = { gint, gpu: false, minZoom: 0, maxZoom: 7, dropRate: 1, tinyPolygon: 0 };

// ① toPMTiles と同じバイト列
{
	const r = await toPMTiles(pbf, { ...OPTS, tileCompression: "none", workers: 0 });
	const pm = await readPMTiles(r.buffer);
	const src = await createTileSource(pbf, { ...OPTS, columnCache: 8, zoomCache: 2 });
	let same = 0, diff = 0, missing = 0, extra = 0, nonEmpty = 0;
	for (let z = 0; z <= 7; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) {
		const a = await pm.getTile(z, x, y), b = await src.tile(z, x, y);
		if (a && b) { nonEmpty++; if (a.length === b.length && a.every((v, i) => v === b[i])) same++; else diff++; }
		else if (a && !b) missing++; else if (!a && b) extra++;
	}
	ok(diff === 0 && missing === 0 && extra === 0 && same === r.stats.tiles && same > 50, `① 全 z0〜7 のタイルが toPMTiles と一致（一致 ${same}／不一致 ${diff}／欠け ${missing}／余計 ${extra}・PMTiles ${r.stats.tiles} 枚）`);
	ok(src.metadata.vector_layers[0].id === "fix" && src.metadata.vector_layers[0].fields.v === "Number" && src.metadata.attribution === "t-tile" && src.minZoom === 0 && src.maxZoom === 7, "① metadata＝toPMTiles と同じ（vector_layers.fields・attribution）");
	ok((await src.tile(8, 0, 0)) === null && (await src.tile(3, 8, 0)) === null && (await src.tile(1.5, 0, 0)) === null, "④ 範囲外（z>max・x≥2^z・非整数）＝null");
	// ② feature.id＝fid・属性・型
	const t0 = decodeTile(await src.tile(0, 0, 0))[0];
	const byId = new Map(t0.features.map(f => [f.id, f]));
	ok(t0.name === "fix" && t0.features.length === 7 && byId.get(0).props.n === "A" && byId.get(1).props.b === true && byId.get(4).props.d === "1970-01-01T00:00:00.000Z" && byId.get(5).props.u === "駅・café", `② z0（tinyPolygon 0）: ${t0.features.length} feature（極小の小島は落ちる）・id＝fid・属性`);
	ok(byId.get(0).type === 3 && byId.get(4).type === 2 && byId.get(5).type === 1 && byId.get(6).type === 1, "② 型（面/線/点/多点）");
	// 共有境界：A と B の境界（x≈11 の蛇行）上の頂点は z10 のタイル内で両面が同じ点を持つ（gint の arc が 1 本＝隙間・重なり無し）
	{
		const src10 = await createTileSource(pbf, { ...OPTS, maxZoom: 10 });
		const z = 10, lat = 10.4, X = Math.floor((11 + 180) / 360 * 2 ** z), Y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
		const t = decodeTile(await src10.tile(z, X, Y))[0];
		const pts = (f) => { const g = f.geometry[0], o = []; for (let i = 0; i < g.length; i += 2) o.push([g[i], g[i + 1]]); return o; };
		const lonOf = (x) => (X + x / 4096) / 2 ** z * 360 - 180;
		const onBand = ([x]) => Math.abs(lonOf(x) - 11) < 0.001;   // 蛇行の帯（±0.0004°）＋余裕
		const ra = new Set(pts(t.features.find(f => f.id === 0)).map(p => p.join(","))), rb = pts(t.features.find(f => f.id === 1)).filter(onBand);
		const common = rb.filter(p => ra.has(p.join(","))).length;
		ok(rb.length >= 3 && common === rb.length, `② z${z}: 境界帯の B の頂点 ${rb.length} 点が全部 A にもある（共通 ${common}）`);
		src10.destroy();
	}
	src.destroy();
	let threw = false; try { await src.tile(0, 0, 0); } catch { threw = true; }
	ok(threw, "④ destroy 後の tile は例外");
}
// ② 既定の tinyPolygon（2）＝t-pmtiles と同じ z0（極小の小島 Dust は代替の正方形で残る）
{
	const src = await createTileSource(pbf, { ...OPTS, tinyPolygon: undefined });
	const t0 = decodeTile(await src.tile(0, 0, 0))[0];
	ok(t0.features.length === 8 && t0.features.some(f => f.props.n === "Dust"), `② 既定 tinyPolygon の z0: ${t0.features.length} feature（Dust が残る）`);
	src.destroy();
}
// ③ protocol（http 配信・gzip 透過・GeoJSON とタイルを 1 本で）
{
	const raw = new Uint8Array(pbf.arrayBuffer);
	const gz = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
	let hits = 0;
	const server = createServer((req, res) => {
		hits++;
		const body = { "/fix.geopbf": raw, "/fix.geopbf.gz": gz }[req.url.split("?")[0]];
		if (!body) { res.statusCode = 404; res.end(); return; }
		res.setHeader("content-type", "application/octet-stream"); res.end(Buffer.from(body));
	});
	await new Promise(r => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	const h = makeGeopbfProtocol({ tiler: { gpu: false, maxZoom: 7, dropRate: 1 } });
	const t0 = await h({ url: `geopbf://${base}/fix.geopbf/0/0/0`, type: "arrayBuffer" });
	ok(t0.data instanceof ArrayBuffer && decodeTile(new Uint8Array(t0.data))[0].features.length === 8, `③ タイル要求（arrayBuffer・/0/0/0）＝MVT（${t0.data.byteLength} B）`);
	const t7 = await h({ url: `geopbf://${base}/fix.geopbf/7/0/0.pbf`, type: "arrayBuffer" });
	ok(t7.data instanceof ArrayBuffer && t7.data.byteLength === 0, "③ feature の無いタイル＝0 B の ArrayBuffer（.pbf 接尾辞も可）");
	const g = await h({ url: `geopbf://${base}/fix.geopbf`, type: "json" });
	ok(g.data?.type === "FeatureCollection" && g.data.features.length === fc.features.length, "③ 同じハンドラで GeoJSON（type:json・/z/x/y 無し）");
	const before = hits;
	for (let i = 0; i < 20; i++) await h({ url: `geopbf://${base}/fix.geopbf/3/${i % 8}/4`, type: "arrayBuffer" });
	ok(hits === before && h.tiles.sources.size === 1, `③ source は URL ごと 1 回（fetch ${hits} 回・sources ${h.tiles.sources.size}）`);
	const tz = await h({ url: `geopbf://${base}/fix.geopbf.gz/0/0/0`, type: "arrayBuffer" });
	ok(decodeTile(new Uint8Array(tz.data))[0].features.length === 8, "③ 全体 gzip の geopbf も透過");
	const te = await geopbfTileProtocol({ url: `geopbf://${base}/fix.geopbf/1/1/0`, type: "arrayBuffer" });
	ok(te.data instanceof ArrayBuffer && te.data.byteLength > 0, "③ geopbfTileProtocol（タイル専用）");
	let threw = false; try { await geopbfTileProtocol({ url: `geopbf://${base}/fix.geopbf`, type: "arrayBuffer" }); } catch { threw = true; }
	ok(threw, "③ タイル専用ハンドラに /z/x/y 無し＝例外");
	let bad = false; try { await h({ url: `geopbf://${base}/none.geopbf/0/0/0`, type: "arrayBuffer" }); } catch { bad = true; }
	ok(bad && !h.tiles.sources.has(`${base}/none.geopbf`), "③ 取得失敗は例外・失敗した source はキャッシュに残らない");
	await h.tiles.dispose(`${base}/fix.geopbf`);
	ok(h.tiles.sources.size === 1 && !h.tiles.sources.has(`${base}/fix.geopbf`), "④ dispose で手放す（gz の方は残る）");
	await geopbfTileProtocol.dispose(`${base}/fix.geopbf`); await h.tiles.dispose(`${base}/fix.geopbf.gz`);
	server.close();
}
// ④ parseTileUrl
ok(JSON.stringify(parseTileUrl("geopbf://https://h/a.geopbf/3/7/3")) === JSON.stringify({ inner: "geopbf://https://h/a.geopbf", z: 3, x: 7, y: 3 })
	&& parseTileUrl("geopbf://https://h/a.geopbf/14/9000/4000.mvt?x=1")?.y === 4000 && parseTileUrl("geopbf://https://h/a.geopbf") === null && parseTileUrl("geopbf://https://h/3/7") === null, "④ parseTileUrl（.mvt/.pbf・クエリ・非タイル）");

console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
