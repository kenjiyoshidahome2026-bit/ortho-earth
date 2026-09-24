#!/usr/bin/env node
// @ortho-earth/globe の npm 配布物の検定＝publish の必須ゲート（2026-09-25）。
// 「利用者と同じ道」を通す：core と globe をこの手元の中身で npm pack → 使い捨ての Vite アプリ（最新の vite）に install →
// Get Started の手順どおりの main.js（地球儀・自分の GeoJSON・マーカー・飛行）を **build と dev の両方**で実走させ、
// ページ自身が PASS/FAIL を申告する。
// 生まれた経緯：9/23 に出した 1.0.0 は利用者の手元で動かなかった（altpbf の非公開ローダを import・core の sideEffects:false で
// worker の入口が消える・訳の表が Vite 8 で束ねられない・dev の依存の事前束ね）＝モノレポの中の関門では一つも見えない族。
// 使い方：node packages/globe/scripts/verify-npm.mjs   （$CHROME で Chromium を指定できる）
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const GLOBE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.resolve(GLOBE, "../..");
const PORT = 5261, DEVPORT = 5262, CDP = 9361;
const CHROME = process.env.CHROME || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => existsSync(p)) || "google-chrome";
const fail = msg => { console.error(`✗ ${msg}`); cleanup(); process.exit(1); };
const kids = [];
const cleanup = () => { for (const k of kids) try { k.kill("SIGKILL"); } catch {} };
process.on("exit", cleanup);

// 1) pack（手元の中身＝publish する物そのもの）
const pack = dir => {
	const out = execFileSync("npm", ["pack", "--json", "--pack-destination", os.tmpdir()], { cwd: dir, encoding: "utf8" });
	const name = JSON.parse(out.slice(out.indexOf("[")))[0].filename;
	return path.join(os.tmpdir(), name);
};
// FROM_NPM=1＝pack せず npm に公開済みの版を入れる（公開した後の確かめ＝利用者が実際に受け取る物）
const FROM_NPM = process.env.FROM_NPM === "1";
console.log(FROM_NPM ? "… npm に公開済みの @ortho-earth/globe を使う" : "… npm pack（core・globe）");
const tarCore = FROM_NPM ? null : pack(path.join(ROOT, "packages/ortho-core")), tarGlobe = FROM_NPM ? "@ortho-earth/globe" : pack(GLOBE);

// 2) 使い捨ての消費アプリ＝Get Started の手順そのもの（vite.config.js は手順が書く 3 行＋検定の申告口）
// A1 そのもの＝npm create vite（vanilla）で作る。最新の create-vite と、その雛形が選ぶ vite の版を通す
const BASE = path.join(os.tmpdir(), `globe-npm-verify-${process.pid}`), WORK = path.join(BASE, "my-globe");
rmSync(BASE, { recursive: true, force: true }); mkdirSync(BASE, { recursive: true });
console.log("… npm create vite@latest（vanilla）");
execFileSync("npm", ["create", "vite@latest", "my-globe", "--", "--template", "vanilla", "--no-interactive"], { cwd: BASE, stdio: ["ignore", "ignore", "inherit"] });
const RESULT = path.join(WORK, "result.txt");
// 手順書（apps/www/public/start.md＝www.ortho-earth.com/start.md）の Route A のコード片を**そのまま**使う＝手順書と検定がずれない。
// A2＝vite.config.js・A3＝index.html と main.js・A5＝自分のデータ・A6＝マーカーとカメラ。後の片の import は先頭の import へ畳む（同じ名前の二重宣言を避ける）
const START = readFileSync(path.join(ROOT, "apps/www/public/start.md"), "utf8");
const block = (head, lang, nth = 0) => {
	const sec = START.slice(START.indexOf(head)); const end = sec.indexOf("\n### ", 5); const body = end > 0 ? sec.slice(0, end) : sec;
	const bs = [...body.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map(m => m[1]);
	if (!bs[nth]) fail(`start.md の「${head}」に ${lang} のコード片が無い`); return bs[nth];
};
const cfg = block("### A2", "js"), html = block("### A3", "html"), mainA3 = block("### A3", "js"), a5 = block("### A5", "js"), a6 = block("### A6", "js");
const names = new Set(); const code = [];
for (const b of [mainA3, a5, a6]) for (const line of b.split("\n")) {
	const m = /^import \{([^}]+)\} from "@ortho-earth\/globe";$/.exec(line.trim());
	if (m) m[1].split(",").map(x => x.trim()).filter(Boolean).forEach(n => names.add(n)); else code.push(line);
}
writeFileSync(path.join(WORK, "vite.config.js"), `
import { writeFileSync } from "node:fs";
const beacon = { name: "beacon", configureServer(s) { s.middlewares.use((req, res, next) => {
	if (!req.url?.startsWith("/__result")) return next();
	writeFileSync(${JSON.stringify(RESULT)}, new URL(req.url, "http://x").searchParams.get("t") || ""); res.statusCode = 204; res.end(); }); } };
` + cfg.replace("export default {", "export default {\n  plugins: [beacon],"));
writeFileSync(path.join(WORK, "index.html"), html);
const mainPath = /src="\/([^"]+\.js)"/.exec(html)?.[1] || fail("start.md の index.html に script の src が無い");
writeFileSync(path.join(WORK, mainPath), `import { ${[...names].join(", ")} } from "@ortho-earth/globe";
const errors = [];
const oErr = console.error; console.error = (...a) => { errors.push(a.map(String).join(" ").slice(0, 200)); oErr(...a); };
const oWarn = console.warn; console.warn = (...a) => { const m = a.map(String).join(" "); if (/fail/i.test(m)) errors.push("warn: " + m.slice(0, 200)); oWarn(...a); };   // 「読めなかった」系の警告も数える（気候テクスチャの 404 は warn だった）
addEventListener("error", e => errors.push("error: " + (e.message || e)));
addEventListener("unhandledrejection", e => errors.push("rejection: " + (e.reason?.message || e.reason)));
const report = t => { document.title = t; fetch("/__result?t=" + encodeURIComponent(t)).catch(() => {}); };
try {
// ---- ここから start.md のコード片（A3・A5・A6）----
${code.join("\n")}
// ---- ここまで ----
  await new Promise(r => setTimeout(r, 4000));   // worker 群（標高・gint の焼き・注記）が一巡する間
  const ja = /出典/.test(document.body.innerText);   // ?lang=ja＝訳の表が束ねられて読めたか
  const c = map.getCenter?.();
  const checks = { layer: !!map.getLayer("cities"), marker: document.querySelectorAll("[class*=marker]").length > 0, zoom: Math.abs(map.getZoom() - 12) < 0.3, center: !!c, ja, errors: errors.length };
  report((Object.values(checks).every(v => v === true || v === 0) ? "PASS " : "FAIL ") + JSON.stringify(checks) + (errors.length ? " " + errors.slice(0, 3).join(" | ") : ""));
} catch (e) { report("FAIL " + (e?.stack || e)); }
`);
console.log(FROM_NPM ? "… npm install（雛形の依存＋npm の @ortho-earth/globe）" : "… npm install（雛形の依存＋手元の core・globe の tarball）");
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--prefer-online"], { cwd: WORK, stdio: ["ignore", "ignore", "inherit"] });   // A1 の npm install（雛形の vite）
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--prefer-online", ...(tarCore ? [tarCore] : []), tarGlobe], { cwd: WORK, stdio: ["ignore", "ignore", "inherit"] });   // A1 の npm install @ortho-earth/globe（ここだけ手元の tarball）
const viteVer = JSON.parse(readFileSync(path.join(WORK, "node_modules/vite/package.json"), "utf8")).version;

// 3) Chrome で開いて、ページの申告を待つ
async function runPage(url, readResult) {
	const prof = path.join(os.tmpdir(), `globe-npm-chrome-${process.pid}-${Date.now()}`);
	const c = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${prof}`, "--no-first-run", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--window-size=1024,768", url], { stdio: "ignore" });
	kids.push(c);
	const t0 = Date.now();
	let r = null;
	while (Date.now() - t0 < 90000) { await sleep(500); r = readResult(); if (r) break; }
	c.kill("SIGKILL"); await sleep(300); rmSync(prof, { recursive: true, force: true });
	return r || "FAIL timeout（ページの申告が 90 秒来ない）";
}
const vite = path.join(WORK, "node_modules/.bin/vite");
const results = [];

// 3a) build → 静的に配る（申告は /__result で受ける）
console.log(`… vite ${viteVer} build`);
try { execFileSync(vite, ["build"], { cwd: WORK, stdio: ["ignore", "ignore", "pipe"] }); }
catch (e) { fail(`vite build が失敗：\n${String(e.stderr || e).split("\n").filter(l => !/^\s+at /.test(l)).slice(0, 15).join("\n")}`); }
let buildResult = null;
const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".webp": "image/webp" };
const srv = createServer((req, res) => {
	const u = new URL(req.url, "http://x");
	if (u.pathname === "/__result") { buildResult = u.searchParams.get("t"); res.statusCode = 204; return res.end(); }
	let f = path.join(WORK, "dist", decodeURIComponent(u.pathname));
	if (existsSync(f) && statSync(f).isDirectory()) f = path.join(f, "index.html");
	if (!existsSync(f)) { res.statusCode = 404; return res.end(); }
	res.setHeader("content-type", MIME[path.extname(f)] || "application/octet-stream"); res.end(readFileSync(f));
}).listen(PORT);
results.push(["build", await runPage(`http://localhost:${PORT}/?lang=ja&gl2=1`, () => buildResult)]);
srv.close();

// 3b) dev（解決の経路が build と別物＝片方だけ割れる型がある）
console.log("… vite dev");
rmSync(RESULT, { force: true });
const dev = spawn(vite, ["--port", String(DEVPORT), "--strictPort"], { cwd: WORK, stdio: "ignore" }); kids.push(dev);
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://localhost:${DEVPORT}/`)).ok) break; } catch {} await sleep(250); }
results.push(["dev", await runPage(`http://localhost:${DEVPORT}/?lang=ja&gl2=1`, () => existsSync(RESULT) ? readFileSync(RESULT, "utf8") : null)]);
dev.kill("SIGKILL");

for (const [k, r] of results) console.log(`${r.startsWith("PASS") ? "ok" : "NG"}:${k}  ${r}`);
if (!FROM_NPM) { rmSync(tarCore, { force: true }); rmSync(tarGlobe, { force: true }); }
const which = FROM_NPM ? "npm の " + JSON.parse(readFileSync(path.join(WORK, "node_modules/@ortho-earth/globe/package.json"), "utf8")).version : "手元の pack";
if (results.every(([, r]) => r.startsWith("PASS"))) { rmSync(BASE, { recursive: true, force: true }); console.log(`✓ @ortho-earth/globe の npm 配布物の検定 PASS（${which}・vite ${viteVer}・build と dev）`); process.exit(0); }
fail(`npm 配布物の検定 FAIL（作業場所 ${WORK} を残す）`);
