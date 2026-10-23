#!/usr/bin/env node
// 静的な頁（vite を通らない www/public/maplibre の一覧と例）へ起動画面（#boot）の正本を写す（2026-10-23）。
// 正本＝packages/globe/src/boot/screen.ts。正本を直したら `node apps/www/scripts/boot-sync.mjs` で写し直す（検定 tests/t-boot-sync.mjs がずれを止める）。
// 例の一式を verify-examples.mjs --publish で焼き直した時は、そちらが同じ withBootStatic を通す＝ここを回さなくても揃う。
import fs from "node:fs";
import path from "node:path";
import { withBootStatic } from "../../../packages/globe/src/boot/screen.ts";

const ML = path.resolve(import.meta.dirname, "../public/maplibre");
/** 写す先＝[ファイル, 何を待って畳むか] */
export const targets = () => [
	[path.join(ML, "index.html"), "images"],
	...fs.readdirSync(path.join(ML, "examples")).filter(f => f.endsWith(".html")).sort().map(f => [path.join(ML, "examples", f), "map"]),
];

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
	let n = 0;
	for (const [f, until] of targets()) {
		const src = fs.readFileSync(f, "utf8"), out = withBootStatic(src, until);
		if (out !== src) { fs.writeFileSync(f, out); n++; }
	}
	console.log(`boot-sync: ${n} file(s) updated`);
}
