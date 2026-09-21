#!/usr/bin/env node
// 名所 3D 模型（GLB）をフォルダから bucket GIS/models/<id>.glb へ置く（/japan/models.html が読む）。
// GLB は npm run landmarks（PLATEAU 3D Tiles → glb）が out/ に作る。
//
//   npm run models -- --dir out/ --any          … フォルダの *.glb を名前のまま全部置く（台帳外も）
//   npm run models -- --dir <folder>            … 台帳（apps/ortho-japan/public/models.json）の id だけ <id>.glb を探して置く
//   npm run models -- --dir <folder> tokyo-tower …  … id を指定
//   --force                                     … bucket に既にあっても置き直す（既定は飛ばす）
//
// 鍵は apps/uploader/.env.local（git 管理外）の VITE_API_KEY＝bucket の書き込み鍵（uploader と同じ）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bucket } from "../../../packages/native-bucket/src/Bucket.js";   // Cache（IndexedDB）を持つ index.js は Node で読まない＝Bucket だけ（exports はルートだけ＝相対で）

const HERE = path.dirname(fileURLToPath(import.meta.url)), APP = path.join(HERE, "..");
const CATALOG = path.join(APP, "../ortho-japan/public/models.json");
const API_BASE = "https://api.ortho-earth.com";
const DIRE = "GIS/models";

// .env.local（KEY=value の行だけ）
const env = { ...process.env };
try { for (const line of fs.readFileSync(path.join(APP, ".env.local"), "utf8").split("\n")) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch { }
const API_KEY = env.VITE_API_KEY || "";

const args = process.argv.slice(2);
const force = args.includes("--force");
const dirIdx = args.indexOf("--dir"), dir = dirIdx >= 0 ? args[dirIdx + 1] : null;
const wantIds = args.filter((a, i) => !a.startsWith("--") && !(dirIdx >= 0 && i === dirIdx + 1));
const any = args.includes("--any");
if (!dir) { console.error("--dir <folder> を指定（GLB は npm run landmarks が out/ に作る）"); process.exit(1); }

const cat = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const models = any
	? fs.readdirSync(dir).filter(f => /\.glb$/i.test(f)).map(f => ({ id: f.replace(/\.glb$/i, "") }))   // --any＝フォルダの *.glb を名前のまま
	: (cat.models || []).filter(m => !wantIds.length || wantIds.includes(m.id));
if (!models.length) { console.error("no models matched", wantIds); process.exit(1); }
if (!API_KEY) { console.error("VITE_API_KEY が無い（apps/uploader/.env.local）＝bucket へ書けない"); process.exit(1); }

const bucket = await Bucket(DIRE, { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });   // 疎通不能なら null（native-bucket の仕様）
if (!bucket) { console.error(`Bucket(${DIRE}) に到達できない`); process.exit(1); }
const have = new Map((await bucket.list()).map(f => [f.Key, f]));
const MB = n => (n / 1048576).toFixed(1) + " MB";

let ok = 0, skipped = 0, failed = 0;
for (const m of models) {
	const name = `${m.id}.glb`;
	if (!force && have.has(name)) { console.log(`= ${name}  (already in bucket: ${MB(have.get(name).Size)})`); skipped++; continue; }
	const t0 = performance.now();
	try {
		const f = path.join(dir, name);
		if (!fs.existsSync(f)) { console.log(`- ${name}  (no such file in ${dir})`); skipped++; continue; }
		const blob = new Blob([fs.readFileSync(f)]);
		console.log(`↑ ${name}  local ${MB(blob.size)}`);
		const n = await bucket.put(new File([blob], name, { type: "model/gltf-binary" }));   // .glb は gzip で置かれる（読む側 models.js が gunzip）
		console.log(`✓ ${name}  ${MB(blob.size)} (sent ${MB(n)})  ${((performance.now() - t0) / 1000).toFixed(1)} s  → ${cat.base}${name}`);
		ok++;
	} catch (e) { console.error(`✖ ${name}  ${e.message || e}`); failed++; }
}
console.log(`\ndone: ${ok} uploaded, ${skipped} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
