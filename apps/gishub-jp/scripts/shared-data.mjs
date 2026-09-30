#!/usr/bin/env node
// 重いデータ（shared-data/census・shared-data/zipcode）の R2 キーを決める道具（2026-09-30・縮小計画 項目6b）。
//   node scripts/shared-data.mjs            中身のハッシュから R2 のキーを決め、shared-data/manifest.json を書く（上げない）
// 上げるのは uploader の役目（R2 へ出す物は uploader を通す＝本人方針 2026-09-30）：npm run shared-data -w uploader
// キー＝GIS/shared/<dir>/<name>.<sha256 の頭 8 桁><拡張子>。中身が変われば別のキー＝アプリは manifest を見て新しい方を読む。
// 古いキーは消さない（前の版のアプリが読み続けられる）。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../shared-data");
const PREFIX = "GIS/shared";

const manifest = {};
for (const dir of ["census", "zipcode"]) for (const name of readdirSync(path.join(ROOT, dir)).sort()) {
	const ext = path.extname(name), buf = readFileSync(path.join(ROOT, dir, name));
	const hash = createHash("sha256").update(buf).digest("hex").slice(0, 8);
	manifest[`${dir}/${name}`] = `${PREFIX}/${dir}/${path.basename(name, ext)}.${hash}${ext}`;
}
writeFileSync(path.join(ROOT, "manifest.json"), JSON.stringify(manifest, null, "\t") + "\n");
console.log(manifest);

