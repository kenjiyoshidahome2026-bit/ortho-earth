#!/usr/bin/env node
// verify-convert-gpu: tests/t-convert-gpu.html を Playwright の Chromium で走らせ、CPU/GPU の bit 一致を数字で確かめる。
// GPU 無しの環境でも Chromium 同梱の SwiftShader（Vulkan ソフトウェア実装）で WebGPU が立つ＝CI で回せる。
// 使い方: node scripts/verify-convert-gpu.mjs [--show]                      … カーネルの bit 一致ゲート
//         node scripts/verify-convert-gpu.mjs --bench <dir> <name> [--maxzoom N] … <dir>/<name>.geopbf + .gint で GPU/CPU の実測と出力一致
// （playwright は devDependency ではなく、グローバル/近傍から解決）
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

const root = new URL("../", import.meta.url).pathname;
const req = createRequire(import.meta.url);
let pw = null;
for (const c of ["playwright", "playwright-core", "/opt/node22/lib/node_modules/playwright/index.mjs", "/usr/lib/node_modules/playwright/index.mjs"]) {
	try { const m = await import(c.startsWith("/") ? c : req.resolve(c)); pw = m.chromium ? m : m.default; if (pw?.chromium) break; pw = null; } catch {}
}
if (!pw) { console.error("playwright が見つからない（npm i -g playwright）"); process.exit(2); }

const bi = process.argv.indexOf("--bench");
const bench = bi > 0 ? { dir: path.resolve(process.argv[bi + 1]), name: process.argv[bi + 2], maxzoom: process.argv.includes("--maxzoom") ? process.argv[process.argv.indexOf("--maxzoom") + 1] : "8",
	extra: (process.argv.includes("--nogzip") ? "&nogzip=1" : "") + (process.argv.includes("--workers") ? "&workers=" + process.argv[process.argv.indexOf("--workers") + 1] : "") } : null;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
const srv = http.createServer(async (q, s) => {
	try {
		const u = decodeURIComponent(q.url.split("?")[0]);
		const p = bench && u.startsWith("/data/") ? path.join(bench.dir, u.slice(6)) : path.join(root, u);
		const body = await readFile(p);
		s.setHeader("content-type", MIME[path.extname(p)] || "application/octet-stream");
		s.end(body);
	} catch { s.statusCode = 404; s.end("nf"); }
}).listen(0);
const port = srv.address().port;

// Chromium 実体: $CHROMIUM_PATH → playwright 自身の既定（`npx playwright install chromium` 済み）→ /opt/pw-browsers の任意版
const pwExe = (() => { try { return pw.chromium.executablePath(); } catch { return null; } })();
const optExe = (() => { try { const { readdirSync } = req("node:fs"); const base = "/opt/pw-browsers"; if (existsSync(base + "/chromium") && !req("node:fs").statSync(base + "/chromium").isDirectory()) return base + "/chromium"; for (const d of readdirSync(base)) for (const sub of ["chrome-linux/chrome", "chrome-linux64/chrome"]) { const p = `${base}/${d}/${sub}`; if (d.startsWith("chromium") && existsSync(p)) return p; } } catch {} return null; })();
const exe = [process.env.CHROMIUM_PATH, pwExe, optExe].find(p => p && existsSync(p));
const browser = await pw.chromium.launch({
	headless: !process.argv.includes("--show"),
	...(exe ? { executablePath: exe } : {}),
	ignoreDefaultArgs: ["--headless"],
	args: ["--headless=new", "--no-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan", "--use-vulkan=swiftshader", "--enable-unsafe-swiftshader", "--use-webgpu-adapter=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
console.log(`chromium ${browser.version()} (${exe ?? "playwright default"})`);

page.on("console", m => { if (m.type() === "error" && !/404/.test(m.text())) console.error("[page]", m.text()); else if (bench && m.text().startsWith("[bench]")) console.log(m.text()); });
page.on("pageerror", e => console.error("[pageerror]", e.message));
await page.goto(bench ? `http://localhost:${port}/tests/t-convert-bench.html?data=${encodeURIComponent(bench.name)}&maxzoom=${bench.maxzoom}${bench.extra}` : `http://localhost:${port}/tests/t-convert-gpu.html`);
// WebGPU が立たない時の切り分け（CI 用）：navigator.gpu の有無・通常/fallback adapter の応答
const diag = await page.evaluate(async () => { if (!navigator.gpu) return "navigator.gpu なし"; const a = await navigator.gpu.requestAdapter().catch(e => "err:" + e.message); const f = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }).catch(e => "err:" + e.message); const info = (x) => x && typeof x === "object" ? JSON.stringify({ vendor: x.info?.vendor, arch: x.info?.architecture, fallback: x.isFallbackAdapter }) : String(x); return `adapter ${info(a)} / fallback ${info(f)}`; });
console.log("webgpu:", diag);
await page.waitForFunction(() => window.__result, null, { timeout: 1800000 });
const r = await page.evaluate(() => window.__result);
await browser.close(); srv.close();
console.log(r.lines.join("\n"));
if (bench) { const bad = r.error || r.same === false || r.parquetSame === false; console.log(bad ? "\n✗ 不一致/エラー" : "\n出力一致"); process.exit(bad ? 1 : 0); }
console.log(r.fails ? `\n${r.fails} 件失敗` : `\n全件通過（${(r.ms | 0)} ms・${JSON.stringify(r.info || null)}）`);
process.exit(r.fails ? 1 : 0);
