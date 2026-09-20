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
// エディタ関門の範囲＝前回 deploy（git tag japan-deployed）から、エディタや gint の実装が動いていれば**全部**（t-editor 61 s・t-zoomfill 60 s 込み）、
// 動いていなければ速い 4 ページ（t-backfill/t-rectlook×2/t-import ≈ 16 s）だけ。geoedit は packages/geoedit（2026-09-20 分離）＝
// japan の deploy でその実装が変わっていないなら、長い対話回帰を毎回回す理由がない。tag が無い（初回）＝全部。
const WATCH = ["packages/geoedit", "packages/geopbf/src/edit", "packages/ortho-core/src", "apps/ortho-japan/gint", "apps/ortho-japan/gadgets/anno.js", "apps/ortho-japan/gadgets/anno-draw.js", "apps/ortho-japan/tests"];
const changed = await new Promise(res => { const c = spawn("git", ["diff", "--name-only", "japan-deployed", "HEAD", "--", ...WATCH], { cwd: APP }); let out = "", bad = false; c.stdout.on("data", d => out += d); c.on("error", () => res(null)); c.on("close", code => res(code === 0 ? out.split("\n").filter(Boolean) : null)); });
const dirty = await new Promise(res => { const c = spawn("git", ["status", "--porcelain", "--", ...WATCH], { cwd: APP }); let out = ""; c.stdout.on("data", d => out += d); c.on("close", () => res(out.split("\n").filter(Boolean))); });
const full = changed === null || changed.length > 0 || dirty.length > 0;
const QUICK = ["t-backfill", "t-rectlook?tool=circle&v=%235/9/-175&a=-178,9&b=-170,9&zs=7,6,5,4,3", "t-rectlook?tool=circle&v=%235/9/-175&a=-178,9&b=-162,9&zs=6&probe=450,325&far=2,-9,3", "t-import"];
console.log(`… 関門を並行で（verify:editor${full ? "（全部＝エディタ/gint に変更あり" + (changed === null ? "・tag なし" : `・${changed.length + dirty.length} ファイル`) + "）" : "（速い 4 ページ＝エディタ/gint に変更なし）"} ‖ verify:prod）`);
const [ed, pr] = await Promise.all([
	full ? run("npm", ["run", "-s", "verify:editor"], "editor") : run("node", ["scripts/verify-editor.mjs", ...QUICK], "editor"),
	run("npm", ["run", "-s", "verify:prod"], "prod"),
]);
if (ed !== 0 || pr !== 0) { console.error(`✗ 関門 FAIL（editor=${ed} prod=${pr}）＝deploy しない ${el()}`); process.exit(1); }
console.log(`✓ 関門 PASS ${el()}`);
// 配布物の掃除（dev 専用・重い置き土産）→ deploy → 実配信の検定
const sh = (cmd) => run("sh", ["-c", cmd], "deploy");
if (await sh("rm -rf dist/site/japan/moj-local dist/site/japan/plateau-names.json dist/site/japan/quakes && find dist/site -name .DS_Store -delete") !== 0) process.exit(1);
if (await run("npx", ["wrangler", "deploy"], "wrangler") !== 0) { console.error("✗ wrangler deploy FAIL"); process.exit(1); }
// verify-live＝アップロード直後は一過性の fetch 失敗が出ることがある（3 回中 2 回・2026-09-19）＝一度だけ待って再試行
let live = await run("node", ["scripts/verify-live.mjs"], "live");
if (live !== 0) { console.log("… verify-live を 10 秒後に再試行（アップロード直後の一過性）"); await new Promise(r => setTimeout(r, 10000)); live = await run("node", ["scripts/verify-live.mjs"], "live"); }
if (live === 0) await run("git", ["tag", "-f", "japan-deployed", "HEAD"], "tag");   // 次回のエディタ関門の範囲判定の基準（ローカル tag・push しない）
console.log(live === 0 ? `✓ deploy 完了 ${el()}` : `✗ verify-live FAIL ${el()}`);
process.exit(live === 0 ? 0 : 1);
