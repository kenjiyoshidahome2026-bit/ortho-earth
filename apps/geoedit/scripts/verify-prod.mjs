#!/usr/bin/env node
// geoedit 本番組立の検定（SDK二重構成＝main.js冒頭の分岐）。deploy の必須ゲート（census2020 と同型）。
//   本番の geoedit は /japan/lib/ のSDK（ortho-japan Worker が配る）を実行時に食う＝ここでは
//   隣の apps/ortho-japan/dist/lib を /japan/lib/ にマウントした静的サーバで本番の形を再現する。
// 検査項目：
//   ①静的: 入口チャンクが lib のURLを import し、エンジンを再バンドルしていない（指紋文字列）
//   ②実走: SDK入口→エンジン→worker→共有棚（assetBase=/japan/）の取得をサーバ側で実観測・404ゼロ
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile, readFileSync, readdirSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const JAPAN = path.resolve(APP, "../ortho-japan");
const OUT = path.join(APP, "dist/site");
const PORT = 5243, CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".webp": "image/webp" };
const fail = msg => { console.error(`✗ ${msg}`); process.exit(1); };

console.log("… build（geoedit）＋ build:lib（隣のSDK＝本番で /japan/lib/ に居る物の代役）");
execFileSync("npx", ["vite", "build", "--logLevel", "warn"], { cwd: APP, stdio: "inherit" });
execFileSync("npm", ["run", "build:lib", "--silent"], { cwd: JAPAN, stdio: "inherit" });

// ① 入口＝lib参照・エンジン非同梱
const assetsDir = path.join(OUT, "geoedit/assets");
const chunks = readdirSync(assetsDir).filter(f => f.endsWith(".js"));
let libRef = false;
for (const f of chunks) {
	const src = readFileSync(path.join(assetsDir, f), "utf8");
	if (src.includes("/japan/lib/ortho-japan.js")) libRef = true;
	if (src.includes("互換描画(WebGL2)")) fail(`${f} にエンジンが再バンドルされている（指紋文字列を検出）`);
}
if (!libRef) fail("どのチャンクも /japan/lib/ortho-japan.js を import していない（devソース直が紛れた疑い）");
if (!existsSync(path.join(JAPAN, "dist/lib/ortho-japan.js"))) fail("隣の dist/lib が無い（build:lib 失敗）");
console.log(`ok:entry（${chunks.length}チャンク・lib参照あり・エンジン指紋なし）`);

// ② 実走：geoedit dist ＋ /japan/lib/（隣のdist/lib）＋ /japan/*（共有棚 public）を一つの静的サーバで
const read = promisify(readFile);
const roots = p =>
	p.startsWith("/japan/lib/") ? path.join(JAPAN, "dist/lib", p.slice("/japan/lib/".length))
	: p.startsWith("/geoedit") ? path.join(OUT, p.endsWith("/") ? p + "index.html" : p)
	: path.join(JAPAN, "public", p.replace(/^\/japan\//, ""));
const requests = [];
const server = createServer(async (req, res) => {
	const p = new URL(req.url, "http://x").pathname;
	try {
		const file = roots(p);
		const body = await read(file);
		requests.push("200 " + p);
		res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
			"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" });
		res.end(body);
	} catch { requests.push("404 " + p); res.writeHead(404); res.end("not found"); }
}).listen(PORT);

const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=/tmp/geoedit-vprod-${process.pid}`, "--remote-debugging-port=0",
	"--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-first-run",
	`http://localhost:${PORT}/geoedit/?gl2=1&verify=1`], { stdio: "ignore" });
process.on("exit", () => { server.close(); chrome.kill(); });
const need = [
	["/geoedit/assets/", "geoedit入口チャンク"],
	["/japan/lib/ortho-japan.js", "SDK入口"],
	["/japan/lib/ortho-japan.css", "SDK意匠"],
	["/japan/lib/assets/app-", "エンジン本体チャンク"],
	["/japan/lib/assets/renderworker-", "render worker"],
	["/japan/plateau-sets.json", "assetBase（/japan/共有棚）"],
];
const t0 = Date.now();
let missing = need;
while (Date.now() - t0 < 90000) {
	await sleep(1000);
	const got = requests.join("\n");
	missing = need.filter(([frag]) => !got.includes(frag));
	if (!missing.length) break;
}
chrome.kill();
server.close();
console.log(`  取得台帳 ${requests.length}件・${((Date.now() - t0) / 1000) | 0}s（先頭）: ${requests.slice(0, 6).join(" | ") || "（空＝ブラウザが来ていない）"}`);
if (missing.length) { console.error("  台帳全行:\n  " + requests.join("\n  ")); fail(`実走: ${missing.map(([f, l]) => `${l}（${f}…）`).join("・")}が取得されていない`); }
const notFound = requests.filter(r => r.startsWith("404 "));
if (notFound.length) fail(`実走: 404が${notFound.length}件＝${[...new Set(notFound)].slice(0, 5).join(" / ")}`);
console.log(`ok:boot（要求${requests.length}件＝SDK入口→エンジン→worker→共有棚の取得を実観測・404ゼロ）`);
console.log("✓ geoedit 本番組立の検定PASS");
process.exit(0);
