#!/usr/bin/env node
// 世界の地名検索の索引（#175）を焼く CLI＝out/search/base.json ＋ out/search/<lang>.json（25 言語）。
// 焼きの本体は build/search.js（ブラウザ＝apps/uploader の「国別DB (world)」節と共用）＝ここは材料の取得とファイル書き出しだけ。
// 材料：
//   NE（admin_1・populated_places・admin_0_countries）＝.cache/ne（無ければ取得・ne-cultural と同じ版固定）
//   NationDB・CityDB・TerrainDB・i18n/<lang>.json＝out/（npm run build の結果）に在ればそれ・無ければ bucket GIS/world/（本番の配信物）
// 使い方: node scripts/search-index.mjs [--out DIR] [--fixture DIR --names Paris,Tokyo,… --langs ja,zh]
//   --fixture＝検定の試料（名前が一致する物と全ての国だけの部分集合）を DIR に書く（packages/globe/tests/fixtures/worldsearch）
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSeed } from "../build/seed.js";
import { buildNeCultural, NE_TAG, neURL } from "../build/ne-cultural.js";
import { buildSearchIndex } from "../build/search.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".cache/ne");
const BUCKET = "https://api.ortho-earth.com/bucket/GIS/world/";
const ARGS = process.argv.slice(2);
const opt = (name, dflt) => { const i = ARGS.indexOf("--" + name); return i < 0 ? dflt : (ARGS[i + 1] && !ARGS[i + 1].startsWith("--") ? ARGS[i + 1] : true); };
const OUT = path.resolve(ROOT, typeof opt("out") === "string" ? opt("out") : "out/search");
const log = (...a) => console.log(...a);

async function ne(name) {
	await mkdir(CACHE, { recursive: true });
	const p = path.join(CACHE, `${name}.${NE_TAG}.geojson`);
	if (!existsSync(p)) {
		log(`fetch ${name}`);
		const r = await fetch(neURL(name));
		if (!r.ok) throw new Error(`fetch failed ${name}: ${r.status}`);
		await writeFile(p, Buffer.from(await r.arrayBuffer()));
	}
	return JSON.parse(await readFile(p, "utf8")).features;
}
// out/ に在れば手元の build・無ければ本番の bucket（gzip で置かれていることがある）
async function worldJSON(name) {
	const p = path.join(ROOT, "out", name);
	if (existsSync(p)) return JSON.parse(await readFile(p, "utf8"));
	const r = await fetch(BUCKET + name);
	if (!r.ok) throw new Error(`fetch failed ${name}: ${r.status}`);
	const b = Buffer.from(await r.arrayBuffer());
	return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString("utf8"));
}
const itemsOf = v => v?.items ?? v;

const seed = await loadSeed(name => readFile(path.join(ROOT, name.startsWith("../") ? name.replace("../", "") : "seed/" + name), "utf8"));
const langs = seed.langs;
log("NE admin_1・populated_places を key に割り当て…");
const { all } = await buildNeCultural(seed, { ne, log: () => {}, warn: console.warn }, { layers: ["admin_1", "populated_places"] });
const [nations, cities, terrains, admin0] = await Promise.all([worldJSON("NationDB.json"), worldJSON("CityDB.json"), worldJSON("TerrainDB.json"), ne("ne_10m_admin_0_countries")]);
const i18n = Object.fromEntries(await Promise.all(langs.filter(l => l !== "en").map(async l => [l, await worldJSON(`i18n/${l}.json`)])));
const fx = opt("fixture");
const want = new Set(String(opt("names", "")).split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
const idx = buildSearchIndex({
	features: all, nations: itemsOf(nations), cities: itemsOf(cities), terrains: itemsOf(terrains), i18n, categories: seed.ui.categories, admin0, langs,
	source: `Natural Earth 10m ${NE_TAG} (public domain) + ortho-earth World DB (CC BY-SA 4.0)`,
	keep: typeof fx === "string" ? (i, en, kind) => kind === "country" || want.has(String(en).toLowerCase()) : null,   // 試料＝全ての国＋名前が一致する物
});
log(JSON.stringify(idx.report));

async function write(dir, { base, tables }) {
	await mkdir(dir, { recursive: true });
	const sizes = {};
	const put = async (name, obj) => { const s = JSON.stringify(obj); await writeFile(path.join(dir, name), s); sizes[name] = [s.length, gzipSync(s, { level: 9 }).length]; };
	await put("base.json", base);
	for (const [l, t] of Object.entries(tables)) await put(`${l}.json`, t);
	return sizes;
}
if (typeof fx === "string") {
	const ls = String(opt("langs", "ja,zh")).split(",");
	const sizes = await write(path.resolve(fx), { base: idx.base, tables: Object.fromEntries(ls.map(l => [l, idx.tables[l]])) });
	log(`fixture ${fx}: ${idx.base.n} 件`, sizes);
} else {
	const sizes = await write(OUT, idx);
	const kb = n => (n / 1024).toFixed(0) + "KB";
	const langsRaw = Object.entries(sizes).filter(([k]) => k !== "base.json");
	log(`${OUT}: ${idx.base.n} 件`);
	log(`  base.json ${kb(sizes["base.json"][0])}（gzip ${kb(sizes["base.json"][1])}）`);
	log(`  <lang>.json ${langsRaw.length} 本・gzip ${kb(Math.min(...langsRaw.map(x => x[1][1])))}〜${kb(Math.max(...langsRaw.map(x => x[1][1])))}`);
	log("  " + langsRaw.map(([k, v]) => `${k.replace(".json", "")}:${kb(v[1])}`).join(" "));
}
