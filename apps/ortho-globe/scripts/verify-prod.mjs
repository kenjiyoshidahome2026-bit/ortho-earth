#!/usr/bin/env node
// ortho-globe 本番出荷物の検定＝deploy の必須ゲート（world・japan の verify-prod と同型）。
//   dist/site を素の静的サーバで配る（本番の deploy-worker と同じ COOP/COEP・/globe/sats → sats.html）＝出荷物そのものを食う。
//   /globe/ の外（データのミラー /quakes/・/sats/、往復の相手 /equal/、ルートの favicon 等）は本番へ中継する＝同一オリジンの形のまま。
// 検査項目:
//   ① 静的: 束に japan の SDK（/japan/lib/）と地域の申告（地理院の URL・3DBAG）が混ざっていない＝この家は地域を持たない（共有エンジン globe/engine/ は除く＝③ で読んだ物を見る）
//   ② 実走: 9 頁が起動する（/globe/・/globe/?start=equal・/globe/sats・/globe/clouds・/globe/physical・/globe/clock・/globe/hex・/globe/arcs・/globe/splat）＝地球儀が立ち、衛星・雲・地形・人口はデータが載る（世界の地震は 2026-10-15 に apps/quakes へ独立＝そちらの verify-prod）
//   ③ 住所: 実行中の要求が /japan/ に一度も行かない・共有エンジンから読んだファイルに地域の物が無い（worker の要求も含む＝このサーバの受付簿で見る）
//   ④ コンソール: 自分のオリジンの例外/error ゼロ
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChrome } from "@ortho-earth/globe/scripts/lib/chrome.mjs";   // 検定専用の Chrome for Testing（普段の Chrome とぶつからない・2026-09-30）

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE = path.join(APP, "dist/site"), UPSTREAM = "https://www.ortho-earth.com";
const CHROME = await resolveChrome();
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".geopbf": "application/octet-stream" };
const COI = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = msg => { console.error(`✗ ${msg}`); bye(1); };
let chrome = null, server = null;
const bye = code => { try { chrome && process.kill(-chrome.pid); } catch { chrome?.kill(); } server?.close(); process.exit(code); };

// ① 静的
const REGION = ["/japan/lib/", "ortho-japan.js", "cyberjapandata.gsi.go.jp", "3dbag.nl", "api.pdok.nl"];
const regionIn = file => { const s = fs.readFileSync(file, "utf8"); return REGION.find(pat => s.includes(pat)); };
// 共有エンジン＝独立のデプロイ単位 apps/engine（2026-10-15〜）＝この家の dist には無い＝/globe/engine/ はエンジンの手元の置き場を同じ住所で配る（本番と同じ形）
import { ENGINE_DIR } from "@ortho-earth/globe/scripts/lib/shared-engine.mjs";
const engineFile = p => path.join(ENGINE_DIR, p.slice("/globe/engine/".length));
if (!fs.existsSync(path.join(SITE, "globe/index.html"))) fail("dist/site/globe が無い（先に npm run build）");
{
	const bad = [];
	// 共有エンジンはこの dist に無い（jp・nl の入口も配る全アプリの共有物＝地域の物が居て正しい）。globe の頁がそれを読まないことは ③ で見る（実際に取りに行ったエンジンのファイルに地域の物が居ないか）
	const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html)$/.test(e.name)) { const hit = regionIn(p); if (hit) bad.push(`${path.relative(SITE, p)}: ${hit}`); } } };
	walk(path.join(SITE, "globe"));
	if (bad.length) fail(`static: 地域／japan の物が束に混ざっている\n  ${bad.join("\n  ")}`);
	// 束の中に生の .ts が居ない（SDK の plugin の描き手 new URL("./splat-draw.js", import.meta.url) を vite が資産と見て .ts のまま写した事故＝worker の import() が
	// 読めない・2026-10-21）。アプリの束で実体のチャンクにするのは vite-app.mjs の moduleUrlAsChunk
	const raw = []; const walkTs = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkTs(p); else if (/\.(ts|tsx|mts)$/.test(e.name)) raw.push(path.relative(SITE, p)); } };
	walkTs(path.join(SITE, "globe"));
	if (raw.length) fail(`static: 生の TypeScript が束に出ている（vite が資産扱い＝worker が import() できない）\n  ${raw.join("\n  ")}`);
	console.log("ok:static（japan の SDK・地域の申告なし・生の .ts なし）");
}

// 配る（本番の deploy-worker と同じ規則）＋ /globe/ の外は本番へ中継
const seen = [];
server = createServer(async (req, res) => {
	const u = new URL(req.url, "http://x"), p = decodeURIComponent(u.pathname);
	seen.push(p);
	try {
		if (p === "/globe") { res.writeHead(301, { Location: "/globe/" + u.search }); return res.end(); }
		if (p.startsWith("/globe/")) {
			let f = p.startsWith("/globe/engine/") ? engineFile(p) : path.join(SITE, p);
			if (p.endsWith("/")) f = path.join(f, "index.html");
			// 拡張子なし＝<名前>.html（本番の Workers assets と同じ）。同名のフォルダがあっても .html が勝つ
			else if ((!fs.existsSync(f) || fs.statSync(f).isDirectory()) && fs.existsSync(f + ".html")) f += ".html";
			if (!(f.startsWith(SITE) || f.startsWith(ENGINE_DIR)) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404, COI); return res.end(); }
			res.writeHead(200, { ...COI, "Content-Type": MIME[path.extname(f)] || "application/octet-stream" });
			return fs.createReadStream(f).pipe(res);
		}
		const up = await fetch(UPSTREAM + req.url, { headers: { "Accept-Encoding": "identity" } });
		const h = { ...COI, "Content-Type": up.headers.get("content-type") || "application/octet-stream" };
		res.writeHead(up.status, h);
		res.end(Buffer.from(await up.arrayBuffer()));
	} catch (e) { res.writeHead(502, COI); res.end(String(e)); }
});
const port = await new Promise(r => server.listen(0, "127.0.0.1", () => r(server.address().port)));
// 名前＝localhost 以外（equal の口は localhost だと dev の :5198 を指す＝本番の /equal/ を通したい）。127.0.0.1 へ向け、安全なオリジン扱い（WebGPU・COI が立つ）
const HOST = "globe.test", ORIGIN = `http://${HOST}:${port}`;

// Chrome（headless・WebGPU は swiftshader＋Vulkan で立つ）
const cport = await new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${cport}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "globe-verify-"))}`, "--no-first-run",
	`--host-resolver-rules=MAP ${HOST} 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`,
	"--enable-unsafe-swiftshader", "--enable-features=Vulkan", "about:blank"], { stdio: "ignore", detached: true });
for (let i = 0; i < 80; i++) { await sleep(250); if (await fetch(`http://127.0.0.1:${cport}/json/version`).then(r => r.ok, () => false)) break; }

async function open(url) {
	const t = await fetch(`http://127.0.0.1:${cport}/json/new?about:blank`, { method: "PUT" }).then(r => r.json());
	const ws = new WebSocket(t.webSocketDebuggerUrl);
	await new Promise(r => ws.addEventListener("open", r, { once: true }));
	let id = 0; const pend = new Map(), errs = [];
	ws.addEventListener("message", e => {
		const m = JSON.parse(e.data);
		if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
		if (m.method === "Runtime.exceptionThrown") errs.push("exception: " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split("\n")[0]);
		if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push("console.error: " + m.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 200));
	});
	const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
	await send("Page.enable"); await send("Runtime.enable");
	await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	await send("Page.navigate", { url });
	const ev = async expr => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
	const until = async (expr, ms) => { for (let t = 0; t < ms; t += 250) { if (await ev(expr)) return true; await sleep(250); } return false; };
	return { ev, until, errs, close: () => { send("Page.close"); ws.close(); } };
}

// ② 実走（各頁＝地球儀が立つ・データが載る）
const BOOTED = `!!document.querySelector('#map canvas') && !document.querySelector('#boot:not(.gone)')`;
const PAGES = [
	{ name: "globe", url: "/globe/", ready: BOOTED, ms: 45000 },
	// Equal Earth は同じ頁の div（#equal-frame）に組む（PR #218・2026-10-04）＝重なり切る（opacity 1＝最初の 1 枚が描けた）まで待つ。load が無い頁は旧来の iframe
	{ name: "globe?start=equal", url: "/globe/?start=equal", ready: `${BOOTED} && (() => { const f = document.querySelector('#equal-frame'); return !!f && (f.tagName === 'IFRAME' ? f.src.includes('/equal/') : !!f.querySelector('canvas') && f.style.opacity === '1'); })()`, ms: 60000 },
	{ name: "sats", url: "/globe/sats", ready: `${BOOTED} && window.__sats && window.__sats.count > 1000`, ms: 60000 },
	{ name: "arcs", url: "/globe/arcs", ready: `${BOOTED} && window.__arcs && window.__arcs.capitals.length > 150 && window.__arcs.count > 150`, ms: 60000 },   // 弧＝首都（world の台帳）へ弧が伸びた
	{ name: "clouds", url: "/globe/clouds", ready: `${BOOTED} && window.__clouds && window.__clouds.loaded`, ms: 240000 },   // 雲＝GIBS と EUMETView を直読みして全タイルを読み終える。GIBS の応答が夜に 9 秒級まで揺れる（2026-10-12 に 120s で 2 回落ち・3 回目 54s）＝上限 240s
	// 地形＝GitHub Pages（ortho-data/globe/）の TerrainDB・ne-physical.geopbf（npm run publish:pages -w world-data で置いてから）。物理量（流量など）が載った版かも見る
	{ name: "physical", url: "/globe/physical", ready: `${BOOTED} && window.__physical && window.__physical.items.length > 900 && window.__physical.shapes.length > 1000 && window.__physical.items.some(d => d.discharge > 0)`, ms: 60000 },
	// 世界時計＝NE の時間帯の面（S3 直読み）と admin0 が載り、東京が Asia/Tokyo・アンカラが Europe/Istanbul（NE の面は +2 のまま＝国が勝つ）に決まる
	{ name: "clock", url: "/globe/clock", ready: `${BOOTED} && window.__clock && window.__clock.at([139.7, 35.7]).resolved.tz === "Asia/Tokyo" && window.__clock.at([32.85, 39.93]).resolved.tz === "Europe/Istanbul"`, ms: 90000 },
	// 人口の六角形＝GitHub Pages の ortho-data/globe/h3/kontur-20231101/（scripts/kontur-h3.mjs → publish-pages.mjs）。全景で解像度 3 の柱が 1 万本以上立つ
	{ name: "hex", url: "/globe/hex", ready: `${BOOTED} && window.__hex && window.__hex.cells > 10000`, ms: 90000 },
	// Gaussian splat＝GitHub Pages の ortho-data/globe/splat/（scripts/splat-tiles.mjs → publish-pages.mjs）。3D Tiles の根 2 枚（2 シーン）が読めて見えた（SPZ のタイルは plugin が解く＝stats.splats には乗らない・shown で見る）
	{ name: "splat", url: "/globe/splat", ready: `${BOOTED} && window.__splat && window.__splat.ready && window.__splat.tiles.shown >= 2`, ms: 120000 },
];
for (const pg of PAGES.filter(x => !process.env.ONLY || x.name === process.env.ONLY)) {
	const p = await open(ORIGIN + pg.url), t0 = Date.now();
	const ok = await p.until(pg.ready, pg.ms);
	const n = await p.ev(`window.__sats?.count ?? null`);
	if (!ok) {
		const st = await p.ev(`JSON.stringify({ canvas: !!document.querySelector("#map canvas"), boot: document.querySelector("#boot")?.className ?? "removed", iframes: [...document.querySelectorAll("iframe")].map(f => f.getAttribute("src") || f.src || "(no src)"), data: window.__sats?.count ?? null })`);
		console.error(`  state: ${st}\n  errors: ${p.errs.slice(0, 5).join(" | ") || "none"}`); fail(`run: ${pg.name} が起動しない（${pg.ms / 1000}s）`);
	}
	await sleep(1500);   // 起動直後の遅れた error も拾う
	// ④
	if (p.errs.length) fail(`console: ${pg.name} で例外/error ${p.errs.length} 件\n  ${[...new Set(p.errs)].slice(0, 6).join("\n  ")}`);
	console.log(`ok:run（${pg.name}${n != null ? `・${n} 件` : ""}・${((Date.now() - t0) / 1000).toFixed(0)}s）`);
	p.close();
}
// ③ 住所
const japan = [...new Set(seen.filter(p => p.startsWith("/japan")))];
if (japan.length) fail(`address: /japan/ への要求がある\n  ${japan.slice(0, 8).join("\n  ")}`);
// 共有エンジンから実際に読んだファイル＝地域の物（jp・nl の入口とその塊）が居ない＝globe の頁は地域を読まない（① で外した globe/engine/ の分）
const engineRegion = [...new Set(seen.filter(p => p.startsWith("/globe/engine/")))].map(p => [p, engineFile(p)])
	.filter(([, f]) => /\.(js|html)$/.test(f) && fs.existsSync(f)).map(([p, f]) => [p, regionIn(f)]).filter(([, hit]) => hit);
if (engineRegion.length) fail(`address: 共有エンジンの地域の物を読んでいる\n  ${engineRegion.slice(0, 8).map(([p, hit]) => `${p}: ${hit}`).join("\n  ")}`);
console.log(`ok:address（/japan/ への要求ゼロ・共有エンジンの地域の物も読まない・受付 ${seen.length} 件）`);
console.log("✓ ortho-globe 本番出荷物の検定 PASS");
bye(0);
