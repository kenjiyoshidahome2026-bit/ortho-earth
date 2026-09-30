#!/usr/bin/env node
// 共有エンジン（縮小計画 項目 9）を焼いて版を決める：vite.engine.config.js → dist/engine/<版>/・dist/engine/current.json。
// <版>＝出力（.map を除く）の中身の sha256 の頭 10 桁＝中身が同じなら同じ版（焼き直しても URL は変わらない＝キャッシュが生きる）。
// 各アプリの build（scripts/lib/shared-engine.mjs）は current.json の版を読み、/globe/engine/<版>/ を指す。
//   npm run build:engine -w ortho-globe
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(APP, "dist/engine"), TMP = path.join(OUT, "_build");
execSync("npx vite build -c vite.engine.config.js --logLevel warn", { cwd: APP, stdio: "inherit" });

const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk(TMP).filter(f => !f.endsWith(".map")).map(f => path.relative(TMP, f)).sort();
const h = createHash("sha256");
for (const f of files) h.update(f).update("\0").update(readFileSync(path.join(TMP, f)));
const version = h.digest("hex").slice(0, 10);

for (const d of readdirSync(OUT)) if (d !== "_build" && d !== "current.json") rmSync(path.join(OUT, d), { recursive: true, force: true });   // 手元は今の版だけ（旧版は本番が持つ）
renameSync(TMP, path.join(OUT, version));
writeFileSync(path.join(OUT, "current.json"), JSON.stringify({ version, entries: ["globe", "maplibre", "i18n", "core", "geopbf"], files }, null, "\t") + "\n");
console.log(`engine ${version}（${files.length} files）→ dist/engine/${version}/`);
