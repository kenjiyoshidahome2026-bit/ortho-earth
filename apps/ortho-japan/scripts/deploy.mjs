#!/usr/bin/env node
// 本番デプロイ＝関門 2 本（verify:editor・verify:prod）を**並行**に回してから wrangler deploy → verify-live。
// 旧＝npm script の && 直列（editor 83 s → prod 140〜234 s → deploy → live 32 s ≈ 5〜6 分・2026-09-20 実測）。
// 2 本はポートが別（editor 5244/9344・prod 5241/9351/9353）で干渉しない。どちらか落ちれば deploy しない。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const t0 = Date.now(), el = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const run = (cmd, args, tag) => new Promise(res => {
	const c = spawn(cmd, args, { cwd: APP, stdio: ["ignore", "pipe", "pipe"], shell: false });
	const pipe = (st, w) => st.on("data", d => { for (const line of String(d).split("\n")) if (line.trim()) w(`[${tag} ${el()}] ${line}`); });
	pipe(c.stdout, l => console.log(l)); pipe(c.stderr, l => console.error(l));
	c.on("close", code => res(code));
});
console.log("… 関門を並行で（verify:editor ‖ verify:prod）");
const [ed, pr] = await Promise.all([run("npm", ["run", "-s", "verify:editor"], "editor"), run("npm", ["run", "-s", "verify:prod"], "prod")]);
if (ed !== 0 || pr !== 0) { console.error(`✗ 関門 FAIL（editor=${ed} prod=${pr}）＝deploy しない ${el()}`); process.exit(1); }
console.log(`✓ 関門 PASS ${el()}`);
// 配布物の掃除（dev 専用・重い置き土産）→ deploy → 実配信の検定
const sh = (cmd) => run("sh", ["-c", cmd], "deploy");
if (await sh("rm -rf dist/site/japan/moj-local dist/site/japan/plateau-names.json dist/site/japan/quakes && find dist/site -name .DS_Store -delete") !== 0) process.exit(1);
if (await run("npx", ["wrangler", "deploy"], "wrangler") !== 0) { console.error("✗ wrangler deploy FAIL"); process.exit(1); }
// verify-live＝アップロード直後は一過性の fetch 失敗が出ることがある（3 回中 2 回・2026-09-19）＝一度だけ待って再試行
let live = await run("node", ["scripts/verify-live.mjs"], "live");
if (live !== 0) { console.log("… verify-live を 10 秒後に再試行（アップロード直後の一過性）"); await new Promise(r => setTimeout(r, 10000)); live = await run("node", ["scripts/verify-live.mjs"], "live"); }
console.log(live === 0 ? `✓ deploy 完了 ${el()}` : `✗ verify-live FAIL ${el()}`);
process.exit(live === 0 ? 0 : 1);
