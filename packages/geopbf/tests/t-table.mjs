#!/usr/bin/env node
// t-table: 表（CSV / TSV / XLSX・経緯度列か WKT 列）→ GeoPBF と MBTiles の検定（決定的・外部ツール不要）。
globalThis.ImageData ??= class ImageData { };
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { GeoPBF } from "../src/pbf-base.js";
import { fromTable, parseCSV, parseWKT, decodeText, readXLSX } from "../src/convert/table.js";
import { encodeXLSX } from "../src/modules/encodeXLSX.js";
import { openMBTiles } from "../src/convert/mbtiles.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const fx = (n) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

// ── CSV ──────────────────────────────────────────────────────────────────────
{
	const csv = "﻿名前,経度,緯度,code,pop,ok,when\n東京駅,139.767125,35.681236,01,1000,true,2026-09-12\n\"改行\n入り\",135.5,34.7,13101,-2.5,false,\n\"引用\"\"付き\",1e2,-0.5,0,3.0e2,,x\nnocoord,,,99,,,\n\n";
	const { pbf, stats: s } = await fromTable(csv, { name: "t" });
	const f = pbf.geojson.features;
	ok(s.features === 3 && s.droppedGeometries === 1 && s.rows === 4 && s.delimiter === "," && s.geometry.lon === "経度" && s.geometry.lat === "緯度", "CSV: BOM・日本語列名の経緯度検出・座標なし行を落とす");
	ok(f[0].geometry.coordinates.join() === "139.767125,35.681236" && f[0].properties.名前 === "東京駅" && f[0].properties.code === "01" && f[0].properties.pop === 1000 && f[0].properties.ok === true && f[0].properties.when === "2026-09-12", "CSV: 先頭ゼロは文字列・数値/論理値は型付け・日付は文字列のまま");
	ok(f[1].properties.名前 === "改行\n入り" && f[1].properties.code === 13101 && f[1].properties.pop === -2.5 && f[1].properties.ok === false && !("when" in f[1].properties), "CSV: 引用内の改行・負数・空は無し");
	ok(f[2].properties.名前 === '引用"付き' && f[2].geometry.coordinates.join() === "100,-0.5" && f[2].properties.pop === 300, "CSV: 二重引用のエスケープ・指数表記");
	const tsv = parseCSV("a\tb\n1\t2\n", {}); ok(tsv.delimiter === "\t" && tsv.rows[0].join() === "1,2", "parseCSV: タブ区切りの自動判別");
	const semi = parseCSV("lon;lat\n1,5;2,5\n", { delimiter: ";" }); ok(semi.header.join() === "lon,lat" && semi.rows[0][0] === "1,5", "parseCSV: 区切りの明示");
	const named = await fromTable("id,X座標,Y座標,経度\n1,10,20,30\n", { lon: "経度", lat: "Y座標" });
	ok(named.pbf.geojson.features[0].geometry.coordinates.join() === "30,20" && named.stats.columns.join() === "id,X座標", "列の名指し（opts.lon/lat）が自動検出より優先");
	let threw = ""; try { await fromTable("a,b\n1,2\n"); } catch (e) { threw = e.message; } ok(/経緯度の列.*も WKT の列も見つからない/.test(threw), "経緯度も WKT も無ければ列名付きで拒否");
	threw = ""; try { await fromTable("a,b\n1,2\n", { lon: "nope" }); } catch (e) { threw = e.message; } ok(/列 "nope" が無い/.test(threw), "名指しの列が無ければ拒否");
	const sjis = fx("table/sjis.csv");
	ok(decodeText(sjis).startsWith("名前,経度,緯度,備考"), "decodeText: UTF-8 で読めなければ Shift_JIS");
	const r = await fromTable(sjis);
	ok(r.stats.features === 2 && r.pbf.geojson.features[1].properties.名前 === "大阪駅" && r.pbf.geojson.features[1].properties.備考 === "梅田,北区", "Shift_JIS CSV（CRLF・引用内カンマ）");
	const forced = await fromTable(sjis, { encoding: "sjis" }); ok(forced.stats.features === 2, "encoding: sjis の明示");
	const utf16 = new Uint8Array([0xFF, 0xFE, ...Buffer.from("lon,lat\n1,2\n", "utf16le")]);
	ok((await fromTable(utf16)).stats.features === 1, "UTF-16LE BOM 付き CSV");
}
// ── WKT ──────────────────────────────────────────────────────────────────────
{
	const w = "id\twkt\n1\tPOLYGON((0 0,1 0,1 1,0 1,0 0),(0.2 0.2,0.4 0.2,0.4 0.4,0.2 0.2))\n2\tPOINT Z (1 2 3)\n3\tMULTIPOINT((1 1),(2 2))\n4\tGEOMETRYCOLLECTION(POINT(5 5),LINESTRING(5 5,6 6))\n5\tPOINT EMPTY\n6\tMULTIPOLYGON(((0 0,1 0,1 1,0 0)),((2 2,3 2,3 3,2 2)))\n7\tLINESTRING ZM (0 0 1 2, 1 1 3 4)\n";
	const { pbf, stats: s } = await fromTable(w);
	const g = pbf.geojson.features.map(f => f.geometry);
	ok(s.features === 6 && s.droppedGeometries === 1 && s.geometry.wkt === "wkt" && g.map(x => x.type).join() === "Polygon,Point,MultiPoint,GeometryCollection,MultiPolygon,LineString", "WKT 列: 全種・EMPTY は落とす・Z/ZM は落とす");
	ok(g[0].coordinates.length === 2 && g[1].coordinates.join() === "1,2" && g[4].coordinates.length === 2 && g[5].coordinates[1].join() === "1,1", "WKT: 穴・Z 落とし・多面・ZM");
	ok(JSON.stringify(parseWKT("MULTIPOINT(1 1, 2 2)")) === JSON.stringify({ type: "MultiPoint", coordinates: [[1, 1], [2, 2]] }) && parseWKT("CIRCULARSTRING(0 0,1 1,2 0)") === null && parseWKT("POINT(1)") === null && parseWKT("") === null, "parseWKT: 括弧なし MULTIPOINT・未対応型と壊れた文字列は null");
	const auto = await fromTable("name,geometry\na,\"POINT(139.7 35.6)\"\n");
	ok(auto.stats.features === 1 && auto.stats.geometry.wkt === "geometry", "geometry 列名の WKT を自動検出");
	const sniff = await fromTable("name,shape_text\na,\"POINT(1 2)\"\n");
	ok(sniff.stats.features === 1 && sniff.stats.geometry.wkt === "shape_text", "列名が無くても先頭行の値が WKT なら検出");
}
// ── XLSX ─────────────────────────────────────────────────────────────────────
{
	const book = fx("table/book.xlsx");
	const t = await readXLSX(book);
	ok(t.sheet === "地点" && t.sheets.join() === "地点,Lines" && t.header.join() === "名前,lon,lat,flag,memo", "readXLSX: 先頭シート・sharedStrings の列名");
	ok(t.rows.length === 4 && t.rows[0][0] === "東京" && t.rows[0][1] === 139.767125 && t.rows[0][3] === true && t.rows[0][4] === "inline & text" && t.rows[1][1] === 135.497125 && t.rows[1][3] === false && t.rows[2][4] === "重複" && t.rows[3][0] === "nolat", "readXLSX: 数値・論理値・inlineStr・数式のキャッシュ値・空セル・t=str");
	const { pbf, stats: s } = await fromTable(book);
	ok(s.kind === "xlsx" && s.features === 2 && s.droppedGeometries === 2 && pbf.name() === "地点" && pbf.geojson.features[0].properties.flag === true && pbf.geojson.features[0].properties.memo === "inline & text", "XLSX → GeoPBF: 2 点・座標なし 2 行を落とす・name はシート名");
	const l = await fromTable(book, { sheet: "Lines" });
	ok(l.stats.features === 1 && l.pbf.geojson.features[0].geometry.type === "LineString" && l.pbf.geojson.features[0].properties.n === 7, "XLSX: 名指しシートの WKT 列");
	let threw = ""; try { await fromTable(book, { sheet: "nope" }); } catch (e) { threw = e.message; } ok(/シート "nope" が無い（シート: 地点, Lines）/.test(threw), "無いシートは候補付きで拒否");
	// 自前 encodeXLSX の出力（inlineStr のみ）も読める＝往復
	const mine = await encodeXLSX([["名前", "lon", "lat", "b", "s"], ["A", 1.5, 2.5, true, "x"], ["B", -1, -2, false, ""]], null, { sheetName: "S" });
	const r2 = await fromTable(new Uint8Array(await mine.arrayBuffer()));
	ok(r2.stats.features === 2 && r2.stats.sheet === "S" && r2.pbf.geojson.features[0].properties.b === true && r2.pbf.geojson.features[0].properties.s === "x" && !("s" in r2.pbf.geojson.features[1].properties), "encodeXLSX（inlineStr）の出力を読み戻す");
}
// ── MBTiles ───────────────────────────────────────────────────────────────────
{
	const t = openMBTiles(fx("gpkg/tiny.mbtiles"));
	ok(t.name === "tiny" && t.format === "png" && t.zooms.join() === "0,1" && t.count === 4 && t.minZoom === 0 && t.maxZoom === 1 && t.bboxLonLat.join() === "-180,-85.0511,180,85.0511", "MBTiles(tiles 実表): metadata・ズーム・枚数・bounds");
	ok(t.mimeOf(t.get(1, 1, 0)) === "image/png" && t.has(1, 1, 1) && t.get(1, 0, 1) === null && t.get(0, 0, 0)[0] === 0x89, "MBTiles: TMS→XYZ の行反転・歯抜けは null");
	const v = openMBTiles(fx("gpkg/view.mbtiles"));
	ok(v.format === "pbf" && v.count === 3 && v.zooms.join() === "2,3" && JSON.parse(v.metadata.json).vector_layers[0].id === "roads", "MBTiles(map/images ビュー): 索引は map→images・tile_id 不在は除外");
	const b = v.get(2, 3, 1);
	ok(v.mimeOf(b) === "application/gzip" && Buffer.from(gunzipSync(b)).toString() === "MVT-A" && Buffer.from(gunzipSync(v.get(2, 3, 2))).toString() === "MVT-A" && Buffer.from(gunzipSync(v.get(3, 7, 3))).toString() === "MVT-B", "MBTiles: 同じ tile_id を共有する 2 枚・gzip 包み");
	let threw = ""; try { openMBTiles(fx("gpkg/mixed.gpkg")); } catch (e) { threw = e.message; } ok(/tiles 表も map\/images 表も無い/.test(threw), "MBTiles でない SQLite は拒否");
}
// ── CLI ───────────────────────────────────────────────────────────────────────
{
	const CLI = new URL("../bin/geopbf.mjs", import.meta.url).pathname;
	const dir = mkdtempSync(join(tmpdir(), "geopbf-table-"));
	const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
	const csvPath = join(dir, "a.csv"); writeFileSync(csvPath, "name,lon,lat\nA,139.7,35.6\nB,,\n");
	const out = join(dir, "a.geopbf");
	const log = run("csv2pbf", csvPath, out);
	ok(/features 1/.test(log) && /座標なし 1/.test(log), "CLI csv2pbf: ログ");
	const pbf = await new GeoPBF().set(new Uint8Array(gunzipSync(readFileSync(out))));
	ok(pbf.geojson.features.length === 1 && pbf.geojson.features[0].properties.name === "A", "CLI csv2pbf: 出力を読み戻す");
	const xo = join(dir, "x.geopbf");
	const xlog = run("csv2pbf", new URL("./fixtures/table/book.xlsx", import.meta.url).pathname, xo, "--sheet", "Lines", "--no-gzip");
	ok(/features 1/.test(xlog) && /シート Lines/.test(xlog) && (await new GeoPBF().set(new Uint8Array(readFileSync(xo)))).geojson.features[0].geometry.type === "LineString", "CLI csv2pbf: xlsx と --sheet");
}

console.log(fails ? `\n✗ ${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
