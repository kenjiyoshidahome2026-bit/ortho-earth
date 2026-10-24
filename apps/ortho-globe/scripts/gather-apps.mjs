#!/usr/bin/env node
// /globe/ の頁のうち、独立のアプリ（apps/<名前>/）へ移った物を集める（2026-10-24〜・計画 /mnt/project-files/apps-flat/plan-2026-10-24.md）。
// 各アプリを build し、出力 apps/<名前>/dist/site/globe/ をこの家の dist/site/globe/ へ重ねる＝同じ Worker（/globe/*）が配る＝URL は変わらない。
// 同じ名前のファイルは中身が同じ時だけ許す（ハッシュ付きのチャンクが同じ中身で重なるのは無害）。違えば止める＝上書きで頁を壊さない。
//   node scripts/gather-apps.mjs            … build してから集める（npm run build の最後）
//   node scripts/gather-apps.mjs --no-build … build 済みの dist を集めるだけ
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const ROOT = path.resolve(HERE, "../..");
// 集める物＝apps/<置き場>/package.json に "servedAt": "/globe/" を持つアプリ（置き場＝ワークスペース名・一覧を手で持たない）
export const APPS = fs.readdirSync(path.join(ROOT, "apps")).filter(d => {
	try { return JSON.parse(fs.readFileSync(path.join(ROOT, "apps", d, "package.json"), "utf8")).servedAt === "/globe/"; } catch { return false; }
}).sort();
const DEST = path.join(HERE, "dist/site/globe");

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
if (!fs.existsSync(DEST)) throw new Error(`先に vite build（${path.relative(ROOT, DEST)} が無い）`);
for (const app of APPS) {
	if (!process.argv.includes("--no-build")) execFileSync("npm", ["run", "build", "-w", app], { cwd: ROOT, stdio: "inherit" });
	const src = path.join(ROOT, "apps", app, "dist/site/globe");
	let n = 0;
	for (const f of walk(src)) {
		const rel = path.relative(src, f), to = path.join(DEST, rel);
		if (fs.existsSync(to)) {
			if (Buffer.compare(fs.readFileSync(f), fs.readFileSync(to)) !== 0) throw new Error(`[gather] ${app}: ${rel} が既にあり中身が違う`);
			continue;
		}
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(f, to); n++;
	}
	console.log(`[gather] ${app}: ${n} files → ${path.relative(ROOT, DEST)}`);
}
