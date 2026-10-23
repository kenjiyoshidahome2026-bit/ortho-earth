#!/usr/bin/env node
// favicon の正本を全アプリへ写す（2026-10-23・本人「すべてのページの favicon を japan の地球儀アイコンに揃えて」）。
// 正本＝assets/favicon.svg（球儀マーク・明暗で線の色が替わる）と assets/apple-touch-icon.png（iOS のホーム画面＝SVG 不可の 180px）。
// 写す先＝各アプリの public/ に在る favicon.svg・apple-touch-icon.png と docs/favicon.svg（頁は今のまま自分の棚の物を指す＝head は触らない）。
// 旧＝アプリ毎の写しを手で持っていた＝quiz（? の地球）・himekuri（暦）・yokohama（ビル）が独自の絵だった。
// 正本を直したら `node scripts/favicon-sync.mjs` で写し直す（検定 apps/www/tests/t-favicon-sync.mjs がずれを止める）。
// sokutei は外す＝www の一覧に載らない単独の PWA で、自前の絵（public/icon.svg → scripts/icons.mjs）がホーム画面のアイコン。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
export const SOURCES = { "favicon.svg": path.join(ROOT, "assets/favicon.svg"), "apple-touch-icon.png": path.join(ROOT, "assets/apple-touch-icon.png") };
const SKIP = new Set(["sokutei"]);

/** 写す先＝[写し, 正本] */
export const targets = () => {
	const apps = path.join(ROOT, "apps"), out = [];
	for (const app of fs.readdirSync(apps).sort()) {
		if (SKIP.has(app)) continue;
		for (const dir of [path.join(apps, app, "public"), ...(app === "docs" ? [path.join(apps, app)] : [])])
			for (const [name, src] of Object.entries(SOURCES)) {
				const f = path.join(dir, name);
				if (fs.existsSync(f)) out.push([f, src]);
			}
	}
	return out;
};

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
	let n = 0;
	for (const [f, src] of targets()) {
		const want = fs.readFileSync(src);
		if (!want.equals(fs.readFileSync(f))) { fs.writeFileSync(f, want); n++; }
	}
	console.log(`favicon-sync: ${n} file(s) updated`);
}
