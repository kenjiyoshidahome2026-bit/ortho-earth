#!/usr/bin/env node
// 新しい市町村のデジタルツインの器（頁の殻）を、型紙（既定＝apps/asahikawa＝区・地下鉄・PLATEAU の無い市）から起こす。
//   node packages/citytwin/scripts/new-city.mjs <id> <English name> <日本語の名> [--from=asahikawa] [--port=5231]
//   例：node packages/citytwin/scripts/new-city.mjs kawaba "Kawaba" 川場村
// 起こす物＝index.html・main.ts・vite.config.js・wrangler.toml・package.json・deploy-worker.js・env.d.ts・tsconfig.json・LICENSE・public/（アイコンは型紙の写し）・scripts/i18n-build.mjs・verify-i18n.mjs・i18n/pages.json。
// 起こさない物（市ごとに手で書く）＝data.ts（市の設定）・scripts/bake-<id>.mjs（焼きの設定）・i18n/pages/<id>.json（市の辞書）・tests/t-<id>.mjs・public/og.jpg（本番の絵を撮って差し替える）。
// 続き（登録・焼き・検定・配信）は docs/citytwin-guide.md の手順。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const pos = process.argv.slice(2).filter(a => !a.startsWith("--"));
const opt = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split("=")[1];
const [id, en, ja] = pos, from = opt("from") || "asahikawa", port = opt("port");
if (!/^[a-z][a-z0-9-]+$/.test(id || "") || !en || !ja) { console.error("使い方：new-city.mjs <id> <English name> <日本語の名> [--from=asahikawa] [--port=52xx]"); process.exit(1); }
const SRC = path.join(ROOT, "apps", from), DST = path.join(ROOT, "apps", id);
if (!fs.existsSync(SRC)) { console.error(`型紙が無い：apps/${from}`); process.exit(1); }
if (fs.existsSync(DST)) { console.error(`もう有る：apps/${id}`); process.exit(1); }
const FROM = { asahikawa: ["Asahikawa", "旭川市", "旭川"], sapporo: ["Sapporo", "札幌市", "札幌"], fukuoka: ["Fukuoka", "福岡市", "福岡"], kyoto: ["Kyoto", "京都市", "京都"] }[from];
if (!FROM) { console.error(`型紙の名を知らない：${from}`); process.exit(1); }
const jaShort = ja.replace(/[市町村]$/, "");
const swap = s => s.replaceAll(FROM[1], ja).replaceAll(FROM[2], jaShort).replaceAll(FROM[0], en).replaceAll(FROM[0].toUpperCase(), en.toUpperCase().replace(/\W/g, "_")).replaceAll(from, id);
const TEXT = ["index.html", "main.ts", "vite.config.js", "wrangler.toml", "package.json", "deploy-worker.js", "env.d.ts", "tsconfig.json", "LICENSE", "public/manifest.webmanifest", "public/favicon.svg", "scripts/i18n-build.mjs", "scripts/verify-i18n.mjs", "i18n/pages.json"];
const COPY = ["public/apple-touch-icon.png", "public/icon-192.png", "public/icon-512.png", "public/icon-maskable.png", "public/og.jpg"];
for (const f of TEXT) {
	let s = swap(fs.readFileSync(path.join(SRC, f), "utf8"));
	if (f === "vite.config.js" && port) s = s.replace(/port: \d+/, `port: ${port}`);
	fs.mkdirSync(path.dirname(path.join(DST, f)), { recursive: true }); fs.writeFileSync(path.join(DST, f), s);
}
for (const f of COPY) fs.copyFileSync(path.join(SRC, f), path.join(DST, f));
fs.symlinkSync(fs.readlinkSync(path.join(SRC, "public/sw.js")), path.join(DST, "public/sw.js"));
console.log(`✓ apps/${id}/ を起こした（型紙＝apps/${from}）。
次に書く物：
  apps/${id}/data.ts                 市の設定（CITY）
  apps/${id}/scripts/bake-${id}.mjs  焼きの設定（BAKE）
  apps/${id}/i18n/pages/${id}.json   市の辞書（26 言語）→ npm run i18n:build -w ${id}
  apps/${id}/tests/t-${id}.mjs       設定の検定
  apps/${id}/public/og.jpg           本番の絵（今は型紙の写し）
登録する所：scripts/deploy-engine.mjs の APPS・scripts/deps-map.mjs・scripts/test-all.mjs（test と i18n）・packages/citytwin/tests/t-core.mjs の ALL・npm install（package-lock）
手順の全体：docs/citytwin-guide.md`);
