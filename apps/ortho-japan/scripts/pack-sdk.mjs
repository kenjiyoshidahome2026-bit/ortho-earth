#!/usr/bin/env node
// SDK 配布物の束ね：dist/lib（ライブラリビルド）＋実行時アセット＋README/LICENSE を一つの zip へ。
// 「利用者が public/ から手でコピーする」形を卒業し、これ一つ渡せば埋め込みが完結する出荷形にする。
//
//   使い方: apps/ortho-japan で `npm run pack:sdk` → dist/sdk/ortho-japan-sdk-<version>.zip
//
//   同梱するもの：
//     lib/      … dist/lib 一式（ortho-japan.js / .css / worker・動的importチャンク）。**sourcemapは除外**
//                  ＝利用者の実行には無関係（DevToolsを開いた時しか読まれない）・展開13MB→4.5MBの軽量化。
//                  .js末尾の sourceMappingURL 行も剥がす（無いファイルを指すポインタを残さない）
//     assets/   … 実行時に assetBase から fetch される全ファイル（下の WHITELIST＝実測で約150KB）。
//                  利用者はこのフォルダをサイトの任意の場所へ置き、orthoJapan({ assetBase: "…" }) で指す
//     example/  … 動くサンプル（sdk/example.html）。unzip→HTTP配信→/example/ で即・地球が回る
//     README.md / LICENSE
//
//   同梱しないもの（混入したら fail）：
//     sw.js       … SDK がホストのオリジンへ Service Worker を持ち込む口になる（vite.lib.config.js の掟）
//     moj-local/  … 開発専用（123MB）
//     plateau-names.json … 台帳＝plateau-landmarks.json を焼く原料であり実行時には読まれない（2.8MB）
//     ogp.png / favicon / apple-touch-icon … サイトの顔＝SDK の顔ではない
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(path.join(APP, "package.json"), "utf8"));

// 実行時アセットの正典（app.js / gadgets の ASSET_BASE fetch 全数調査 2026-08-19）。
// 追加・削除があればここを更新する＝pack が存在検査で fail して教えてくれる。
const WHITELIST = ["plateau-sets.json", "airports.json", "plateau-landmarks.json", "ai/citycodes.json"];
const FORBIDDEN = ["lib/sw.js", "assets/sw.js", "assets/moj-local", "assets/plateau-names.json"];

console.log("… build:lib");
execFileSync("npx", ["vite", "build", "--config", "vite.lib.config.js", "--logLevel", "warn"], { cwd: APP, stdio: "inherit" });

const NAME = `ortho-japan-sdk-${version}`;
const OUT = path.join(APP, "dist/sdk", NAME);
rmSync(path.join(APP, "dist/sdk"), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// lib/ を写す：.map は置いていく・.js は末尾の sourceMappingURL 行を剥がす（デバッグしたい人は build:lib の dist/lib へ）
cpSync(path.join(APP, "dist/lib"), path.join(OUT, "lib"), { recursive: true, filter: src => !src.endsWith(".map") });
const stripMapRef = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) {
	const p = path.join(dir, e.name);
	if (e.isDirectory()) stripMapRef(p);
	else if (e.name.endsWith(".js")) writeFileSync(p, readFileSync(p, "utf8").replace(/^\/\/# sourceMappingURL=.*\n?/gm, ""));
} };
stripMapRef(path.join(OUT, "lib"));
cpSync(path.join(APP, "sdk/example.html"), path.join(OUT, "example/index.html"));
for (const f of WHITELIST) {
	const src = path.join(APP, "public", f);
	if (!existsSync(src)) { console.error(`✗ 実行時アセットが無い: public/${f}（WHITELIST と public/ がズレた）`); process.exit(1); }
	cpSync(src, path.join(OUT, "assets", f), { recursive: true });
}
cpSync(path.join(APP, "README.md"), path.join(OUT, "README.md"));
cpSync(path.join(APP, "LICENSE"), path.join(OUT, "LICENSE"));

for (const f of FORBIDDEN) if (existsSync(path.join(OUT, f))) { console.error(`✗ 混入禁止物が入っている: ${f}`); process.exit(1); }
if (!existsSync(path.join(OUT, "lib/ortho-japan.js")) || !existsSync(path.join(OUT, "lib/ortho-japan.css"))) {
	console.error("✗ lib 本体が欠けている"); process.exit(1);
}

const zip = `${NAME}.zip`;
execFileSync("zip", ["-qr", zip, NAME], { cwd: path.join(APP, "dist/sdk") });

// 中身の見取り図（silent cap を作らない＝何を配ったか毎回目に見せる）
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
	e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const files = walk(OUT);
const total = files.reduce((s, f) => s + statSync(f).size, 0);
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + "MB" : Math.ceil(n / 1e3) + "KB";
for (const f of files.sort()) console.log(`  ${fmt(statSync(f).size).padStart(7)}  ${path.relative(OUT, f)}`);
console.log(`✓ ${path.relative(APP, path.join(APP, "dist/sdk", zip))}（展開時 ${fmt(total)}・${files.length}ファイル）`);
