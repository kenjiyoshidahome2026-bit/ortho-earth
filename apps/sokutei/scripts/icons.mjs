#!/usr/bin/env node
// public/icon.svg から PNG のアイコンを作る（manifest の 192/512 と iOS の apple-touch-icon 180）。sharp はルートの devDependencies（uploader 等が使う物）。
// 一度作って追跡する（ビルド毎には走らせない）。作り直し：`npm run icons -w sokutei`
import sharp from "sharp";
import path from "node:path";
const dir = path.resolve(import.meta.dirname, "../public");
const svg = path.join(dir, "icon.svg");
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
	await sharp(svg).resize(size, size).png().toFile(path.join(dir, name));
	console.log("✓", name);
}
