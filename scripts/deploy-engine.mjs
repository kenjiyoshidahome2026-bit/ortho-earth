#!/usr/bin/env node
// 共有エンジンを上げた時の一括デプロイ（エンジン配布の恒久対策 B・2026-10-14／エンジンの独立デプロイ 2026-10-15）。repo 直下で `npm run deploy:engine`。
// 旧＝ortho-globe を配ったあと、エンジンを使う各アプリを手で 1 つずつ配り直す＝忘れたアプリが古い版を指したまま残った
// （tellus・census2020・nl・quiz・2026-10-14）。ここは正しい順で全部を配る：
//   ① 検定：ortho-globe を build（頭でエンジンを焼く）して verify-prod＝このエンジンで 8 頁が起きる（エンジンを出す前の門。
//      エンジンの Worker は旧版の入口を今の版へ 302 する＝出した瞬間に全アプリが新しいエンジンで走る＝出す前に確かめる）
//   ② エンジン（apps/engine・Worker ortho-engine・route /globe/engine/*）＝出荷物の門 check.mjs → wrangler deploy
//   ③ ortho-globe（① で組んで確かめた dist をそのまま出す＝deploy:built）→ ④ エンジンを使う各アプリ（各 deploy の門 check-engine-live が ② の済みを確かめる）
//   1 つ落ちたら止める（後ろは配らない）。gishub-jp・geopbf-demo は www（Cloudflare Pages）が main の push で自動で組む＝ここでは配らない。
//   node scripts/deploy-engine.mjs [アプリ名…]   （名前を渡すとそのアプリだけ・①② は常に先頭）
//   node scripts/deploy-engine.mjs --engine-only （①② だけ＝apps/engine の npm run deploy）
//   node scripts/deploy-engine.mjs --gate-only   （① と、各アプリの Chrome の門（GATES）だけ＝何も配らない・鍵が要らない・
//      落ちても止めずに全部回して最後に一覧＝Actions の runner で門が通るかを、鍵を入れる前に確かめる・2026-10-21）
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { requireNode } from "./lib/node-version.mjs";

requireNode();   // 古い node（.ts を読めない）は何も配る前に止める（2026-10-19・solar の ephem の検定で止まった）
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APPS = ["quakes", "ortho-globe", "census2020", "ortho-nl", "world-quiz", "choju", "yokohama", "world", "equal", "ortho-japan", "solar", "himekuri"];   // 名前＝apps/ の下の置き場（cwd）   // solar・himekuri＝2026-10-15 に共有エンジンへ・quakes＝同日に ortho-globe から独立＝ortho-globe より先に配る（/globe/quakes を受ける Worker が先に立つ＝抜けが出ない）   // vite.config.js が sharedEngine() を使い、自前の deploy を持つアプリ
const GATES = {   // --gate-only で回す各アプリの門（各 deploy から wrangler の手前までの重い物＝Chrome を使う物）
	"quakes": "npm run build && npm run verify:prod",
	"census2020": "npm run verify:prod",
	"world": "npm run verify:prod",
	"ortho-japan": "node scripts/deploy.mjs --gate-only",
	"solar": "npm run verify:i18n && npm test -w @ortho-earth/ephem",
};
const args = process.argv.slice(2), engineOnly = args.includes("--engine-only"), gateOnly = args.includes("--gate-only");
const pick = args.filter(a => !a.startsWith("--"));
const bad = pick.filter(a => !APPS.includes(a));
if (bad.length) { console.error(`✗ 知らないアプリ：${bad.join(" ")}（${APPS.join("・")}）`); process.exit(1); }
const lost = APPS.filter(a => !fs.existsSync(path.join(ROOT, "apps", a, "package.json")));   // 置き場の名を改めた時の取り違え（2026-10-15 himekuri-demo→himekuri で、無い cwd に黙って落ちた）を配る前に止める
if (lost.length) { console.error(`✗ apps/ に無いアプリ：${lost.join(" ")}（APPS は apps/ の下の置き場の名）`); process.exit(1); }
const apps = engineOnly ? [] : pick.length ? APPS.filter(a => pick.includes(a)) : APPS;
// [名前, 場所, npm の引数, 配り終えた印]
const steps = [
	["検定：ortho-globe の build（頭でエンジンを焼く）", "ortho-globe", ["run", "build"]],
	["検定：ortho-globe の verify-prod（このエンジンで 8 頁）", "ortho-globe", ["run", "verify:prod"]],
	["engine", "engine", ["run", "deploy:built"], true],   // 出荷物の門 check.mjs → wrangler deploy
	...apps.map(a => [a, a, ["run", a === "ortho-globe" ? "deploy:built" : "deploy"], true]),
];
if (gateOnly) {   // 配らない＝順序の制約（engine が live）も無い・落ちても先へ進んで全部の結果を出す
	const gates = [["ortho-globe", "npm run build && npm run verify:prod"], ...apps.filter(a => GATES[a]).map(a => [a, GATES[a]])];
	const t0 = Date.now(), res = [];
	for (const [name, cmd] of gates) {
		console.log(`\n=== 門：${name}（${cmd}）`);
		const r = spawnSync("sh", ["-c", cmd], { cwd: path.join(ROOT, "apps", name), stdio: "inherit" });
		res.push([name, r.status === 0]);
	}
	const lines = res.map(([n, ok]) => `${ok ? "✓" : "✗"} ${n}`);
	console.log(`\n門だけ（何も配っていない・${((Date.now() - t0) / 60000).toFixed(1)} 分）\n${lines.join("\n")}`);
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `#### 門だけ\n${lines.map(l => `- ${l}`).join("\n")}\n`);
	process.exit(res.every(([, ok]) => ok) ? 0 : 1);
}
const t0 = Date.now(), done = [];
for (const [name, dir, cmd, fin] of steps) {
	console.log(`\n=== ${name}（npm ${cmd.join(" ")}）`);
	const r = spawnSync("npm", cmd, { cwd: path.join(ROOT, "apps", dir), stdio: "inherit" });
	if (r.status !== 0) {
		if (r.error) console.error(`✗ ${r.error.message}`);
		const left = ["engine", ...apps].filter(a => !done.includes(a));
		console.error(`\n✗ ${name} が落ちた＝ここで止める（済み：${done.join("・") || "なし"}／未：${left.join("・")}）`);
		process.exit(1);
	}
	if (fin) done.push(name);
}
console.log(`\n✓ ${done.join("・")} を配った（${((Date.now() - t0) / 60000).toFixed(1)} 分）。${engineOnly ? "" : "gishub-jp・geopbf-demo は www の自動デプロイ（main の push）で揃う"}`);
