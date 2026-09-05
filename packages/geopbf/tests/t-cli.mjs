#!/usr/bin/env node
// t-cli: bin/geopbf.mjs の検定（Node 20+・外部データ不要＝決定的）。
// CLI は「別プロセスとして起動して標準出力と終了コードを見る」＝利用者と同じ経路で確かめる。
// 使い方: node packages/geopbf/tests/t-cli.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

const CLI = new URL("../bin/geopbf.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "geopbf-cli-"));
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

// ---- 元データ（全ジオメトリ種・型付き属性・null 属性・日本語）--------------------
const src = {
	type: "FeatureCollection",
	name: "cli-fixture",
	features: [
		{ type: "Feature", properties: { n: 1, s: "東京", b: true, nil: null },
			geometry: { type: "Point", coordinates: [139.767125, 35.681236] } },
		{ type: "Feature", properties: { n: 2.5 },
			geometry: { type: "LineString", coordinates: [[135.5, 34.7], [135.6, 34.75], [135.7, 34.7]] } },
		{ type: "Feature", properties: { s: "square" },
			geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } },
		{ type: "Feature", properties: {},
			geometry: { type: "MultiPolygon", coordinates: [[[[10, 10], [11, 10], [11, 11], [10, 10]]]] } },
	],
};
const geojson = join(dir, "in.geojson");
writeFileSync(geojson, JSON.stringify(src));

// ---- enc / info / dec の往復 ---------------------------------------------------
const pbfPath = join(dir, "out.geopbf");
run("enc", geojson, pbfPath);
ok(existsSync(pbfPath), "enc がファイルを書く");

const infoOut = run("info", pbfPath);
ok(/features\s+4/.test(infoOut), "info が地物数を出す");
ok(/precision\s+6/.test(infoOut), "info が既定 precision=6 を出す");
ok(infoOut.includes("cli-fixture"), "info がレイヤ名を出す");

const backPath = join(dir, "back.geojson");
run("dec", pbfPath, backPath);
const back = JSON.parse(readFileSync(backPath, "utf8"));
ok(back.features.length === 4, "dec が地物数を保つ");
ok(back.features[0].geometry.coordinates[0] === 139.767125, "点の座標が precision=6 で一致");
ok(back.features[0].properties.s === "東京", "文字列（日本語）が往復する");
ok(back.features[0].properties.n === 1, "整数が数値のまま往復する");
ok(back.features[1].properties.n === 2.5, "実数が往復する");
ok(back.features[0].properties.b === true, "真偽が往復する");
ok(!("nil" in back.features[0].properties), "null 属性は落ちる（GeoPBF では未設定と同義）");
ok(back.features.map(f => f.geometry.type).join(",") === "Point,LineString,Polygon,Polygon",
	"ジオメトリ種別が保たれる（単部の MultiPolygon は Polygon へ正規化される）");
ok(JSON.stringify(back.features[2].geometry.coordinates[0][0]) === "[0,0]",
	"リングの先頭点は保たれる（巻き方向は書き手が正規化する）");

// ---- precision ------------------------------------------------------------------
const p3 = join(dir, "p3.geopbf");
run("enc", geojson, p3, "--precision", "3");
ok(/precision\s+3/.test(run("info", p3)), "--precision がヘッダに載る");
run("dec", p3, join(dir, "p3.geojson"));
const c3 = JSON.parse(readFileSync(join(dir, "p3.geojson"), "utf8")).features[0].geometry.coordinates[0];
ok(Math.abs(c3 - 139.767125) < 1e-3 && c3 !== 139.767125, `precision=3 で桁が落ちる（${c3}）`);

let threw = false;
try { run("enc", geojson, join(dir, "bad.geopbf"), "--precision", "12"); } catch { threw = true; }
ok(threw, "範囲外の --precision は失敗する");
threw = false;
try { run("enc", geojson, join(dir, "bad0.geopbf"), "--precision", "0"); } catch { threw = true; }
ok(threw, "--precision 0 も範囲外（pbf-base が黙って 6 に落とすため 1-9 のみ）");

// ---- gzip -----------------------------------------------------------------------
const head = readFileSync(pbfPath);
ok(head[0] === 0x1f && head[1] === 0x8b, "enc の既定は gzip（署名で始まる）");
ok(/features\s+4/.test(run("info", pbfPath)), "gzip 入力を拡張子によらず透過的に読む");
const rawPath = join(dir, "out.raw.geopbf");
run("enc", geojson, rawPath, "--no-gzip");
const rawHead = readFileSync(rawPath);
ok(!(rawHead[0] === 0x1f && rawHead[1] === 0x8b), "--no-gzip は生の GeoPBF を書く");
ok(/features\s+4/.test(run("info", rawPath)), "生の GeoPBF も読める");
const gzJson = join(dir, "in.geojson.gz");
writeFileSync(gzJson, gzipSync(readFileSync(geojson)));
run("enc", gzJson, join(dir, "fromgz.geopbf"));
ok(/features\s+4/.test(run("info", join(dir, "fromgz.geopbf"))), "gzip された GeoJSON も enc が署名で判別して読む");

// ---- lod ------------------------------------------------------------------------
const lodOut = run("lod", pbfPath);
const rows = [...lodOut.matchAll(/^\s+(\d+)\s+(\d+)\s+([\d,]+)\s+/gm)]
	.map(m => ({ z: +m[1], keep: +m[3].replace(/,/g, "") }));
ok(rows.length >= 10, "lod がズーム別の表を出す");
ok(rows.every((r, i) => i === 0 || r.keep >= rows[i - 1].keep), "描画頂点数はズームに対して単調非減少");
const totalVerts = +/頂点\s+([\d,]+)/.exec(run("info", pbfPath))[1].replace(/,/g, "");
ok(rows.at(-1).z === 21 && rows.at(-1).keep === totalVerts,
	`z=21 では全頂点が残る（${totalVerts}）`);

// ---- 使い方 ----------------------------------------------------------------------
ok(run("--help").includes("geopbf <command>"), "--help が使い方を出す");
let badCmd = false;
try { run("nosuch"); } catch { badCmd = true; }
ok(badCmd, "未知のコマンドは終了コード 1");

console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
