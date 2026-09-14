#!/usr/bin/env node
// プレート境界と プレート面＝ out/plates.geopbf（PB2002・Bird 2003・自由利用・要引用）。Kenji 2026-09-15「プレート境界と火山も」
//   boundaries: 種別（OSR 海嶺 / OTF 海洋トランスフォーム / OCB 海洋収束 / CRB 大陸リフト / CTF 大陸トランスフォーム / CCB 大陸収束 / SUB 沈み込み）ごとの線
//   plates: 52 枚の面（code・name）。主要 16 枚は ne-physical.mjs が category plate として台帳にも載せる（Wikidata に結ぶ）
//   使い方: node scripts/plates.mjs [--out PATH(拡張子なし)] [--geojson]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GeoPBF } from "../../geopbf/src/pbf-base.js";
import { PLATE_NAMES, STEP_CLASSES, plates, steps, boundaryLines } from "./lib/pb2002.mjs";
globalThis.ImageData ??= class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2), opt = (n, d) => { const i = ARGS.indexOf("--" + n); return i < 0 ? d : (ARGS[i + 1] && !ARGS[i + 1].startsWith("--") ? ARGS[i + 1] : true); };
const OUT = path.resolve(ROOT, typeof opt("out") === "string" ? opt("out") : "out/plates");
const CACHE = path.join(ROOT, ".cache/pb2002"), BASE = "http://peterbird.name/oldFTP/PB2002/";
async function src(name) { await mkdir(CACHE, { recursive: true }); const p = path.join(CACHE, name); if (!existsSync(p)) { const r = await fetch(BASE + name); if (!r.ok) throw new Error(`fetch ${name}: ${r.status}`); await writeFile(p, Buffer.from(await r.arrayBuffer())); } return readFile(p, "latin1"); }
const P = plates(await src("PB2002_plates.dig.txt")), S = steps(await src("PB2002_steps.dat.txt")), L = boundaryLines(S);
const features = [];
for (const l of L) { const [left, right] = l.boundary.split("-"); features.push({ type: "Feature", properties: { kind: "boundary", boundary: l.boundary, left, right, class: l.cls, className: STEP_CLASSES[l.cls] || l.cls }, geometry: { type: "LineString", coordinates: l.coords } }); }
for (const [code, ring] of Object.entries(P)) features.push({ type: "Feature", properties: { kind: "plate", code, name: PLATE_NAMES[code] || code }, geometry: { type: "Polygon", coordinates: [ring] } });
const pbf = await new GeoPBF({ name: "plates", precision: 4, attribution: "PB2002 (Bird, P., 2003, An updated digital model of plate boundaries, Geochem. Geophys. Geosyst. 4(3), 1027)", description: "tectonic plate boundaries (kind=boundary: class OSR/OTF/OCB/CRB/CTF/CCB/SUB) and plate polygons (kind=plate: code/name)" }).set({ type: "FeatureCollection", name: "plates", features });
const buf = gzipSync(Buffer.from(pbf.arrayBuffer), { level: 9 });
await mkdir(path.dirname(OUT), { recursive: true }); await writeFile(OUT + ".geopbf", buf);
if (opt("geojson", false)) await writeFile(OUT + ".geojson", JSON.stringify({ type: "FeatureCollection", features }));
const byCls = {}; for (const l of L) byCls[l.cls] = (byCls[l.cls] || 0) + 1;
console.error(`${OUT}.geopbf: 境界 ${L.length} 本（${Object.entries(byCls).map(([k, n]) => `${k} ${n}`).join("・")}・ステップ ${S.length}）＋プレート ${Object.keys(P).length} 枚・${(buf.length / 1024).toFixed(0)} KB (gzip)`);
