#!/usr/bin/env node
// 星空・太陽系のデータ＝out/sky/（2026-10-15・旧＝uploader の「constellation lines・messier・space names・moon names」と「borders and stars」の stars.6
// ＝bucket GIS/pbf・GIS/space に焼いていた。読む側は 2026-10-13 に GitHub Pages へ移った＝bucket の物は誰も読まない）。
// 置くのは npm run publish:pages -w world-data -- --only=sky --write（git push だけ・鍵が要らない）。読む側＝packages/globe/src/sky/data.js・apps/solar。
//   stars.6・messier.geopbf          d3-celestial（ofrohn）の JSON を引いて焼く（.cache/sky に控える）
//   constellation_lines.geopbf      sky/constellation-lines.json（d3-celestial 由来の 89 星座の線）
//   moon_nomenclature.geopbf        sky/moon.json（IAU 採択の主な地名 2,023・英語）
//   names/<lang>.json               { updated, c: 星座, m: メシエ通称, b: 天体 }＝sky/names.json を言語ごとに（欠けは読む側が英語で補う）
//   moon_nomenclature.i18n/<lang>.json  { updated, names: { <GPN id>: 名前 } }（en は持たない＝GeoPBF の name が英語）
//   使い方: node scripts/sky.mjs [--out DIR]（既定 out/sky）
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GeoPBF } from "geopbf/pbf-base";
import { packs, moonPacks, moonGeoJSON, MOON_GEOPBF } from "../sky/packs.ts";
import names from "../sky/names.json" with { type: "json" };
import moon from "../sky/moon.json" with { type: "json" };
import lines from "../sky/constellation-lines.json" with { type: "json" };
globalThis.ImageData ??= class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--out"), OUT = path.resolve(ROOT, i > 0 ? process.argv[i + 1] : "out/sky");
const CACHE = path.join(ROOT, ".cache/sky"), OFROHN = "https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/";
const updated = new Date().toISOString().slice(0, 10);
const kb = n => `${(n / 1024).toFixed(0)} KB`;

async function celestial(name) {   // d3-celestial の JSON＝一度引いたら控えを使う（--fresh は .cache/sky を消す）
	await mkdir(CACHE, { recursive: true });
	const p = path.join(CACHE, name + ".json");
	if (!existsSync(p)) { const r = await fetch(OFROHN + name + ".json"); if (!r.ok) throw new Error(`fetch ${name}: HTTP ${r.status}`); await writeFile(p, Buffer.from(await r.arrayBuffer())); }
	return JSON.parse(await readFile(p, "utf8"));
}
async function pbf(name, fc, opts = {}) {
	const p = await new GeoPBF({ name, ...opts }).set({ type: "FeatureCollection", name, features: fc.features });
	if (!p.length) throw new Error(`${name}: 0 features`);
	const buf = gzipSync(Buffer.from(p.arrayBuffer), { level: 9 });
	await writeFile(path.join(OUT, name + ".geopbf"), buf);
	console.error(`${name}.geopbf: ${p.length} features・${kb(buf.length)} (gzip)`);
	return p;
}
async function json(rel, v) { const f = path.join(OUT, rel); await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, JSON.stringify(v)); }

await mkdir(OUT, { recursive: true });
await pbf("stars.6", await celestial("stars.6"));
await pbf("messier", await celestial("messier"));
await pbf("constellation_lines", { features: lines.features.map(f => ({ ...f, properties: { ...f.properties, name: f.id } })) });
const m = await pbf(MOON_GEOPBF, moonGeoJSON(moon), { precision: 4,   // 0.0001°＝月面で約 3 m
	attribution: "IAU / USGS Gazetteer of Planetary Nomenclature (public domain)",
	description: "Moon nomenclature (IAU-approved main features, no satellite craters): selenographic lon/lat (east +), id=GPN Feature ID, code=IAU descriptor, diameter km, origin" });
if (m.length !== moon.features.length) throw new Error(`${MOON_GEOPBF}: ${m.length} / ${moon.features.length} features`);
const P = packs(names);
for (const [lang, p] of Object.entries(P)) await json(`names/${lang}.json`, { updated, ...p });
const M = moonPacks(moon);
for (const [lang, n] of Object.entries(M)) await json(`${MOON_GEOPBF}.i18n/${lang}.json`, { updated, names: n });
console.error(`names/: ${Object.keys(P).length} 言語・${MOON_GEOPBF}.i18n/: ${Object.keys(M).length} 言語 → ${path.relative(ROOT, OUT)}/`);
