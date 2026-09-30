#!/usr/bin/env node
// 重いデータ（shared-data/census・shared-data/zipcode）を R2 へ上げる道具（2026-09-30・縮小計画 項目6b）。
//   node scripts/shared-data.mjs            中身のハッシュから R2 のキーを決め、shared-data/manifest.json を書く（上げない）
//   API_KEY=… node scripts/shared-data.mjs --upload   さらに R2 に無いキーだけ上げる（同じキー＝同じ中身＝上げ直さない）
// キー＝GIS/shared/<dir>/<name>.<sha256 の頭 8 桁><拡張子>。中身が変われば別のキー＝アプリは manifest を見て新しい方を読む。
// 古いキーは消さない（前の版のアプリが読み続けられる）。API_BASE で api の宛先を変えられる（wrangler dev なら http://localhost:8787）。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bucket } from "native-bucket";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../shared-data");
const API_BASE = process.env.API_BASE ?? "https://api.ortho-earth.com";
const PREFIX = "GIS/shared";
const MIME = { ".csv": "text/csv", ".json": "application/json" };

const manifest = {};
for (const dir of ["census", "zipcode"]) for (const name of readdirSync(path.join(ROOT, dir)).sort()) {
	const ext = path.extname(name), buf = readFileSync(path.join(ROOT, dir, name));
	const hash = createHash("sha256").update(buf).digest("hex").slice(0, 8);
	manifest[`${dir}/${name}`] = `${PREFIX}/${dir}/${path.basename(name, ext)}.${hash}${ext}`;
}
writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify(manifest, null, "\t") + "\n");
console.log(manifest);

if (process.argv.includes("--upload")) {
	if (!process.env.API_KEY) { console.error("API_KEY が要る（バケツへの書き込み鍵）"); process.exit(1); }
	for (const [name, key] of Object.entries(manifest)) {
		const dir = key.slice(0, key.lastIndexOf("/")), file = key.slice(key.lastIndexOf("/") + 1);
		const bucket = await Bucket(dir, { baseUrl: `${API_BASE}/bucket/`, apiKey: process.env.API_KEY, silent: true });
		if (await bucket.exist(file)) { console.log(`= ${key}（既にある）`); continue; }
		const body = readFileSync(path.join(ROOT, name));
		await bucket.put(new File([body], file, { type: MIME[path.extname(file)] || "application/octet-stream" }));
		console.log(`↑ ${key}（${(body.length / 1e6).toFixed(1)}MB）`);
	}
}
