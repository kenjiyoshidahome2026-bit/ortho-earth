#!/usr/bin/env node
// 地形の頁（/globe/physical）が読むファイルを bucket GIS/world/ へ置く（Node から・uploader の Bucket.put と同じ手順）。
//   置く物＝out/ の TerrainDB.json・ne-physical.json・ne-physical.geopbf・plates.geopbf・ne-physical-lines.geopbf・climate-koppen.geopbf（6 本）
//           ＋ i18n/<lang>.json（25 本＝地形名 terrains が入った版）。NationDB など他の DB は触らない（本人裁定 2026-10-01）＝棚ごと揃えるなら uploader の「全部作る」
//   使い方: node scripts/publish-physical.mjs            … 予行（何も書かない＝置く物と今の bucket の有無を出す）
//           node scripts/publish-physical.mjs --write    … 実際に置く（上書きする i18n は先に .cache/bucket-backup/ へ退避）
//   鍵: 環境変数 API_KEY → 無ければ apps/uploader/.env.local の VITE_API_KEY（鍵は機械ごとに違うことがある＝401 ならその機械の鍵を確かめる）
//   先に作る物: npm run build → npm run plates → npm run ne:physical → npm run koppen（koppen は .cache/koppen/ に figshare 21789074 の tif が要る）
// JSON は gzip して X-Content-Encoding: gzip・.geopbf は gzip のまま素通し（Content-Encoding なし＝読む側が解く）。
import fs from "node:fs"; import path from "node:path"; import { gzipSync, gunzipSync } from "node:zlib"; import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), OUT = path.join(ROOT, "out");
const WRITE = process.argv.includes("--write");
const BASE = "https://api.ortho-earth.com/bucket/GIS/world/";
const envFile = path.join(ROOT, "../../apps/uploader/.env.local");
const key = process.env.API_KEY || (fs.existsSync(envFile) ? (fs.readFileSync(envFile, "utf8").match(/^VITE_API_KEY=(.+)$/m) || [])[1]?.trim() : "");
const NEW = ["TerrainDB.json", "ne-physical.json", "ne-physical.geopbf", "plates.geopbf", "ne-physical-lines.geopbf", "climate-koppen.geopbf"];
const missing = NEW.filter(f => !fs.existsSync(path.join(OUT, f)));
if (missing.length || !fs.existsSync(path.join(OUT, "i18n"))) { console.error(`out/ に無い: ${missing.join(", ") || "i18n/"}＝先に build・plates・ne:physical・koppen を回す`); process.exit(1); }
const I18N = fs.readdirSync(path.join(OUT, "i18n")).filter(f => f.endsWith(".json")).map(f => "i18n/" + f);
const readJson = b => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString("utf8"));
const counts = j => ["nations", "cities", "languages", "currencies", "conflicts", "terrains"].map(k => Object.keys(j[k] || {}).length).join("/");

// 検札（置く前）：地形の件数と物理量・名前表の顔ぶれ（国が欠けていないか＝world・equal が同じ表を読む）
const T = readJson(fs.readFileSync(path.join(OUT, "TerrainDB.json"))), items = T.items || T;
if (items.length < 900 || !items.some(d => d.discharge > 0)) { console.error(`TerrainDB が古い（${items.length} 件・物理量なし）＝npm run build を回す`); process.exit(1); }
console.log(`TerrainDB ${items.length} 件（${T.updated ?? "?"}）・置く物 ${NEW.length + I18N.length} 本・${WRITE ? "書き込む" : "予行（--write で実際に置く）"}`);
let bad = 0;
for (const name of [...NEW, ...I18N]) {
	const local = fs.readFileSync(path.join(OUT, name)), isJson = name.endsWith(".json");
	const cur = await fetch(BASE + name).then(async r => r.ok ? Buffer.from(await r.arrayBuffer()) : null).catch(() => null);
	let note = cur ? `上書き（今 ${(cur.length / 1024).toFixed(0)} KB）` : "新規";
	if (cur && name.startsWith("i18n/")) {
		const o = readJson(cur), n = readJson(local), drop = Object.keys(o.nations || {}).filter(k => !(n.nations || {})[k]).length;
		note += `・国/都市/言語/通貨/係争/地形 ${counts(o)} → ${counts(n)}`;
		if (drop) { note += `・⚠国が ${drop} 件欠ける`; bad++; }
		if (WRITE) { const b = path.join(ROOT, ".cache/bucket-backup", name); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.writeFileSync(b, cur); }
	}
	if (!isJson && !(local[0] === 0x1f && local[1] === 0x8b)) { console.log(`✗ ${name}: gzip でない`); bad++; continue; }
	if (!WRITE || bad) { console.log(`  ${name}  ${(local.length / 1024).toFixed(0)} KB  ${note}`); continue; }
	if (!key) { console.error("鍵が無い（API_KEY か apps/uploader/.env.local の VITE_API_KEY）"); process.exit(1); }
	const headers = { "X-Action": "put", "X-API-Key": key, "X-Metadata-Type": isJson ? "application/json" : "application/x-geopbf" };
	let body = local; if (isJson) { body = gzipSync(local, { level: 9 }); headers["X-Content-Encoding"] = "gzip"; }
	const r = await fetch(BASE + name, { method: "POST", headers, body });
	if (!r.ok) { console.log(`✗ ${name}  HTTP ${r.status} ${(await r.text()).slice(0, 120)}${r.status === 401 ? "＝鍵が違う（この機械の鍵を確かめる）" : ""}`); bad++; if (r.status === 401) break; continue; }
	console.log(`✓ ${name}  ${(body.length / 1024).toFixed(0)} KB  ${note}`);
}
if (bad) { console.error(`✗ ${bad} 件の問題＝${WRITE ? "途中で止めた／置けなかった物がある" : "このままでは置かない"}`); process.exit(1); }
console.log(WRITE ? "✓ 置いた＝次は apps/ortho-globe で npm run deploy（verify:prod の physical が通る）" : "✓ 予行 OK");
