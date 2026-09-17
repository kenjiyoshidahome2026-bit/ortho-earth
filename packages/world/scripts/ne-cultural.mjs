#!/usr/bin/env node
// Natural Earth Cultural（10m・版固定）を world の key ごとに切り分けて out/ne-cultural.geopbf に書く CLI。
// 切り分けの本体は build/ne-cultural.js（ブラウザ＝apps/uploader の「国別DB (world)」節と共用）＝ここは
// 取得キャッシュ（.cache/ne）・gzip・ファイル書き出しだけ。
// 使い方: node scripts/ne-cultural.mjs [--out PATH(拡張子なし)] [--split] [--geojson] [--only JP,FR] [--layers railroads,roads] [--precision 6]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSeed } from "../build/seed.js";
import { buildNeCultural, NE_TAG, NE_LAYERS, neURL, SINGLE_DESC } from "../build/ne-cultural.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".cache/ne");
const ARGS = process.argv.slice(2);
const opt = (name, dflt) => { const i = ARGS.indexOf("--" + name); return i < 0 ? dflt : (ARGS[i + 1] && !ARGS[i + 1].startsWith("--") ? ARGS[i + 1] : true); };
const OUT = path.resolve(ROOT, typeof opt("out") === "string" ? opt("out") : "out/ne-cultural");
const WANT_GEOJSON = !!opt("geojson", false);
const log = (...a) => console.log(...a);

// Natural Earth の取得（.cache/ne に版固定で置く・terrains-from-ne と同じ流儀）
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

const seed = await loadSeed(name => readFile(path.join(ROOT, name.startsWith("../") ? name.replace("../", "") : "seed/" + name), "utf8"));
const layers = typeof opt("layers") === "string" ? opt("layers").split(",") : NE_LAYERS;
const only = typeof opt("only") === "string" ? opt("only").split(",") : null;
const { all, out, routes, index, encode, countVerts } = await buildNeCultural(seed, { ne, log, warn: console.warn }, { precision: +opt("precision", 6), layers, only });

// ── 書き出し ──────────────────────────────────────────────────────────────────────────────────────
// 既定＝方式A: 全部を平らに 1 層へ（属性 key / layer・混在ジオメトリ）＝ out/ne-cultural.geopbf ＋ out/ne-cultural.json（要約）。
// 国別ファイル（out/ne-cultural/<key>/<layer>.geopbf）は内容が等価なので既定では書かず、--split の時だけ（Kenji 2026-09-15）。
const gz = async (name, features, description) => gzipSync(Buffer.from(await encode(name, features, description)), { level: 9 });
await mkdir(path.dirname(OUT), { recursive: true });
const buf = await gz("ne-cultural", all, SINGLE_DESC);
await writeFile(OUT + ".geopbf", buf);
if (WANT_GEOJSON) await writeFile(OUT + ".geojson", JSON.stringify({ type: "FeatureCollection", name: "ne-cultural", features: all }));
index.single = { file: path.basename(OUT) + ".geopbf", features: all.length, vertices: countVerts(all), bytes: buf.length };
await writeFile(OUT + ".json", JSON.stringify(index, null, 1));
log(`${OUT}.geopbf: ${Object.keys(index.keys).length} key・${all.length} 地物・${(buf.length / 1e6).toFixed(1)} MB (gzip)`);

if (opt("split", false)) {   // 国別ファイル（等価な内容の分割形）
	let files = 0, bytes = 0;
	for (const key of [...out.keys()].sort()) {
		const dir = path.join(OUT, key); await mkdir(dir, { recursive: true });
		for (const [layer, features] of Object.entries(out.get(key))) {
			const b = await gz(layer, features, `${key} ${index.keys[key].name} — ne_10m_${layer}`);
			await writeFile(path.join(dir, `${layer}.geopbf`), b); files++; bytes += b.length;
			if (WANT_GEOJSON) await writeFile(path.join(dir, `${layer}.geojson`), JSON.stringify({ type: "FeatureCollection", name: layer, features }));
		}
	}
	for (const [layer, features] of Object.entries(routes)) {
		if (!features.length) continue;
		await mkdir(path.join(OUT, "routes"), { recursive: true });
		const b = await gz(layer, features, `routes (ferries and sea fragments) — ne_10m_${layer}`);
		await writeFile(path.join(OUT, "routes", `${layer}.geopbf`), b); files++; bytes += b.length;
	}
	log(`--split: ${OUT}/ に ${files} ファイル・${(bytes / 1e6).toFixed(1)} MB (gzip)`);
}
