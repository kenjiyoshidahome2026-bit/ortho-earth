// 公開ミラー（github/geopbf）への一方向同期＝subtree split → force push（native-bucket の mirror.mjs と同じ筋）。
// geopbf だけ一段多い：prepack／postpack が使うモノレポの scripts/pack-ts.mjs（src/*.ts ⇄ dist の差し替え）は packages/geopbf の外＝
// subtree split に入らない＝単独 repo の CI（npm run verify:npm の npm pack）が落ちる。割り出した枝の上に
// 「scripts/pack-ts.mjs の写し＋package.json の口を ./scripts へ」1 コミットを積んでから押す（2026-10-23）。
//   1. git subtree split  2. 一時 worktree に pack-ts.mjs を写し、prepack／postpack の ../../scripts を scripts に  3. commit  4. mirror の main へ force push  5. 掃除
import { execSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PKG = resolve(import.meta.dirname, "..");
const ROOT = resolve(PKG, "../..");
const REMOTE = "https://github.com/kenjiyoshidahome2026-bit/geopbf.git";
const BRANCH = "geopbf-mirror";
const WT = resolve(ROOT, ".mirror-geopbf");
const sh = (cmd, cwd = ROOT) => { console.log(`$ ${cmd}`); return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim(); };

const cleanup = () => {
	if (existsSync(WT)) sh(`git worktree remove --force "${WT}"`);
	try { sh(`git branch -D ${BRANCH}`); } catch {}
};
cleanup();
try {
	sh(`git subtree split --prefix=packages/geopbf -b ${BRANCH}`);
	sh(`git worktree add "${WT}" ${BRANCH}`);
	cpSync(resolve(ROOT, "scripts/pack-ts.mjs"), resolve(WT, "scripts/pack-ts.mjs"));
	const pj = resolve(WT, "package.json"), src = readFileSync(pj, "utf8");
	const out = src.replaceAll("node ../../scripts/pack-ts.mjs", "node scripts/pack-ts.mjs");
	if (out === src) throw new Error("package.json に ../../scripts/pack-ts.mjs が無い＝写しの前提が崩れた");
	writeFileSync(pj, out);
	sh("git add scripts/pack-ts.mjs package.json", WT);
	sh(`git -c user.name="mirror" -c user.email="kenji.yoshida.home.2026@gmail.com" commit -q -m "build: scripts/pack-ts.mjs（npm pack の口の差し替え＝モノレポの npm run mirror が写す）"`, WT);
	sh(`git push --force "${REMOTE}" HEAD:main`, WT);
	console.log("mirror synced:", REMOTE);
} finally {
	cleanup();
}
