// 公開ミラー（github/native-bucket）への一方向同期＝geopbf/altpbf の `npm run mirror` と同じ subtree split → force push。
// native-bucket だけ一段多い：README の CDN リンク（jsDelivr @main/dist/native-bucket.iife.js）が dist を要るので、
// モノレポには dist を入れず、割り出した枝の上に「ビルド成果物 1 コミット」を積んでから押す。
//   1. npm run build（demo → iife の 2 段）  2. git subtree split  3. 一時 worktree に dist/*.iife.js* を add -f して commit
//   4. mirror の main へ force push  5. worktree と枝を掃除
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PKG = resolve(import.meta.dirname, "..");
const ROOT = resolve(PKG, "../..");
const REMOTE = "https://github.com/kenjiyoshidahome2026-bit/native-bucket.git";
const BRANCH = "native-bucket-mirror";
const WT = resolve(ROOT, ".mirror-native-bucket");
const sh = (cmd, cwd = ROOT) => { console.log(`$ ${cmd}`); return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim(); };

sh("npm run build", PKG);
const cleanup = () => {
	if (existsSync(WT)) sh(`git worktree remove --force "${WT}"`);
	try { sh(`git branch -D ${BRANCH}`); } catch {}
};
cleanup();
try {
	sh(`git subtree split --prefix=packages/native-bucket -b ${BRANCH}`);
	sh(`git worktree add "${WT}" ${BRANCH}`);
	mkdirSync(resolve(WT, "dist"), { recursive: true });
	for (const f of ["native-bucket.iife.js", "native-bucket.iife.js.map"]) cpSync(resolve(PKG, "dist", f), resolve(WT, "dist", f));
	sh("git add -f dist/native-bucket.iife.js dist/native-bucket.iife.js.map", WT);
	sh(`git -c user.name="mirror" -c user.email="kenji.yoshida.home.2026@gmail.com" commit -q -m "build: dist/native-bucket.iife.js（README の CDN リンク用＝モノレポの npm run mirror が生成）"`, WT);
	sh(`git push --force "${REMOTE}" HEAD:main`, WT);
	console.log("mirror synced:", REMOTE);
} finally {
	cleanup();
}
