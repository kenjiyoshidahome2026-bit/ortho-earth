#!/usr/bin/env node
// gishub-jp と census2020 が読む共有データ（apps/gishub-jp/shared-data）を bucket GIS/shared/… へ置く（2026-09-30・縮小計画 項目6b）。
// キーは shared-data/manifest.json（gishub-jp の scripts/shared-data.mjs が中身のハッシュから書く）に従う。
//   npm run shared-data            … bucket に無いキーだけ置く（同じキー＝同じ中身＝置き直さない）
//   API_BASE=http://localhost:8787 npm run shared-data   … wrangler dev の bucket へ
// 鍵は apps/uploader/.env.local（git 管理外）の VITE_API_KEY＝bucket の書き込み鍵（uploader と同じ）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bucket } from "../../../packages/native-bucket/src/Bucket.js";   // Cache（IndexedDB）を持つ index.js は Node で読まない＝Bucket だけ

const HERE = path.dirname(fileURLToPath(import.meta.url)), APP = path.join(HERE, "..");
const ROOT = path.join(APP, "../gishub-jp/shared-data");
const API_BASE = process.env.API_BASE ?? "https://api.ortho-earth.com";
const MIME = { ".csv": "text/csv", ".json": "application/json" };

// .env.local（KEY=value の行だけ）
const env = { ...process.env };
try { for (const line of fs.readFileSync(path.join(APP, ".env.local"), "utf8").split("\n")) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch { }
const API_KEY = env.VITE_API_KEY || "";
if (!API_KEY) { console.error("VITE_API_KEY が無い（apps/uploader/.env.local）＝bucket へ書けない"); process.exit(1); }

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
for (const [name, key] of Object.entries(manifest)) {
	const dir = key.slice(0, key.lastIndexOf("/")), file = key.slice(key.lastIndexOf("/") + 1);
	const bucket = await Bucket(dir, { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });
	if (!bucket) { console.error(`Bucket(${dir}) に到達できない`); process.exit(1); }
	if (await bucket.exist(file)) { console.log(`= ${key}（既にある）`); continue; }
	const body = fs.readFileSync(path.join(ROOT, name));
	await bucket.put(new File([body], file, { type: MIME[path.extname(file)] || "application/octet-stream" }));
	console.log(`↑ ${key}（${(body.length / 1e6).toFixed(1)}MB）`);
}
