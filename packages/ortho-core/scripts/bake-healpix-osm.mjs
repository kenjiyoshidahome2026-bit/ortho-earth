#!/usr/bin/env node
// OpenStreetMap の生データ（PBF）を、HEALPix のベクタタイル（MVT の器・座標は面ごとの x, y＝docs/design/healpix.md §5）に焼く（2026-11-27・日本域の試し焼き）。
// 本人裁定（2026-11-27）「OSM の生データ＋日本域で行きましょう」。PBF の読み方は歩ける道の網（packages/citytwin/scripts/bake-walk-japan.mjs）と同じ＝GDAL の ogr2ogr で 1 度読む。
//
// 使い方（repo の根から・手元の Mac で＝brew install gdal）:
//   node packages/ortho-core/scripts/bake-healpix-osm.mjs                      # 日本の PBF（無ければ Geofabrik から約 2.3 GB）→ Norder 4..12
//   node packages/ortho-core/scripts/bake-healpix-osm.mjs --pbf=<file.osm.pbf>  # 手元の PBF（県・地方の PBF＝試し焼き）
//   node packages/ortho-core/scripts/bake-healpix-osm.mjs --box=139.5,35.5,140,35.9   # 範囲だけ
//   … --order=12 --min-order=4 --extent=4096 --out=bake-out/hpx/osm
//   … --lines=<a.geojsonl> --polys=<b.geojsonl>   # ogr2ogr の代わりに GeoJSONSeq を直に読む（検定用）
// 層（Protomaps の層名と kind に寄せる＝今の style が効きやすい）と、出し始める段（Norder k ≒ メルカトルの z k+2.6）:
//   roads     … 道（kind＝highway／major_road／minor_road／path・kind_detail＝highway の値）と鉄道（kind＝rail）
//   water     … 水面（多角形・kind＝water）と水路（線・kind＝river／canal／stream）
//   buildings … 建物（多角形・最も細かい段だけ＝既定 Norder 12。11 だと都心の 1 枚が約 710 KB・2 万 4 千棟＝重すぎた＝2026-11-27 の試し焼き）
// 海岸線（陸の多角形）は PBF からは出ない（osmcoastline の仕事）＝入れていない。地名・施設の点もまだ。
// 間引き：最も細かい段は丸めるだけ。粗い段は Douglas–Peucker（1.5 刻み）と小さい多角形の切り捨て。タイルの縁の点は動かさない。
// 出力：bake-out/hpx/osm/Norder{k}/Dir{d}/Npix{n}.mvt ＋ index.json { made, source, layers, minOrder, maxOrder, extent, tiles, bytes }。上げるのは uploader のボタン。
// 許諾：© OpenStreetMap contributors（ODbL）。
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hpxPath, cellOf, nestOf } from "../src/healpix.ts";
import { hpxSplitFaces, hpxSliceFace, hpxSimplify, encodeHpxVt } from "../src/healpixvt.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const opt = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const MAX = +opt("order", 12), MIN = +opt("min-order", 4), EXT = +opt("extent", 4096);
const OUT = path.resolve(ROOT, opt("out", "bake-out/hpx/osm")), TMP = OUT + "-tmp", OSM = path.join(ROOT, "bake-out/osm");
const BOX = opt("box")?.split(",").map(Number), LINES = opt("lines"), POLYS = opt("polys");
const GEOFABRIK = "https://download.geofabrik.de/asia/japan-latest.osm.pbf";
if (!(MAX >= MIN && MIN >= 0 && MAX <= 14)) { console.error("--order ≥ --min-order ≥ 0・--order ≤ 14"); process.exit(1); }

// ── 層分け：タグ → { layer, type, min（出し始める段）, props }。null＝採らない ──
const ROAD = { motorway: ["highway", 4], motorway_link: ["highway", 7], trunk: ["highway", 4], trunk_link: ["highway", 7], primary: ["major_road", 6], primary_link: ["major_road", 8], secondary: ["major_road", 7], secondary_link: ["major_road", 9],
	tertiary: ["major_road", 8], tertiary_link: ["major_road", 10], unclassified: ["minor_road", 10], residential: ["minor_road", 10], living_street: ["minor_road", 10], road: ["minor_road", 10], service: ["minor_road", 11], pedestrian: ["minor_road", 11], track: ["path", 11],
	path: ["path", 11], footway: ["path", 11], cycleway: ["path", 11], steps: ["path", 11], bridleway: ["path", 11] };
const RAIL = { rail: 6, subway: 9, light_rail: 9, monorail: 9, tram: 10, narrow_gauge: 9, funicular: 10 };
const WATERWAY = { river: 7, canal: 9, stream: 11, ditch: 11, drain: 11 };
function classifyLine(t) {
	if (t.highway && ROAD[t.highway]) { const [kind, min] = ROAD[t.highway], p = { kind, kind_detail: t.highway }; if (t.name) p.name = t.name; if (t.ref) p.ref = t.ref; if (t.tunnel && t.tunnel !== "no") p.is_tunnel = true; if (t.bridge && t.bridge !== "no") p.is_bridge = true; return { layer: "roads", min, props: p, nameFrom: 9 }; }
	if (t.railway && RAIL[t.railway] !== undefined) { const p = { kind: "rail", kind_detail: t.railway }; if (t.name) p.name = t.name; if (t.tunnel && t.tunnel !== "no") p.is_tunnel = true; return { layer: "roads", min: RAIL[t.railway], props: p, nameFrom: 10 }; }
	if (t.waterway && WATERWAY[t.waterway] !== undefined) { const p = { kind: t.waterway === "river" ? "river" : t.waterway === "canal" ? "canal" : "stream" }; if (t.name) p.name = t.name; return { layer: "water", min: WATERWAY[t.waterway], props: p, nameFrom: 9 }; }
	return null;
}
function classifyPoly(t) {
	if (t.natural === "water" || t.waterway === "riverbank" || t.landuse === "reservoir" || t.landuse === "basin") { const p = { kind: "water" }; if (t.water) p.kind_detail = t.water; if (t.name) p.name = t.name; return { layer: "water", min: 5, props: p, nameFrom: 9 }; }
	if (t.building && t.building !== "no") return { layer: "buildings", min: MAX, props: {}, nameFrom: 99 };
	return null;
}

// ── 仮の束：タイルの行（"order/npix \t 層 \t 種別 \t 属性 \t 座標"）を、祖先の束（細かい段は Norder 6 の祖先・粗い段は 1 つ）ごとのファイルへ。開いたままの口は持たない ──
fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });
const BUCKET = Math.min(6, MAX), buf = new Map(), CODE = { point: "n", line: "l", polygon: "a" }; let buffered = 0;
const flush = () => { for (const [k, a] of buf) fs.appendFileSync(path.join(TMP, k + ".tsv"), a.join("")); buf.clear(); buffered = 0; };
function put(t, layer, props) {
	const c = cellOf(t.order, t.npix), key = t.order < BUCKET ? "top" : `b${nestOf(BUCKET, c.face, c.ix >> (t.order - BUCKET), c.iy >> (t.order - BUCKET))}`;
	const line = `${t.order}/${t.npix}\t${layer}\t${CODE[t.type]}\t${JSON.stringify(props)}\t${t.parts.map(p => p.map(q => q[0] + " " + q[1]).join(" ")).join(";")}\n`;
	(buf.get(key) ?? buf.set(key, []).get(key)).push(line); buffered += line.length;
	if (buffered > 48e6) flush();
}
let pieces = 0;
function emit(geom, cls) {
	const faces = hpxSplitFaces(geom, 1 / (2 ** MAX * EXT * 4));
	for (let k = Math.max(MIN, cls.min); k <= MAX; k++) {
		let props = cls.props;
		if (k < cls.nameFrom && (props.name || props.ref)) { props = { ...props }; delete props.name; delete props.ref; }   // 粗い段は名前を持たない（大きさの節約）
		for (const f of faces) for (const t0 of hpxSliceFace(f, k, EXT)) {
			const t = k < MAX ? hpxSimplify(t0, 1.5, 8, EXT) : t0;
			if (t) { put(t, cls.layer, props); pieces++; }
		}
	}
}

const signed = r => { let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return a; };
const orient = (r, outer) => (signed(r) > 0) === outer ? r : [...r].reverse();
// ── 読む：ogr2ogr の GeoJSONSeq（か、検定用のファイル）──
const tags = hs => { const t = {}; for (const m of (hs || "").matchAll(/"((?:[^"\\]|\\.)*)"=>"((?:[^"\\]|\\.)*)"/g)) t[m[1]] = m[2]; return t; };
const t0 = Date.now(); let pbf = opt("pbf"), source = "OpenStreetMap";
async function* features(layer, file, want) {
	let input, ogr = null;
	if (file) input = fs.createReadStream(file);
	else {
		// GDAL の版で列が違う（railway が列か other_tags か）＝先に列を見て、在る列だけで条件と選択を組む
		const info = execFileSync("ogrinfo", ["-so", pbf, layer], { encoding: "utf8" }), cols = new Set([...info.matchAll(/^(\w+): \w+/gm)].map(m => m[1]));
		const has = want.filter(c => cols.has(c)), where = [...has.map(c => `${c} IS NOT NULL`), ...want.filter(c => !cols.has(c)).map(c => `other_tags LIKE '%"${c}"=>%'`)].join(" OR ");
		const args = ["-f", "GeoJSONSeq", "/vsistdout/", pbf, layer, "-where", where, "-select", ["osm_id", ...(cols.has("name") ? ["name"] : []), ...has, "other_tags"].join(","), "-lco", "COORDINATE_PRECISION=7"];
		if (BOX) args.push("-spat", ...BOX.map(String));
		ogr = spawn("ogr2ogr", args, { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, OGR_INTERLEAVED_READING: "YES", OSM_MAX_TMPFILE_SIZE: "4096" } });
		input = ogr.stdout;
	}
	for await (const s of readline.createInterface({ input, crlfDelay: Infinity })) {
		const i = s.indexOf("{"); if (i < 0) continue;
		const f = JSON.parse(s.slice(i)), p = f.properties || {}, t = { ...tags(p.other_tags) };
		for (const [k, v] of Object.entries(p)) if (v !== null && k !== "other_tags" && k !== "osm_id") t[k] = String(v);
		yield { t, g: f.geometry };
	}
	if (ogr) { const code = await new Promise(r => ogr.exitCode !== null ? r(ogr.exitCode) : ogr.on("close", r)); if (code) { console.error(`\nogr2ogr（${layer}）が ${code} で止まった`); process.exit(1); } }
}
if (!LINES && !POLYS) {
	if (!pbf) {
		pbf = path.join(OSM, "japan-latest.osm.pbf");
		if (!fs.existsSync(pbf)) { fs.mkdirSync(OSM, { recursive: true }); console.log(`PBF を取る：${GEOFABRIK}`); execFileSync("curl", ["-fL", "--retry", "5", "-o", pbf + ".part", GEOFABRIK], { stdio: "inherit" }); fs.renameSync(pbf + ".part", pbf); }
	}
	try { execFileSync("ogr2ogr", ["--version"], { stdio: "ignore" }); } catch { console.error("ogr2ogr が無い＝brew install gdal"); process.exit(1); }
	source = `OpenStreetMap（${path.basename(pbf)}）`;
}
console.log(`[hpx-osm] Norder ${MIN}..${MAX}・刻み ${EXT}${BOX ? `・範囲 ${BOX.join(",")}` : ""} → ${path.relative(ROOT, OUT)}`);
let seen = 0, used = 0;
const tick = what => { if (++seen % 100000 === 0) process.stdout.write(`\r${what}：${seen} 件を見た・採った ${used} 件・タイルの切れ ${pieces}・${((Date.now() - t0) / 1000).toFixed(0)} 秒`); };
if (LINES || pbf) for await (const { t, g } of features("lines", LINES, ["highway", "railway", "waterway"])) {
	tick("線");
	const cls = classifyLine(t); if (!cls || !g) continue;
	const coords = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : null; if (!coords) continue;
	used++; emit({ type: "line", coords }, cls);
}
if (POLYS || pbf) for await (const { t, g } of features("multipolygons", POLYS, ["building", "natural", "landuse", "waterway"])) {
	tick("面");
	const cls = classifyPoly(t); if (!cls || !g) continue;
	const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : null; if (!polys) continue;
	used++; emit({ type: "polygon", coords: polys.flatMap(rings => rings.map((r, i) => orient(r, i === 0))) }, cls);   // 外周＝反時計回り（正の面積）・穴＝時計回りにそろえる（y が上向きの約束）
}
flush();
console.log(`\n読み終わり：${seen} 件を見た・採った ${used} 件・タイルの切れ ${pieces}・${((Date.now() - t0) / 1000).toFixed(0)} 秒`);

// ── 束ごとにタイルへ詰める ──
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const LAYERS = ["water", "roads", "buildings"], TYPE = { n: "point", l: "line", a: "polygon" }, written = [], perBytes = {}, perMax = {}; let bytes = 0, big = 0;
for (const file of fs.readdirSync(TMP).sort()) {
	const by = new Map();
	for await (const l of readline.createInterface({ input: fs.createReadStream(path.join(TMP, file)), crlfDelay: Infinity })) {
		if (!l) continue;
		const [key, layer, ty, props, co] = l.split("\t");
		const parts = co.split(";").map(s => { const v = s.split(" ").map(Number), p = []; for (let i = 0; i < v.length; i += 2) p.push([v[i], v[i + 1]]); return p; });
		const tl = by.get(key) ?? by.set(key, new Map()).get(key);
		(tl.get(layer) ?? tl.set(layer, []).get(layer)).push({ type: TYPE[ty], parts, props: JSON.parse(props) });
	}
	for (const [key, tl] of by) {
		const [k, n] = key.split("/").map(Number), rel = hpxPath(k, n, "mvt"), out = path.join(OUT, rel);
		const b = encodeHpxVt(LAYERS.filter(L => tl.has(L)).map(L => ({ name: L, extent: EXT, features: tl.get(L) })));
		fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, b);
		written.push(rel); bytes += b.length; if (b.length > 500e3) big++; perBytes[k] = (perBytes[k] || 0) + b.length; perMax[k] = Math.max(perMax[k] || 0, b.length);
	}
	process.stdout.write(`\rタイル：${written.length} 枚・${(bytes / 1e6).toFixed(0)} MB`);
}
fs.rmSync(TMP, { recursive: true, force: true });
written.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ made: new Date().toISOString(), source: `${source}・© OpenStreetMap contributors・ODbL`, layers: LAYERS, minOrder: MIN, maxOrder: MAX, extent: EXT, tiles: written, bytes }) + "\n");
const perOrder = {}; for (const r of written) { const k = +/^Norder(\d+)/.exec(r)[1]; perOrder[k] = (perOrder[k] || 0) + 1; }
console.log(`\n[hpx-osm] ${written.length} 枚・${(bytes / 1e6).toFixed(1)} MB・500 KB を超えるタイル ${big} 枚・段ごと ${Object.entries(perOrder).map(([k, v]) => `N${k}:${v}`).join(" ")}・${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
console.log(`  段ごとの大きさ（枚・合計・1 枚の最大）：${Object.entries(perOrder).map(([k, v]) => `N${k} ${v} 枚 ${(perBytes[k] / 1e6).toFixed(1)} MB 最大 ${(perMax[k] / 1e3).toFixed(0)} KB`).join("／")}`);
