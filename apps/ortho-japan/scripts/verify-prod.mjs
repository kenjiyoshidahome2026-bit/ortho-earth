#!/usr/bin/env node
// 本番組立（SDK二重構成）の検定：build:prod で組んだ dist/site を「本番の形のまま」検査する。
//   背景＝dev はソース直・本番は SDK（/japan/lib/）という二重構成（site.js 冒頭の分岐）。
//   dev で全緑でも本番だけ壊れる事故（worker data:URL 事件の型）をデプロイ前に必ず捕まえるのがこの関門。
//   deploy スクリプトはこの検定を通らないと wrangler に到達しない（必須ゲート）。
// 検査項目：
//   ①静的: index の入口チャンクが lib のURLを import し、エンジンを再バンドルしていない（サイズ上限＝DCEの証明）
//   ②静的: dist/site/japan/lib/ に SDK 実体（ortho-japan.js/.css）が居る
//   ③実走: dist/site を素の静的サーバ（COOP/COEP付き＝本番Workerと同じ頭）で配り、headless Chrome で
//          起動→チップ点灯まで確認（ja）。vite を挟まない＝出荷物そのものを食う
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile, readFileSync, existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE = path.join(APP, "dist/site");
const PORT = 5241, CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".webp": "image/webp" };
const fail = msg => { console.error(`✗ ${msg}`); process.exit(1); };

console.log("… build:prod");
execFileSync("npm", ["run", "build:prod"], { cwd: APP, stdio: "inherit" });

// ① 入口チャンク＝lib参照・エンジン非同梱（100KB上限＝app.js本体(330KB+)が紛れたら即破裂する閾値）
const html = readFileSync(path.join(SITE, "japan/index.html"), "utf8");
const entry = html.match(/<script type="module"[^>]*src="([^"]+\.js)"/)?.[1];
if (!entry) fail("index.html に module script が見つからない");
const entryPath = path.join(SITE, "japan", entry.replace(/^\/japan\//, ""));
const entrySrc = readFileSync(entryPath, "utf8");
if (!entrySrc.includes("/japan/lib/ortho-japan.js")) fail(`入口チャンク ${entry} が lib を import していない（devのソース直が紛れた疑い）`);
const entryKB = statSync(entryPath).size / 1024;
if (entryKB > 100) fail(`入口チャンクが ${entryKB.toFixed(0)}KB＝エンジンが再バンドルされている疑い（DCE失敗）`);
console.log(`ok:entry（${entry} ${entryKB.toFixed(1)}KB・lib参照）`);

// ② SDK実体
for (const f of ["japan/lib/ortho-japan.js", "japan/lib/ortho-japan.css"]) {
	if (!existsSync(path.join(SITE, f))) fail(`${f} が無い（build:prod の複写漏れ）`);
}
console.log("ok:lib（ortho-japan.js/.css 同梱）");

// ③ 実走：素の静的サーバ（COOP/COEP＝本番 deploy-worker と同じ頭・SAB経路も点火）
const read = promisify(readFile);
const server = createServer(async (req, res) => {
	const p = new URL(req.url, "http://x").pathname;
	const file = path.join(SITE, p.endsWith("/") ? p + "index.html" : p);
	try {
		const body = await read(file);
		res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
			"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" });
		res.end(body);
	} catch { res.writeHead(404); res.end("not found"); }
}).listen(PORT);

const dom = await new Promise(resolve => {
	const args = ["--headless=new", "--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
		"--virtual-time-budget=30000", "--dump-dom", `http://localhost:${PORT}/japan/?gl2=1&lang=ja`];
	const c = spawn(CHROME, args, { timeout: 90000 });
	let out = "";
	c.stdout.on("data", d => out += d);
	c.on("close", () => resolve(out));
});
server.close();
if (!dom.includes("ortho-japan")) fail("実走: タイトル不在＝ページが立っていない");
if (!/id="chips"/.test(dom) || !dom.includes("地名")) fail("実走: チップ列が出ていない＝エンジン起動失敗の疑い");
if (!/<canvas id="c"/.test(dom)) fail("実走: 描画canvas不在");
console.log("ok:boot（SDK経由で起動・チップ点灯・canvas生成）");
console.log("✓ 本番組立の検定PASS（入口=SDK・エンジン非再バンドル・実走OK）");
