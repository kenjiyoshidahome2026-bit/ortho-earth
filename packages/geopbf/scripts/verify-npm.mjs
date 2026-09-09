#!/usr/bin/env node
// geopbf npm 配布物の検定＝publish の必須ゲート。ortho-japan と違い**ソース配布**なので、
// 「npm pack の tarball → 使い捨て vite 消費アプリに install → 実ビルド → GeoJSON→gint 実変換」まで通す。
// worker（動的import持ち）と WASM が**消費者のバンドラ通過後**に生きているか＝ここでしか分からない
// （devは動くが本番だけ死ぬ族・base:"/"事故と同クラスの最後の砦）。
// **build と dev の両方**で同じ main.js を実走させる。dev は本番ビルドと解決経路が別物で、片方だけ割れる型が
// 実在する＝1.5.0 は「ライブラリ内の裸の `import("webgpu")` を vite の dev だけが静的解決しに行って 500」で
// この関門（当時 build のみ）を素通りして世に出た。以後 dev 段が門番。
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5247, DEVPORT = 5248;
// Chromium: $CHROME → Playwright の Chromium（devDependency・CI は `npx playwright install chromium`）→ Mac の Chrome
const CHROME = process.env.CHROME || await (async () => {
	try { const { chromium } = await import("playwright"); const p = chromium.executablePath(); if (p && (await import("node:fs")).existsSync(p)) return p; } catch {}
	const fs = await import("node:fs");
	try { if (fs.existsSync("/opt/pw-browsers/chromium") && !fs.statSync("/opt/pw-browsers/chromium").isDirectory()) return "/opt/pw-browsers/chromium"; } catch {}
	try { for (const d of fs.readdirSync("/opt/pw-browsers")) for (const sub of ["chrome-linux/chrome", "chrome-linux64/chrome"]) { const p = `/opt/pw-browsers/${d}/${sub}`; if (d.startsWith("chromium") && fs.existsSync(p)) return p; } } catch {}
	for (const p of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) if (fs.existsSync(p)) return p;
	return "google-chrome";
})();
const { setTimeout: sleep } = await import("node:timers/promises");
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".wasm": "application/wasm", ".json": "application/json" };
const fail = msg => { console.error(`✗ ${msg}`); process.exit(1); };

console.log("… npm pack");
const packOut = execFileSync("npm", ["pack", "--json"], { cwd: PKG, encoding: "utf8" });
const tarName = [...packOut.matchAll(/"filename":\s*"([^"]+)"/g)].at(-1)?.[1];
if (!tarName) fail("npm pack の出力から filename を特定できない");
const tarball = path.join(PKG, tarName);

// 使い捨て消費アプリ（README の作法どおり＝worker.format:"es" だけ設定した素の vite）
const WORK = path.join(os.tmpdir(), `geopbf-npm-verify-${process.pid}`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
writeFileSync(path.join(WORK, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
writeFileSync(path.join(WORK, "vite.config.js"), `
import { writeFileSync } from "node:fs";
// dev 段のビーコン受け＝ページは同一オリジンの /__result へ自己申告する（build 段は検定側の静的サーバが受ける）。
// 結果はファイルへ落とす＝vite は別プロセスで、検定スクリプトへ直接返せないため。
const beacon = {
	name: "result-beacon",
	configureServer(server) {
		server.middlewares.use((req, res, next) => {
			if (!req.url || !req.url.startsWith("/__result")) return next();
			const t = new URL(req.url, "http://x").searchParams.get("t") || "(空)";
			try { writeFileSync(process.env.GEOPBF_RESULT_FILE, t); } catch { /* 検定側が拾えなければタイムアウトで落ちる */ }
			res.statusCode = 204; res.end();
		});
	},
};
export default { worker: { format: "es" }, plugins: [beacon] };
`);
writeFileSync(path.join(WORK, "index.html"), `<!doctype html><meta charset="utf-8"><title>booting</title><script type="module" src="/main.js"></script>`);
writeFileSync(path.join(WORK, "main.js"), `
// エラーは全てタイトルへ露出（headless dump-dom はタイトルしか読めない）
window.onerror = (m, s, l) => { if (!document.title.startsWith("PASS")) document.title = "FAIL onerror " + m + " @" + (s || "").split("/").pop() + ":" + l; };
window.onunhandledrejection = e => { if (!document.title.startsWith("PASS")) document.title = "FAIL reject " + (e.reason?.message || e.reason); };
const sq = x => ({ type: "Feature", properties: { n: x }, geometry: { type: "Polygon",
	coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] } });
(async () => {
	try {
		const { createGeopbf } = await import("geopbf");   // 動的import＝ロード失敗も catch に落とす
		const geopbf = createGeopbf();   // 注入なし＝plain provider（npm 単体利用の素の形）
		const pbf = await geopbf({ type: "FeatureCollection", name: "t", features: [sq(0), sq(1)] }, { gint: true, name: "t" });
		const g = pbf.unPackGint;
		const hit = pbf.contain([0.5, 0.5]);
		const rt = pbf.geojson.features.length;
		// maplibre サブパス（exports "./maplibre"）がバンドラ通過後も解決・実行できるか
		const ml = await import("geopbf/maplibre");
		const mlOk = typeof ml.geopbfProtocol === "function" && typeof ml.loadGeopbf === "function"
			&& ml.sanitizeProperties({ d: new Date(0) }).d === "1970-01-01T00:00:00.000Z";
		// leaflet サブパス（exports "./leaflet"）: leaflet 非依存なのでフェイク L で登録まで実走
		const lf = await import("geopbf/leaflet");
		class FakeGJ { initialize() {} }
		FakeGJ.extend = function (p) { class S extends this { constructor(...a) { super(); this.initialize(...a); } } Object.assign(S.prototype, p); return S; };
		const fakeL = { GeoJSON: FakeGJ };
		const lfOk = typeof lf.extendLeaflet === "function" && lf.extendLeaflet(fakeL) === fakeL && typeof fakeL.geoPBF === "function";
		// openlayers / loaders サブパス: 依存ゼロなので解決＋入口の型まで
		const olm = await import("geopbf/openlayers");
		const olOk = typeof olm.makeGeopbfLoader === "function"
			&& typeof olm.makeGeopbfLoader("geopbf://x", { readFeatures: () => [] }) === "function";
		const ld = await import("geopbf/loaders");
		const ldOk = ld.GeoPBFLoader?.id === "geopbf" && typeof ld.GeoPBFLoader.parse === "function";
		// 汎用ローダ（Cesium/D3 レシピの入口）
		const gl = await import("geopbf/load");
		const glOk = typeof gl.loadGeopbf === "function" && typeof gl.decodeToGeojson === "function";
		// PMTiles / GeoParquet（exports "./pmtiles" "./geoparquet"）: tile-worker（new Worker(new URL(...))）がバンドラ通過後も
		// 立ち、gint → MVT → PMTiles と WKB → Parquet が実走するか。GPU は問わない（CPU 経路で同じ出力）
		const { toPMTiles } = await import("geopbf/pmtiles");
		const { toGeoParquet } = await import("geopbf/geoparquet");
		const pm = await toPMTiles(pbf, { maxZoom: 4, gpu: false, workers: 2 });
		const pq = await toGeoParquet(pbf, { gpu: false, codec: "none" });
		const pmOk = pm.stats.workers === 2 && pm.stats.tiles > 4 && pm.buffer.length > 127 && pm.buffer[0] === 0x50 && pm.buffer[1] === 0x4d;   // "PM"
		const pqOk = pq.buffer.length > 8 && pq.buffer[0] === 0x50 && pq.buffer[1] === 0x41 && pq.buffer[2] === 0x52 && pq.buffer[3] === 0x31;   // "PAR1"
		const ok = !!g && g.polygonCount === 2 && hit != null && rt === 2 && mlOk && lfOk && olOk && ldOk && glOk && pmOk && pqOk;
		document.title = ok ? "PASS geopbf-npm" : \`FAIL polygons=\${g?.polygonCount} hit=\${hit} rt=\${rt} ml=\${mlOk} lf=\${lfOk} ol=\${olOk} ld=\${ldOk} gl=\${glOk} pm=\${pmOk}(\${pm.stats.workers}w/\${pm.stats.tiles}t) pq=\${pqOk}\`;
	} catch (e) { document.title = "FAIL " + (e?.message || e); }
	fetch("/__result?t=" + encodeURIComponent(document.title)).catch(() => {});   // 検定サーバへ自己申告（実時間ビーコン）
})();
setTimeout(() => fetch("/__result?t=" + encodeURIComponent(document.title)).catch(() => {}), 45000);   // ハング時も現状を申告
`);
console.log("… npm install（tarball＋vite）");
execFileSync("npm", ["install", tarball, "vite@^8", "--no-audit", "--no-fund", "--silent"], { cwd: WORK, stdio: "inherit" });
console.log("… vite dev（消費者 dev サーバ実通し）");
{
	const RESULT = path.join(WORK, "__result.txt");
	const dev = spawn("npx", ["vite", "--port", String(DEVPORT), "--strictPort", "--logLevel", "warn"],
		{ cwd: WORK, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, GEOPBF_RESULT_FILE: RESULT } });
	let chrome = null;
	const stop = () => { try { chrome?.kill(); } catch {} try { dev.kill(); } catch {} };
	process.on("exit", stop);
	try {
		for (let i = 0; ; i++) {   // dev サーバの起動待ち（先に Chrome を出すと空振りする）
			try { if ((await fetch(`http://localhost:${DEVPORT}/`)).ok) break; } catch { /* まだ */ }
			if (i > 160) throw new Error("vite dev が起動しない（port が塞がっている？）");
			await sleep(250);
		}
		chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", `--user-data-dir=/tmp/geopbf-npm-dev-${process.pid}`,
			"--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `http://localhost:${DEVPORT}/`], { stdio: "ignore" });
		const t0 = Date.now();   // 事前バンドル（optimizeDeps）が走る分だけ build 段より気長に待つ
		while (!existsSync(RESULT) && Date.now() - t0 < 90000) await sleep(500);
		const got = existsSync(RESULT) ? readFileSync(RESULT, "utf8") : null;
		if (got !== "PASS geopbf-npm") { console.error(`  現場保存: ${WORK}`); fail(`消費者 dev 実走: ${got || "90秒ビーコン無し（dev で解決に失敗している疑い＝上の vite ログを見る）"}`); }
	} finally { stop(); }
	console.log("ok:dev（vite dev サーバでの解決＝subpath 全口・worker・WASM）");
}
console.log("… vite build（消費者バンドラ実通し）");
execFileSync("npx", ["vite", "build", "--logLevel", "warn"], { cwd: WORK, stdio: "inherit" });

// dist を静的配信し、実時間の headless で実走。結果はページからの**ビーコン**（/__result）で受ける
// ＝虚時間(dump-dom)は worker+WASM の実計算を待たずに幕を下ろす型のため使わない（2026-08-21実測）。
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

const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", `--user-data-dir=/tmp/geopbf-npm-${process.pid}`, "--remote-debugging-port=0",
	"--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `http://localhost:${PORT}/`], { stdio: "ignore" });
process.on("exit", () => { chrome.kill(); server.close(); });
const t0 = Date.now();
while (!result && Date.now() - t0 < 60000) await sleep(500);
chrome.kill(); server.close();
if (result !== "PASS geopbf-npm") { console.error(`  現場保存: ${WORK}`); fail(`消費者実走: ${result || "60秒ビーコン無し（ページが起動していない疑い）"}`); }
rmSync(WORK, { recursive: true, force: true });
console.log(`ok:build（tarball→vite build→FC変換→gint焼き(worker+WASM)→identify→PMTiles(tile-worker)→GeoParquet 実通し）`);
console.log("✓ geopbf npm 配布物の検定PASS");
