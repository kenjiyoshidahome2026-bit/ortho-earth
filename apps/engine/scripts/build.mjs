#!/usr/bin/env node
// 共有エンジン（縮小計画 項目 9）を焼いて版を決める：vite.config.js → dist/site/globe/engine/<版>/・dist/site/globe/engine/current.json。
// 置き場＝そのまま本番の形（wrangler.toml の assets＝dist/site・route＝/globe/engine/*）＝エンジンは独立のデプロイ単位（2026-10-15・ortho-globe から切り出し）。
// <版>＝出力（.map を除く）の中身の sha256 の頭 10 桁＝中身が同じなら同じ版（焼き直しても URL は変わらない＝キャッシュが生きる）。
// 各アプリの build（scripts/lib/shared-engine.mjs）は current.json の版を読み、/globe/engine/<版>/ を指す。
//   npm run build -w ortho-engine
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(APP, "dist/site/globe/engine"), TMP = path.join(APP, "dist/_build");
execSync("npx vite build -c vite.config.js --logLevel warn", { cwd: APP, stdio: "inherit" });
execSync("npx vite build -c vite.ml.config.js --logLevel warn", { cwd: APP, stdio: "inherit" });   // maplibre.js＝互換の口だけ（本体は ./globe.js を実行時に読む＝本体の束を変えない）

import { DATA, ENTRIES, importsMap } from "../src/entries.mjs";
// 実行時データ（jp の台帳等）＝版の中身に入る（変われば版も変わる）。symlink は実体で写す（cpSync の dereference は
// 入れ子の symlink を辿らず絶対パスの link のまま写す＝本番に出すと切れる・2026-10-15 packages/jp/assets/koppen-clim.png で踏んだ）
const copyReal = (from, to) => {
	if (statSync(from).isDirectory()) { mkdirSync(to, { recursive: true }); for (const f of readdirSync(from)) copyReal(path.join(from, f), path.join(to, f)); }
	else copyFileSync(from, to);   // copyFileSync は symlink の先の中身を写す
};
for (const [from, to] of DATA) copyReal(from, path.join(TMP, to));

const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk(TMP).filter(f => !f.endsWith(".map")).map(f => path.relative(TMP, f)).sort();
const h = createHash("sha256");
for (const f of files) h.update(f).update("\0").update(readFileSync(path.join(TMP, f)));
const version = h.digest("hex").slice(0, 10);

mkdirSync(OUT, { recursive: true });
for (const d of readdirSync(OUT)) if (d !== "current.json") rmSync(path.join(OUT, d), { recursive: true, force: true });   // 手元は今の版だけ（旧版は本番が持つ）
renameSync(TMP, path.join(OUT, version));
writeFileSync(path.join(OUT, "current.json"), JSON.stringify({ version, entries: ["globe", "maplibre", ...ENTRIES.slice(1).map(e => e[1])], imports: importsMap(), files }, null, "\t") + "\n");
console.log(`engine ${version}（${files.length} files）→ dist/site/globe/engine/${version}/`);
