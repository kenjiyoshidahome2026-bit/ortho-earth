#!/usr/bin/env node
// 配信口（apps/ortho-globe＝/globe/・apps/ortho-japan＝/japan/）の下に並ぶ独立のアプリ（apps/<名前>/）を集める（2026-10-24〜・計画 /mnt/project-files/apps-flat/plan-2026-10-24.md）。
// 各アプリを build し、出力 apps/<名前>/dist/site/<頭>/ を配信口の dist/site/<頭>/ へ重ねる＝同じ Worker が配る＝URL は変わらない。
// 同じ名前のファイルは中身が同じ時だけ許す（ハッシュ付きのチャンクが同じ中身で重なるのは無害）。違えば止める＝上書きで頁を壊さない。
// 配信口の cwd で走らせる（npm run build の最後）：
//   node ../../packages/globe/scripts/lib/gather-apps.mjs /globe/            … build してから集める
//   node ../../packages/globe/scripts/lib/gather-apps.mjs /globe/ --no-build … build 済みの dist を集めるだけ
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
const AT = process.argv.slice(2).find(a => /^\/[\w-]+\/$/.test(a));
if (!AT) throw new Error("使い方：gather-apps.mjs /globe/ [--no-build]（配信口の URL の頭）");
// 集める物＝apps/<置き場>/package.json に "servedAt": AT を持つアプリ（置き場＝ワークスペース名・一覧を手で持たない）
const APPS = fs.readdirSync(path.join(ROOT, "apps")).filter(d => {
	try { return JSON.parse(fs.readFileSync(path.join(ROOT, "apps", d, "package.json"), "utf8")).servedAt === AT; } catch { return false; }
}).sort();
const DEST = path.join(process.cwd(), "dist/site", AT);

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
if (!fs.existsSync(DEST)) throw new Error(`先に vite build（${path.relative(ROOT, DEST)} が無い）`);
for (const app of APPS) {
	if (!process.argv.includes("--no-build")) execFileSync("npm", ["run", "build", "-w", app], { cwd: ROOT, stdio: "inherit" });
	const src = path.join(ROOT, "apps", app, "dist/site", AT);
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
