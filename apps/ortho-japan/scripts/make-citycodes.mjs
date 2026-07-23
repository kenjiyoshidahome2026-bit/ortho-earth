#!/usr/bin/env node
// AIガジェットの地名→市区町村コード辞書を生成する（e-Stat 配信単位＝gishub-jp の estat/manifest.json が正本）。
// 使い方: apps/ortho-japan で `node scripts/make-citycodes.mjs` → public/ai/citycodes.json（[code, name] の配列）。
// e-Stat 側のマニフェスト更新（調査年切替等）時に再実行する。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(APP, "../gishub-jp/estat/manifest.json");
const OUT = path.join(APP, "public/ai/citycodes.json");

const manifest = JSON.parse(await readFile(SRC, "utf8"));
const pairs = manifest.map(m => [m.code, m.name]);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(pairs));
console.log(`${pairs.length} 市区町村 → ${path.relative(APP, OUT)} (${JSON.stringify(pairs).length} bytes)`);
