#!/usr/bin/env node
// ortho-globe 本番出荷物の検定＝deploy の必須ゲート（world・japan の verify-prod と同型）。
//   dist/site を素の静的サーバで配る（本番の deploy-worker と同じ COOP/COEP・/globe/quakes → quakes.html）＝出荷物そのものを食う。
//   /globe/ の外（データのミラー /quakes/・/sats/、往復の相手 /equal/、ルートの favicon 等）は本番へ中継する＝同一オリジンの形のまま。
// 検査項目:
//   ① 静的: 束に japan の SDK（/japan/lib/）と地域の申告（地理院の URL・3DBAG）が混ざっていない＝この家は地域を持たない
//   ② 実走: 3 頁が起動する（/globe/・/globe/?start=equal・/globe/quakes・/globe/sats）＝地球儀が立ち、地震・衛星はデータが載る
//   ③ 住所: 実行中の要求が /japan/ に一度も行かない（worker の要求も含む＝このサーバの受付簿で見る）
//   ④ コンソール: 自分のオリジンの例外/error ゼロ
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE = path.join(APP, "dist/site"), UPSTREAM = "https://www.ortho-earth.com";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".geopbf": "application/octet-stream" };
const COI = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = msg => { console.error(`✗ ${msg}`); bye(1); };
let chrome = null, server = null;
const bye = code => { try { chrome && process.kill(-chrome.pid); } catch { chrome?.kill(); } server?.close(); process.exit(code); };

// ① 静的
if (!fs.existsSync(path.join(SITE, "globe/index.html"))) fail("dist/site/globe が無い（先に npm run build）");
{
	const bad = [];
	const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html)$/.test(e.name)) { const s = fs.readFileSync(p, "utf8"); for (const pat of ["/japan/lib/", "ortho-japan.js", "cyberjapandata.gsi.go.jp", "3dbag.nl"]) if (s.includes(pat)) bad.push(`${path.relative(SITE, p)}: ${pat}`); } } };
	walk(path.join(SITE, "globe"));
	if (bad.length) fail(`static: 地域／japan の物が束に混ざっている\n  ${bad.join("\n  ")}`);
	console.log("ok:static（japan の SDK・地域の申告なし）");
}

// 配る（本番の deploy-worker と同じ規則）＋ /globe/ の外は本番へ中継
const seen = [];
server = createServer(async (req, res) => {
	const u = new URL(req.url, "http://x"), p = decodeURIComponent(u.pathname);
	seen.push(p);
	try {
		if (p === "/globe") { res.writeHead(301, { Location: "/globe/" + u.search }); return res.end(); }
		if (p.startsWith("/globe/")) {
			let f = path.join(SITE, p);
			if (p.endsWith("/")) f = path.join(f, "index.html");
			else if (!fs.existsSync(f) && fs.existsSync(f + ".html")) f += ".html";
			if (!f.startsWith(SITE) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404, COI); return res.end(); }
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
	{ name: "globe?start=equal", url: "/globe/?start=equal", ready: `${BOOTED} && !!document.querySelector('iframe[src*="/equal/"]')`, ms: 60000 },
	{ name: "quakes", url: "/globe/quakes", ready: `${BOOTED} && window.__quakes && window.__quakes.count > 1000`, ms: 120000 },
	{ name: "sats", url: "/globe/sats", ready: `${BOOTED} && window.__sats && window.__sats.count > 1000`, ms: 60000 },
];
for (const pg of PAGES.filter(x => !process.env.ONLY || x.name === process.env.ONLY)) {
	const p = await open(ORIGIN + pg.url);
	const ok = await p.until(pg.ready, pg.ms);
	const n = await p.ev(`window.__quakes?.count ?? window.__sats?.count ?? null`);
	if (!ok) {
		const st = await p.ev(`JSON.stringify({ canvas: !!document.querySelector("#map canvas"), boot: document.querySelector("#boot")?.className ?? "removed", iframes: [...document.querySelectorAll("iframe")].map(f => f.getAttribute("src") || f.src || "(no src)"), data: window.__quakes?.count ?? window.__sats?.count ?? null })`);
		console.error(`  state: ${st}\n  errors: ${p.errs.slice(0, 5).join(" | ") || "none"}`); fail(`run: ${pg.name} が起動しない（${pg.ms / 1000}s）`);
	}
	await sleep(1500);   // 起動直後の遅れた error も拾う
	// ④
	if (p.errs.length) fail(`console: ${pg.name} で例外/error ${p.errs.length} 件\n  ${[...new Set(p.errs)].slice(0, 6).join("\n  ")}`);
	console.log(`ok:run（${pg.name}${n != null ? `・${n} 件` : ""}）`);
	p.close();
}
// ③ 住所
const japan = [...new Set(seen.filter(p => p.startsWith("/japan")))];
if (japan.length) fail(`address: /japan/ への要求がある\n  ${japan.slice(0, 8).join("\n  ")}`);
console.log(`ok:address（/japan/ への要求ゼロ・受付 ${seen.length} 件）`);
console.log("✓ ortho-globe 本番出荷物の検定 PASS");
bye(0);
