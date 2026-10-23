// 公開ミラー（github/geopbf）への一方向同期＝subtree split → force push（native-bucket の mirror.mjs と同じ筋）。
// geopbf だけ一段多い：npm pack が使うモノレポの物（scripts/pack-ts.mjs＝src/*.ts ⇄ dist の差し替え・tsconfig.base.json＝tsc の設定）は
// packages/geopbf の外＝subtree split に入らない＝単独 repo の CI（npm run verify:npm の npm pack）が落ちる。割り出した枝の上に
// 「その 2 つの写し＋参照を repo の中へ」1 コミットを積んでから押す（2026-10-23）。
//   1. git subtree split  2. 一時 worktree に写し、package.json と tsconfig.json の ../../ を中へ  3. commit  4. mirror の main へ force push  5. 掃除
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
	// [モノレポの物, 単独 repo の置き場, 参照を直すファイル, 直す前, 直した後]
	const OVERLAY = [
		["scripts/pack-ts.mjs", "scripts/pack-ts.mjs", "package.json", "node ../../scripts/pack-ts.mjs", "node scripts/pack-ts.mjs"],
		["tsconfig.base.json", "tsconfig.base.json", "tsconfig.json", '"../../tsconfig.base.json"', '"./tsconfig.base.json"'],
	];
	for (const [from, to, ref, before, after] of OVERLAY) {
		cpSync(resolve(ROOT, from), resolve(WT, to));
		const f = resolve(WT, ref), src = readFileSync(f, "utf8"), out = src.replaceAll(before, after);
		if (out === src) throw new Error(`${ref} に ${before} が無い＝写しの前提が崩れた`);
		writeFileSync(f, out);
		sh(`git add ${to} ${ref}`, WT);
	}
	sh(`git -c user.name="mirror" -c user.email="kenji.yoshida.home.2026@gmail.com" commit -q -m "build: scripts/pack-ts.mjs と tsconfig.base.json（npm pack に要るモノレポの物＝npm run mirror が写す）"`, WT);
	sh(`git push --force "${REMOTE}" HEAD:main`, WT);
	console.log("mirror synced:", REMOTE);
} finally {
	cleanup();
}
