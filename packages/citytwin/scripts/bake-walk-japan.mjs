#!/usr/bin/env node
// 全国の歩ける道の網（わが家のまわりの道のりと道順の元）を先に焼く → bake-out/walk/（R2 へは uploader のボタン「歩ける道の網（全国）」で GIS/walk/ へ・2026-11-25）。
// 中身と区画は市ごとの焼き（bake-city.mjs の walk）と同じ＝0.02° 四方の区画ごとの walk/<cx>_<cy>.bin（core.ts の encodeWalk・種別は walkKind）。
// 市ごとの焼きは Overpass を区画ずつ引くが、全国は Geofabrik の日本の PBF を GDAL（ogr2ogr）で 1 度読む（Overpass は混む・2026-11-15 福岡）。
//
//   node packages/citytwin/scripts/bake-walk-japan.mjs                     # PBF が無ければ Geofabrik から取る（約 2.3 GB）
//   node packages/citytwin/scripts/bake-walk-japan.mjs --pbf=<file.osm.pbf> # 手元の PBF（県や地方の PBF でも可＝試し焼き）
//   node packages/citytwin/scripts/bake-walk-japan.mjs --box=139.0,36.6,139.25,36.85   # 範囲だけ（川場で市ごとの焼きと見比べる）
//
// 手元の Mac で（GDAL の ogr2ogr が要る＝brew install gdal）。区画をいったん 1° 四方の仮の束（bake-out/walk-tmp/）に書いてから区画ごとに詰める＝全国でもメモリは 1° 分だけ。
// 出す物：bake-out/walk/<cx>_<cy>.bin・bake-out/walk/index.json { made, source, cells: [鍵…], bytes }（uploader が読む・最後に R2 へ置く）
// 許諾：© OpenStreetMap contributors（ODbL）。
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFileSync } from "node:child_process";
import { WALK_CELL, WALK_Q, walkKind, encodeWalk } from "../src/core.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "../../..");
const OUT = path.join(ROOT, "bake-out/walk"), TMP = path.join(ROOT, "bake-out/walk-tmp"), OSM = path.join(ROOT, "bake-out/osm");
const opt = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split("=")[1];
const BOX = opt("box")?.split(",").map(Number);
const GEOFABRIK = "https://download.geofabrik.de/asia/japan-latest.osm.pbf";

// 1. PBF
let pbf = opt("pbf");
if (!pbf) {
	pbf = path.join(OSM, "japan-latest.osm.pbf");
	if (!fs.existsSync(pbf)) {
		fs.mkdirSync(OSM, { recursive: true });
		console.log(`PBF を取る：${GEOFABRIK}`);
		execFileSync("curl", ["-fL", "--retry", "5", "-o", pbf + ".part", GEOFABRIK], { stdio: "inherit" });
		fs.renameSync(pbf + ".part", pbf);
	}
}
try { execFileSync("ogr2ogr", ["--version"], { stdio: "ignore" }); } catch { console.error("ogr2ogr が無い＝brew install gdal"); process.exit(1); }

// 2. 道（lines の層・highway のある線）を 1 行 1 地物で読み、区画で切って 1° の仮の束へ
fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
const tags = hs => { const t = {}; for (const m of (hs || "").matchAll(/"((?:[^"\\]|\\.)*)"=>"((?:[^"\\]|\\.)*)"/g)) t[m[1]] = m[2]; return t; };
const packOf = k => { const [cx, cy] = k.split("_").map(Number); return `${Math.floor(cx * WALK_CELL)}_${Math.floor(cy * WALK_CELL)}`; };
const streams = new Map();
const put = (k, line) => { const p = packOf(k); let s = streams.get(p); if (!s) streams.set(p, s = fs.createWriteStream(path.join(TMP, p + ".tsv"))); s.write(line); };
const args = ["-f", "GeoJSONSeq", "/vsistdout/", pbf, "lines", "-where", "highway IS NOT NULL", "-select", "osm_id,highway,other_tags", "-lco", "COORDINATE_PRECISION=6"];
if (BOX) args.push("-spat", ...BOX.map(String));
const ogr = spawn("ogr2ogr", args, { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, OGR_INTERLEAVED_READING: "YES", OSM_MAX_TMPFILE_SIZE: "4096" } });
let seen = 0, ways = 0, t0 = Date.now();
for await (const s of readline.createInterface({ input: ogr.stdout, crlfDelay: Infinity })) {
	if (!s.startsWith("{")) continue;
	const f = JSON.parse(s); seen++;
	const p = f.properties, t = { ...tags(p.other_tags), highway: p.highway };
	const kind = walkKind(t); if (kind < 0) continue;
	const lines = f.geometry?.type === "LineString" ? [f.geometry.coordinates] : f.geometry?.type === "MultiLineString" ? f.geometry.coordinates : [];
	for (const g of lines) {
		ways++;
		const P = g.map(([x, y]) => [Math.round(x / WALK_Q), Math.round(y / WALK_Q)]);
		let cur = null, key = "";
		const flush = () => { if (cur) put(key, `${key}\t${kind}\t${cur.join(",")}\n`); };
		for (let i = 1; i < P.length; i++) {   // bake-city.mjs の walk と同じ切り方＝線分の中点の区画・境の点は両方に入る
			const k = `${Math.floor((P[i - 1][0] + P[i][0]) / 2 * WALK_Q / WALK_CELL)}_${Math.floor((P[i - 1][1] + P[i][1]) / 2 * WALK_Q / WALK_CELL)}`;
			if (k !== key) { flush(); key = k; cur = [...P[i - 1]]; }
			cur.push(...P[i]);
		}
		flush();
	}
	if (seen % 200000 === 0) process.stdout.write(`\r道：${seen} 本を見た・採った ${ways} 本・束 ${streams.size}・${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
}
const code = await new Promise(r => ogr.on("close", r));
if (code) { console.error(`\nogr2ogr が ${code} で止まった`); process.exit(1); }
await Promise.all([...streams.values()].map(s => new Promise(r => s.end(r))));
console.log(`\n道：${seen} 本を見た・採った ${ways} 本・1° の束 ${streams.size}`);

// 3. 束ごとに区画へ詰める
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const cells = []; let bytes = 0;
for (const f of fs.readdirSync(TMP).sort()) {
	const by = new Map();
	for (const l of fs.readFileSync(path.join(TMP, f), "utf8").split("\n")) {
		if (!l) continue;
		const [k, kind, pts] = l.split("\t");
		(by.get(k) ?? by.set(k, []).get(k)).push({ kind: +kind, pts: pts.split(",").map(Number) });
	}
	for (const [k, lines] of by) {
		const [cx, cy] = k.split("_").map(Number);
		if (BOX && (cx < Math.floor(BOX[0] / WALK_CELL) || cx > Math.floor(BOX[2] / WALK_CELL) || cy < Math.floor(BOX[1] / WALK_CELL) || cy > Math.floor(BOX[3] / WALK_CELL))) continue;
		const b = encodeWalk(lines, cx, cy); bytes += b.length;
		fs.writeFileSync(path.join(OUT, `${k}.bin`), b); cells.push(k);
	}
	process.stdout.write(`\r区画：${cells.length}・${(bytes / 1e6).toFixed(0)} MB`);
}
fs.rmSync(TMP, { recursive: true, force: true });
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ made: new Date().toISOString(), source: `OpenStreetMap（${path.basename(pbf)}・© OpenStreetMap contributors・ODbL）`, cell: WALK_CELL, cells, bytes }));
console.log(`\n→ bake-out/walk/  ${cells.length} 区画・${(bytes / 1e6).toFixed(1)} MB（index.json）＝uploader の「歩ける道の網（全国）」で GIS/walk/ へ`);
