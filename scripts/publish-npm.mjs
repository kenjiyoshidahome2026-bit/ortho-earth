#!/usr/bin/env node
// npm の公開を 1 本に（2026-10-17・Actions の「publish」ボタンの中身／手元でも同じ）。repo 直下で：
//   node scripts/publish-npm.mjs [名前…] [--dry-run]
// 何を出すか＝private でない workspace のうち、package.json の版が npm にまだ無い物だけ（版を上げた物だけが出る＝出し直しは起きない）。
//   名前を渡すとその中から（版が npm に在る物は飛ばす）。順番＝中の依存（dependencies・peer・optional）を満たす順＝geopbf → … → core → globe → react 等。
// provenance＝Actions の Trusted Publishing（OIDC）では npm が自動で付けるが、repository.url がこの repo（ortho-earth）でない物
//   （geopbf・altpbf・geoedit・himekuri＝公開ミラーの repo を指す）は npm が「出所が違う」と弾く＝その物だけ --provenance=false。
// 1 つ落ちたら止める（公開済みの物は取り消さない＝直して打ち直せば、出た物は「npm に在る」で飛ばされ、止まった所から続く）。
// 出した名前は GITHUB_OUTPUT の published=（空白区切り）へ＝後ろの mirror の job が拾う。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2), dryRun = args.includes("--dry-run");
const pick = args.filter(a => !a.startsWith("--"));
const HOME_REPO = "kenjiyoshidahome2026-bit/ortho-earth";

// workspace の一覧（root の workspaces＝"dir/*" か素の dir）
const ws = [];
for (const pat of JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).workspaces) {
	const dirs = pat.endsWith("/*") ? fs.readdirSync(path.join(ROOT, pat.slice(0, -2))).map(d => path.join(pat.slice(0, -2), d)) : [pat];
	for (const d of dirs) {
		const f = path.join(ROOT, d, "package.json");
		if (!fs.existsSync(f)) continue;
		const p = JSON.parse(fs.readFileSync(f, "utf8"));
		if (!p.private && p.name && p.version) ws.push({ dir: d, ...p });
	}
}
const byName = new Map(ws.map(p => [p.name, p]));
const bad = pick.filter(n => !byName.has(n));
if (bad.length) { console.error(`✗ 公開できる workspace に無い名前：${bad.join(" ")}`); process.exit(1); }

// npm に在るか（E404＝無い。それ以外の誤り＝確かめられない＝止める）
const onNpm = p => {
	const r = spawnSync("npm", ["view", `${p.name}@${p.version}`, "version", "--json"], { cwd: ROOT, encoding: "utf8" });
	if (r.status === 0) return r.stdout.trim() !== "";
	if (/E404|404 Not Found/.test(r.stderr + r.stdout)) return false;
	console.error(`✗ npm view ${p.name}@${p.version} が落ちた：\n${r.stderr}`); process.exit(1);
};
const todo = (pick.length ? pick.map(n => byName.get(n)) : ws).filter(p => {
	const have = onNpm(p);
	console.log(`${have ? "・ 在る" : "＋ 出す"}  ${p.name}@${p.version}`);
	return !have;
});
if (!todo.length) { console.log("\n出す物は無い（全部の版が npm に在る）"); out([]); process.exit(0); }

// 中の依存を満たす順（todo の中だけで並べる＝出さない物はもう npm に在る）
const want = new Set(todo.map(p => p.name)), order = [], seen = new Set();
const visit = (p, stack = []) => {
	if (seen.has(p.name)) return;
	if (stack.includes(p.name)) { console.error(`✗ 依存が輪になっている：${[...stack, p.name].join(" → ")}`); process.exit(1); }
	for (const d of Object.keys({ ...p.dependencies, ...p.peerDependencies, ...p.optionalDependencies }))
		if (want.has(d)) visit(byName.get(d), [...stack, p.name]);
	seen.add(p.name); order.push(p);
};
todo.forEach(p => visit(p));

console.log(`\n=== ${dryRun ? "乾いた走り" : "公開"}：${order.map(p => `${p.name}@${p.version}`).join(" → ")}`);
const done = [];
for (const p of order) {
	const repo = typeof p.repository === "string" ? p.repository : p.repository?.url ?? "";
	const prov = repo.includes(HOME_REPO) ? [] : ["--provenance=false"];
	const cmd = ["publish", "--access", "public", "-w", p.name, ...prov, ...(dryRun ? ["--dry-run"] : [])];
	console.log(`\n--- npm ${cmd.join(" ")}`);
	const r = spawnSync("npm", cmd, { cwd: ROOT, stdio: "inherit" });
	if (r.status !== 0) {
		console.error(`\n✗ ${p.name} で止めた（済み：${done.join("・") || "なし"}）。直して打ち直せば、済んだ物は飛ばして続く`);
		out(done); process.exit(1);
	}
	done.push(p.name);
}
console.log(`\n✓ ${dryRun ? "乾いた走り OK" : "公開した"}：${done.join("・")}`);
out(done);

// names＝通った物（乾いた走りでは出していない＝published は空にする）
function out(names) {
	if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `published=${dryRun ? "" : names.join(" ")}\n`);
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
		`### npm ${dryRun ? "（乾いた走り）" : ""}\n\n${names.length ? names.map(n => `- ${n}@${byName.get(n).version}`).join("\n") : "出す物は無い"}\n`);
}
