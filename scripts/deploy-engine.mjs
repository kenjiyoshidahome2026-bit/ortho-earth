#!/usr/bin/env node
// 共有エンジンを上げた時の一括デプロイ（エンジン配布の恒久対策 B・2026-10-14）。repo 直下で `npm run deploy:engine`。
// 旧＝ortho-globe を配ったあと、エンジンを使う各アプリを手で 1 つずつ配り直す＝忘れたアプリが古い版を指したまま残った
// （tellus・census2020・nl・quiz・2026-10-14）。ここは正しい順で全部を配る：
//   ① ortho-globe（エンジンの置き場＝/globe/engine/<版>/）→ ② エンジンを使うアプリ（各 deploy の門 check-engine-live が ① の済みを確かめる）
//   1 つ落ちたら止める（後ろは配らない）。gishub-jp・geopbf-demo は www（Cloudflare Pages）が main の push で自動で組む＝ここでは配らない。
//   node scripts/deploy-engine.mjs [アプリ名…]   （名前を渡すとそのアプリだけ・ortho-globe は常に先頭）
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APPS = ["census2020", "ortho-nl", "world-quiz", "choju", "world", "ortho-japan"];   // vite.config.js が sharedEngine() を使い、自前の deploy を持つアプリ
const pick = process.argv.slice(2);
const bad = pick.filter(a => !APPS.includes(a));
if (bad.length) { console.error(`✗ 知らないアプリ：${bad.join(" ")}（${APPS.join("・")}）`); process.exit(1); }
const order = ["ortho-globe", ...(pick.length ? APPS.filter(a => pick.includes(a)) : APPS)];
const t0 = Date.now(), done = [];
for (const app of order) {
	console.log(`\n=== ${app}（${done.length + 1}/${order.length}）`);
	const r = spawnSync("npm", ["run", "deploy"], { cwd: path.join(ROOT, "apps", app), stdio: "inherit" });
	if (r.status !== 0) {
		console.error(`\n✗ ${app} の deploy が落ちた＝ここで止める（済み：${done.join("・") || "なし"}／未：${order.slice(done.length).join("・")}）`);
		process.exit(1);
	}
	done.push(app);
}
console.log(`\n✓ ${done.join("・")} を配った（${((Date.now() - t0) / 60000).toFixed(1)} 分）。gishub-jp・geopbf-demo は www の自動デプロイ（main の push）で揃う`);
