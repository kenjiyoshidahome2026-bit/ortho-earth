#!/usr/bin/env node
// altpbf npm 配布物の検定＝publish の必須ゲート（geopbf の関門と同型・ビーコン方式）。
// tarball → 使い捨て vite 消費アプリ → 実ビルド → encode/decode 往復＋名前規約＋PNG生成まで実通し。
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import os from "node:os";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5248, CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = { ".js": "text/javascript", ".html": "text/html", ".wasm": "application/wasm" };
const fail = msg => { console.error(`✗ ${msg}`); process.exit(1); };

console.log("… npm pack");
const packOut = execFileSync("npm", ["pack", "--json"], { cwd: PKG, encoding: "utf8" });
const tarName = [...packOut.matchAll(/"filename":\s*"([^"]+)"/g)].at(-1)?.[1];
if (!tarName) fail("npm pack の出力から filename を特定できない");
const tarball = path.join(PKG, tarName);

const WORK = path.join(os.tmpdir(), `altpbf-npm-verify-${process.pid}`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
writeFileSync(path.join(WORK, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
writeFileSync(path.join(WORK, "index.html"), `<!doctype html><meta charset="utf-8"><title>booting</title><script type="module" src="/main.js"></script>`);
writeFileSync(path.join(WORK, "main.js"), `
window.onerror = (m, s, l) => fetch("/__result?t=" + encodeURIComponent("FAIL onerror " + m)).catch(() => {});
(async () => {
	let title;
	try {
		const { encode, decode, encodeName, decodeName, altpbf2png } = await import("altpbf");
		const W = 8, H = 8;
		const data = new Int16Array(W * H).map((_, i) => 100 + ((i * 7) % 50) - 25);   // 起伏のある小グリッド
		const name = encodeName(139, 35, 1);
		const bin = await encode({ name, source: "test", lng: 139, lat: 35, range: 1, width: W, height: H, data });
		const tile = await decode(new Blob([bin]));
		const same = tile.width === W && tile.height === H && tile.name === "R01N035E139"
			&& tile.data.length === data.length && tile.data.every((v, i) => v === data[i]);
		const [lng2, lat2, r2] = decodeName(name);
		const png = await altpbf2png(new Blob([bin]), { size: 32 });
		const ok = same && lng2 === 139 && lat2 === 35 && r2 === 1 && png?.type === "image/png" && png.size > 100;
		title = ok ? "PASS altpbf-npm" : \`FAIL same=\${same} name=\${name} png=\${png?.size}\`;
	} catch (e) { title = "FAIL " + (e?.message || e); }
	fetch("/__result?t=" + encodeURIComponent(title)).catch(() => {});
})();
`);
console.log("… npm install（tarball＋vite）");
execFileSync("npm", ["install", tarball, "vite@^5", "--no-audit", "--no-fund", "--silent"], { cwd: WORK, stdio: "inherit" });
console.log("… vite build（消費者バンドラ実通し）");
execFileSync("npx", ["vite", "build", "--logLevel", "warn"], { cwd: WORK, stdio: "inherit" });

const read = promisify(readFile);
const DIST = path.join(WORK, "dist");
let result = null;
const server = createServer(async (req, res) => {
	const u = new URL(req.url, "http://x");
	if (u.pathname === "/__result") { result = u.searchParams.get("t") || "(空)"; res.writeHead(204); res.end(); return; }
	const file = path.join(DIST, u.pathname === "/" ? "index.html" : u.pathname);
	try { const body = await read(file);
		res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
		res.end(body);
	} catch { res.writeHead(404); res.end("nf"); }
}).listen(PORT);

const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=/tmp/altpbf-npm-${process.pid}`, "--remote-debugging-port=0",
	"--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `http://localhost:${PORT}/`], { stdio: "ignore" });
process.on("exit", () => { chrome.kill(); server.close(); });
const t0 = Date.now();
while (!result && Date.now() - t0 < 60000) await sleep(500);
chrome.kill(); server.close();
if (result !== "PASS altpbf-npm") { console.error(`  現場保存: ${WORK}`); fail(`消費者実走: ${result || "60秒ビーコン無し"}`); }
rmSync(WORK, { recursive: true, force: true });
console.log("ok:consumer（tarball→vite build→encode/decode往復→名前規約→PNG生成 実通し）");
console.log("✓ altpbf npm 配布物の検定PASS");
