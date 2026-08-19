#!/usr/bin/env node
// census2020 本番組立の検定（SDK二重構成＝main.js冒頭の分岐）。deploy の必須ゲート。
//   本番の census は /japan/lib/ のSDK（ortho-japan Worker が配る）を実行時に食う＝ここでは
//   隣の apps/ortho-japan/dist/lib を /japan/lib/ にマウントした静的サーバで本番の形を再現する。
// 検査項目：
//   ①静的: 入口チャンクが lib のURLを import し、エンジンを再バンドルしていない
//          （判定＝エンジン固有のUI文字列「互換描画(WebGL2)」が census 資産に**居ない**こと。
//           minifyでも文字列リテラルは生き残る＝サイズ閾値より頑丈な指紋）
//   ②実走: census ページが SDK 経由で起動（チップ点灯・canvas生成・censusパネル存在）
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
const PORT = 5242, CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".csv": "text/csv", ".webp": "image/webp" };
const fail = msg => { console.error(`✗ ${msg}`); process.exit(1); };

console.log("… build（census）＋ build:lib（隣のSDK＝本番で /japan/lib/ に居る物の代役）");
execFileSync("npx", ["vite", "build", "--logLevel", "warn"], { cwd: APP, stdio: "inherit" });
execFileSync("npm", ["run", "build:lib", "--silent"], { cwd: JAPAN, stdio: "inherit" });

// ① 入口＝lib参照・エンジン非同梱（指紋＝エンジン辞書のUI文字列）
const assetsDir = path.join(OUT, "japan/census2020/assets");
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

// ② 実走：census dist ＋ /japan/lib/（隣のdist/lib）＋ /japan/*（共有棚 public）を一つの静的サーバで
const read = promisify(readFile);
const roots = p =>
	p.startsWith("/japan/lib/") ? path.join(JAPAN, "dist/lib", p.slice("/japan/lib/".length))
	: p.startsWith("/japan/census2020") ? path.join(OUT, p.endsWith("/") ? p + "index.html" : p)
	: path.join(JAPAN, "public", p.replace(/^\/japan\//, ""));   // plateau-sets.json 等＝本番はortho-japan Workerの棚
const requests = [];   // 「ブラウザが実際に何を取りに来たか」の台帳＝実走判定の根拠
const server = createServer(async (req, res) => {
	const p = new URL(req.url, "http://x").pathname;
	try {
		const file = roots(p);   // MIME判定は実ファイル名で（"/…/"→index.html 補完後）＝URLパス判定だとhtmlがoctet-streamになる罠
		const body = await read(file);
		requests.push("200 " + p);
		res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
			"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" });
		res.end(body);
	} catch { requests.push("404 " + p); res.writeHead(404); res.end("not found"); }
}).listen(PORT);

// census 頁は headless+SwiftShader で main スレッドが飽和し、DOM 安定待ち（dump-dom虚時間/CDP evaluate）が
// 成立しない（全国コロプレス視点＝ソフトウェアラスタ最重量級）。ここでの検定目的は
// 「本番形（SDK外部参照）の配線が生きて起動プロセスが走る」こと＝**サーバ側の実観測**で判定する：
//   ブラウザが実際に何を取りに来たか（lib入口→エンジン→worker→assetBase棚）＋404ゼロ。
//   ネットワーク要求は main スレッドの混み具合と無関係に必ず観測できる＝ハングしない検定。
// --remote-debugging-port=0＝「アクションフラグ無しのheadlessは即exit」を防ぐ生存錨（接続はしない・ポートも使わない）
const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=/tmp/census-vprod-${process.pid}`, "--remote-debugging-port=0",
	"--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-first-run",
	`http://localhost:${PORT}/japan/census2020/?gl2=1&verify=1`], { stdio: "ignore" });
process.on("exit", () => { server.close(); chrome.kill(); });
const need = [
	["/japan/census2020/assets/", "census入口チャンク"],
	["/japan/lib/ortho-japan.js", "SDK入口"],
	["/japan/lib/ortho-japan.css", "SDK意匠"],
	["/japan/lib/assets/app-", "エンジン本体チャンク"],
	["/japan/lib/assets/renderworker-", "render worker"],
	["/japan/plateau-sets.json", "assetBase（/japan/共有棚）"],
];
// 必須6点が台帳に揃うまで毎秒見る（上限90秒・揃ったら即終了）＝SwiftShaderの遅い起動にもハングにも強い
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
console.log("✓ census2020 本番組立の検定PASS");
process.exit(0);
