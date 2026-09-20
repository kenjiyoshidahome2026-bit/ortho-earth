#!/usr/bin/env node
// 名所 3D 模型（GLB）を Sketchfab の Download API で取り、そのまま bucket GIS/models/<id>.glb へ置く（/japan/models.html の台帳 12 件を「とりあえず全部」）。
//
//   npm run models                     … 台帳（apps/ortho-japan/public/models.json）の全件。bucket に既にある id は飛ばす
//   npm run models -- --force          … あっても置き直す
//   npm run models -- kokura-castle …  … id を指定
//   npm run models -- --dir ~/Downloads/glb   … Sketchfab を使わず、そのフォルダの <id>.glb を置く（手で落とした物・間引いた物）
//   npm run models -- --dir <folder> --any     … フォルダの *.glb を名前のまま全部置く（台帳外も）
//
// 鍵は apps/uploader/.env.local（git 管理外）：
//   VITE_API_KEY=…        bucket の書き込み鍵（uploader と同じ）
//   SKETCHFAB_TOKEN=…     Sketchfab の API トークン（Settings → Password & API → API token）か OAuth のアクセストークン。
//                         Download API の正式は OAuth Bearer。API トークン（Authorization: Token …）でも通るので両方試す
// 出典は CC BY＝台帳の author/source を必ずページに出す（models.js が出している）。Sketchfab の URL は短命＝キャッシュしない。
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
const API_KEY = env.VITE_API_KEY || "", SF_TOKEN = env.SKETCHFAB_TOKEN || "";

const args = process.argv.slice(2);
const force = args.includes("--force");
const dirIdx = args.indexOf("--dir"), dir = dirIdx >= 0 ? args[dirIdx + 1] : null;
const wantIds = args.filter((a, i) => !a.startsWith("--") && !(dirIdx >= 0 && i === dirIdx + 1));
const any = dir && args.includes("--any");

const cat = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const models = any
	? fs.readdirSync(dir).filter(f => /\.glb$/i.test(f)).map(f => ({ id: f.replace(/\.glb$/i, "") }))   // --any＝フォルダの *.glb を名前のまま
	: (cat.models || []).filter(m => !wantIds.length || wantIds.includes(m.id));
if (!models.length) { console.error("no models matched", wantIds); process.exit(1); }
if (!API_KEY) { console.error("VITE_API_KEY が無い（apps/uploader/.env.local）＝bucket へ書けない"); process.exit(1); }
if (!dir && !SF_TOKEN) { console.error("SKETCHFAB_TOKEN が無い（apps/uploader/.env.local に 1 行）。Sketchfab → Settings → Password & API → API token。手で落とした GLB を置くなら --dir <folder>"); process.exit(1); }

const bucket = await Bucket(DIRE, { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });   // 疎通不能なら null（native-bucket の仕様）
if (!bucket) { console.error(`Bucket(${DIRE}) に到達できない`); process.exit(1); }
const have = new Map((await bucket.list()).map(f => [f.Key, f]));
const MB = n => (n / 1048576).toFixed(1) + " MB";
const uidOf = m => (String(m.source || "").match(/([0-9a-f]{32})\s*$/) || [])[1] || null;

// Sketchfab Download API：{ glb:{url,size,expires}, gltf:{…}, usdz:{…} }。認証は Bearer（OAuth）→ Token（API トークン）の順に試す
async function sketchfabGlb(uid) {
	let last = null;
	for (const scheme of ["Bearer", "Token"]) {
		const r = await fetch(`https://api.sketchfab.com/v3/models/${uid}/download`, { headers: { Authorization: `${scheme} ${SF_TOKEN}` } });
		if (r.ok) {
			const j = await r.json();
			if (j.glb?.url) return { url: j.glb.url, size: j.glb.size, fmt: "glb" };
			throw new Error(`Sketchfab returned no glb (formats: ${Object.keys(j).join(", ")})`);
		}
		last = `${r.status} ${await r.text().catch(() => "")}`.slice(0, 200);
		if (r.status !== 401 && r.status !== 403) break;
	}
	throw new Error(`Sketchfab download API: ${last}`);
}

let ok = 0, skipped = 0, failed = 0;
for (const m of models) {
	const name = `${m.id}.glb`;
	if (!force && have.has(name)) { console.log(`= ${name}  (already in bucket: ${MB(have.get(name).Size)})`); skipped++; continue; }
	const t0 = performance.now();
	try {
		let blob;
		if (dir) {
			const f = path.join(dir, name);
			if (!fs.existsSync(f)) { console.log(`- ${name}  (no such file in ${dir})`); skipped++; continue; }
			blob = new Blob([fs.readFileSync(f)]);
			console.log(`↑ ${name}  local ${MB(blob.size)}`);
		} else {
			const uid = uidOf(m); if (!uid) throw new Error("no Sketchfab uid in source");
			const d = await sketchfabGlb(uid);
			console.log(`↓ ${name}  Sketchfab glb ${d.size ? MB(d.size) : ""} …`);
			const r = await fetch(d.url); if (!r.ok) throw new Error(`download HTTP ${r.status}`);
			blob = await r.blob();
			console.log(`↑ ${name}  ${MB(blob.size)} → ${DIRE}/`);
		}
		const n = await bucket.put(new File([blob], name, { type: "model/gltf-binary" }));   // .glb は gzip で置かれる（読む側 models.js が gunzip）
		console.log(`✓ ${name}  ${MB(blob.size)} (sent ${MB(n)})  ${((performance.now() - t0) / 1000).toFixed(1)} s  → ${cat.base}${name}`);
		ok++;
	} catch (e) { console.error(`✖ ${name}  ${e.message || e}`); failed++; }
}
console.log(`\ndone: ${ok} uploaded, ${skipped} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
