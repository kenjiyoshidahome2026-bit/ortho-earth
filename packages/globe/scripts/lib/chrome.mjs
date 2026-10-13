// 検定が起こす Chrome＝検定専用の Chrome for Testing（2026-09-30）。
// なぜ：検定は /Applications/Google Chrome.app を headless で起こしていた＝macOS が「Chrome は動いている」とみなし、
//   本人が Chrome を押しても窓の無い検定用へ渡る（起動しない・再起動できない）。Chrome for Testing は別のアプリ（別の bundle id）＝ぶつからない。
//   版も固定＝自動更新で検定の途中に版が変わらない（2026-09-30 は 153→154 の更新が走っていた）。
// 置き場＝~/.cache/ortho-earth/chrome-for-testing/<版>/（ORTHO_CHROME_DIR で変更）＝worktree とセッションで 1 回の取得を共有。
// 選ぶ順＝env CHROME → 検定専用（無ければ取りに行く）→ 取れなければ /Applications の Chrome（ぶつかる旨を 1 回警告）。
// 手で：node packages/globe/scripts/lib/chrome.mjs --install ｜ --path
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CFT_VERSION = "154.0.8037.92";   // 上げる時はここだけ（取得は次の起動で自動）
export const APP_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = process.env.ORTHO_CHROME_DIR || path.join(os.homedir(), ".cache", "ortho-earth", "chrome-for-testing");
const PLATFORM = process.platform === "darwin" ? (process.arch === "arm64" ? "mac-arm64" : "mac-x64")
	: process.platform === "linux" ? "linux64" : process.platform === "win32" ? "win64" : null;
const BIN = {
	"mac-arm64": "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
	"mac-x64": "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
	linux64: "chrome-linux64/chrome",
	win64: "chrome-win64/chrome.exe",
};

// 検定専用の Chrome の実行ファイル（入っていなければ null）
export function cftPath(version = CFT_VERSION) {
	if (!PLATFORM) return null;
	const p = path.join(ROOT, version, BIN[PLATFORM]);
	return fs.existsSync(p) ? p : null;
}

// 取りに行って展開する（同時に複数の検定が呼んでも、置き場への移し替えは 1 回だけ勝つ）
export async function installChrome(version = CFT_VERSION, { log = console.log } = {}) {
	if (!PLATFORM) throw new Error(`Chrome for Testing: unsupported platform ${process.platform}/${process.arch}`);
	const have = cftPath(version); if (have) return have;
	const url = `https://storage.googleapis.com/chrome-for-testing-public/${version}/${PLATFORM}/chrome-${PLATFORM}.zip`;
	log(`[chrome] 検定専用の Chrome for Testing ${version} を取得（初回だけ・約 150MB）→ ${ROOT}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Chrome for Testing: ${res.status} ${url}`);
	fs.mkdirSync(ROOT, { recursive: true });
	const tmp = fs.mkdtempSync(path.join(ROOT, `.dl-${version}-`));
	try {
		const zip = path.join(tmp, "chrome.zip");
		fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
		const out = path.join(tmp, "x");
		fs.mkdirSync(out);
		if (process.platform === "darwin") execFileSync("ditto", ["-x", "-k", zip, out]);   // .app の中の symlink と実行権を保つ
		else execFileSync("unzip", ["-q", zip, "-d", out]);
		try { fs.renameSync(out, path.join(ROOT, version)); }
		catch (e) { if (!cftPath(version)) throw e; }   // 同時に取った相手が先に置いた＝それを使う
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
	const p = cftPath(version);
	if (!p) throw new Error(`Chrome for Testing: ${BIN[PLATFORM]} not found after unzip`);
	log(`[chrome] 入った：${execFileSync(p, ["--version"]).toString().trim()}`);
	return p;
}

// 検定が使う Chrome（env CHROME → 検定専用〔無ければ取る〕→ /Applications）
let warned = false;
export async function resolveChrome() {
	if (process.env.CHROME) return process.env.CHROME;
	const have = cftPath(); if (have) return have;
	try { return await installChrome(); }
	catch (err) {
		if (!warned) { warned = true; console.warn(`[chrome] 検定専用の Chrome を取れなかった（${err.message}）→ /Applications の Chrome を使う＝検定の間は普段の Chrome を開き直せない`); }
		return APP_CHROME;
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--install")) console.log(await installChrome());
	else console.log(cftPath() ?? "(未導入：--install で取得)");
}
