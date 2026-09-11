#!/usr/bin/env node
// node build/cli.js [--fresh] [--out DIR]   … seed/ から全 DB を組み立てて out/ に書く（Node 22+）。--fresh でキャッシュを捨てる
import fs from "node:fs/promises";
import path from "node:path";
import { nodeEnv } from "./env.js";
import { loadSeed } from "./seed.js";
import { buildAll } from "./index.js";

const args = process.argv.slice(2), root = path.resolve(import.meta.dirname, "..");
const outDir = args.includes("--out") ? path.resolve(args[args.indexOf("--out") + 1]) : path.join(root, "out");
const env = await nodeEnv({ fresh: args.includes("--fresh") });
const seed = await loadSeed(n => fs.readFile(path.join(root, "seed", n), "utf8"));
const t0 = Date.now();
const r = await buildAll(seed, env);
await fs.mkdir(path.join(outDir, "i18n"), { recursive: true });
const today = new Date().toISOString().slice(0, 10);
for (const n of ["NationDB", "CityDB", "TerrainDB", "LanguageDB", "CurrencyDB", "Conflicts"])
	await fs.writeFile(path.join(outDir, n + ".json"), JSON.stringify({ updated: today, count: r[n].length, items: r[n] }));
for (const [lang, v] of Object.entries(r.i18n)) await fs.writeFile(path.join(outDir, "i18n", lang + ".json"), JSON.stringify(v));
r.rivers && await fs.writeFile(path.join(outDir, "rivers.geojson"), JSON.stringify(r.rivers));
console.log(`\n出力: ${outDir}  国 ${r.NationDB.length} 都市 ${r.CityDB.length} 地形 ${r.TerrainDB.length}（川の形状 ${r.rivers ? r.rivers.features.length : 0}）言語 ${r.LanguageDB.length} 通貨 ${r.CurrencyDB.length} 係争 ${r.Conflicts.length} i18n ${Object.keys(r.i18n).length} 言語（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
console.log(`検札: errors ${r.report.errors.length} / warns ${r.report.warns.length}`);
process.exit(r.report.errors.length ? 1 : 0);
