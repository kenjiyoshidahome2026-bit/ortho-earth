#!/usr/bin/env node
// エンジンの出荷物の門（wrangler deploy の直前・2026-10-15）：手元の dist/site/globe/engine/ が本番に出してよい形か。
//   ① current.json の版の置き場がある ② 入口（imports の全部＋maplibre.js・globe.css）がある ③ files の全部があり、symlink が無い
//   （symlink は wrangler が実体で上げない＝本番で切れる・2026-10-15 koppen-clim.png の轍）。
// 頁が実際に動くかは、ortho-globe の verify-prod（このエンジンで 9 頁を起こす）が repo 直下の npm run deploy:engine の先頭で見る。
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { ENGINE_DIR } from "@ortho-earth/globe/scripts/lib/shared-engine.mjs";

const fail = m => { console.error(`✗ engine: ${m}`); process.exit(1); };
const curFile = path.join(ENGINE_DIR, "current.json");
if (!existsSync(curFile)) fail("current.json が無い（先に npm run build -w ortho-engine）");
const cur = JSON.parse(readFileSync(curFile, "utf8"));
const dir = path.join(ENGINE_DIR, cur.version ?? "");
if (!cur.version || !existsSync(dir)) fail(`版 ${cur.version} の置き場が無い`);
const entries = [...Object.values(cur.imports ?? {}), "maplibre.js", "globe.css"];
const missing = [...entries, ...(cur.files ?? [])].filter(f => !existsSync(path.join(dir, f)));
if (missing.length) fail(`無いファイル：${missing.slice(0, 8).join("・")}`);
const links = (cur.files ?? []).filter(f => lstatSync(path.join(dir, f)).isSymbolicLink());
if (links.length) fail(`symlink のまま：${links.slice(0, 8).join("・")}`);
console.log(`ok:engine ${cur.version}（入口 ${entries.length}・${cur.files.length} files）`);
