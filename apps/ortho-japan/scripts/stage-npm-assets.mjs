#!/usr/bin/env node
// npm 配布用の実行時アセット staging（prepack から呼ばれる）。zip の assets/ と同じホワイトリストを
// パッケージ直下 ./assets へ複写＝npm 利用者は node_modules/ortho-japan/assets を自サイトへ置き assetBase で指す。
// 正典リストは pack-sdk.mjs と同じ（ズレたら存在検査で fail）。./assets は gitignore（生成物）。
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WHITELIST = ["plateau-sets.json", "airports.json", "plateau-landmarks.json", "ai/citycodes.json", "llms.txt"];
const OUT = path.join(APP, "assets");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const f of WHITELIST) {
	const src = path.join(APP, "public", f);
	if (!existsSync(src)) { console.error(`✗ public/${f} が無い（WHITELIST と public/ がズレた）`); process.exit(1); }
	cpSync(src, path.join(OUT, f), { recursive: true });
}
console.log(`✓ npm assets staged（${WHITELIST.length}点 → assets/）`);
