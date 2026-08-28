#!/usr/bin/env node
// geopbf npm 配布物の検定＝publish の必須ゲート。ortho-japan と違い**ソース配布**なので、
// 「npm pack の tarball → 使い捨て vite 消費アプリに install → 実ビルド → GeoJSON→gint 実変換」まで通す。
// worker（動的import持ち）と WASM が**消費者のバンドラ通過後**に生きているか＝ここでしか分からない
// （devは動くが本番だけ死ぬ族・base:"/"事故と同クラスの最後の砦）。
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5247, CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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
writeFileSync(path.join(WORK, "vite.config.js"), `export default { worker: { format: "es" } };\n`);
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
		const ok = !!g && g.polygonCount === 2 && hit != null && rt === 2 && mlOk && lfOk && olOk && ldOk && glOk;
		document.title = ok ? "PASS geopbf-npm" : \`FAIL polygons=\${g?.polygonCount} hit=\${hit} rt=\${rt} ml=\${mlOk} lf=\${lfOk} ol=\${olOk} ld=\${ldOk} gl=\${glOk}\`;
	} catch (e) { document.title = "FAIL " + (e?.message || e); }
	fetch("/__result?t=" + encodeURIComponent(document.title)).catch(() => {});   // 検定サーバへ自己申告（実時間ビーコン）
})();
setTimeout(() => fetch("/__result?t=" + encodeURIComponent(document.title)).catch(() => {}), 45000);   // ハング時も現状を申告
`);
console.log("… npm install（tarball＋vite）");
execFileSync("npm", ["install", tarball, "vite@^5", "--no-audit", "--no-fund", "--silent"], { cwd: WORK, stdio: "inherit" });
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

const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=/tmp/geopbf-npm-${process.pid}`, "--remote-debugging-port=0",
	"--disable-gpu", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `http://localhost:${PORT}/`], { stdio: "ignore" });
process.on("exit", () => { chrome.kill(); server.close(); });
const { setTimeout: sleep } = await import("node:timers/promises");
const t0 = Date.now();
while (!result && Date.now() - t0 < 60000) await sleep(500);
chrome.kill(); server.close();
if (result !== "PASS geopbf-npm") { console.error(`  現場保存: ${WORK}`); fail(`消費者実走: ${result || "60秒ビーコン無し（ページが起動していない疑い）"}`); }
rmSync(WORK, { recursive: true, force: true });
console.log(`ok:consumer（tarball→vite build→FC変換→gint焼き(worker+WASM)→identify 実通し）`);
console.log("✓ geopbf npm 配布物の検定PASS");
