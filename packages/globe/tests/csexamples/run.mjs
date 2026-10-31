#!/usr/bin/env node
// The Cesium examples gate (stage 0): run each example on real CesiumJS (ref) and on the facade (ortho), record what each side did, grade (grade.mjs).
// Needs the example server: (packages/globe) npx vite --config tests/csexamples/vite.config.mjs --port 5460 --strictPort
// CHROME=<path> picks the browser binary (the cloud sandbox: /opt/pw-browsers/chromium).
// --gpu: the real GPU (Metal WebGPU + ANGLE Metal on a Mac). Without it Chrome is forced onto SwiftShader (no WebGPU → ortho falls back to GL2),
//   which is what every Mac run before 2026-10-28 silently did; the refs and ortho shots of one run must share the flag.
// Usage: node packages/globe/tests/csexamples/run.mjs [--base http://localhost:5460] [--out <dir>] [--jobs 3] [--wait 10000] [--settle 20000] [--side ref|ortho] [--only a,b] [--skip-dev] [--regrade] [--no-warm] [--time-from <run dir>] [--hide-ui] [--gpu]
//   records: <out>/<side>/<name>.json and .png (default out: <repo>/.cache/csexamples/runs/latest) · summary: <out>/summary.json and summary.md
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { THRESH, cells, decodePng, grade, rankBlockers } from "./grade.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "../../../..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const flag = k => process.argv.includes(`--${k}`);
const BASE = arg("base", "http://localhost:5460"), OUT = path.resolve(arg("out", path.join(REPO, ".cache/csexamples/runs/latest")));
const JOBS = +arg("jobs", 3), WAIT = +arg("wait", 10000), SETTLE = +arg("settle", 20000), SIDES = arg("side") ? [arg("side")] : ["ref", "ortho"];
const ORTHO_QUERY = arg("ortho-query", "");   // a query string for the ortho pages only (e.g. gl2=1 = shoot on WebGL2 to compare the backends)
const HIDE_UI = flag("hide-ui");   // the final shoot: hide Cesium's widgets and the example's panels on the ortho side only (the grade masks those cells either way)
const TIME_FROM = arg("time-from", "");   // the page's clock starts when that run's ref page started: the sun, the stars and the clock-driven examples at the same time of day as the ref shot; an animated example is also shot at the ref's simulation time (rec.clock, recorded by both sides)
// runs in the page before any script: Date shifted by a constant (timers and performance.now keep running)
function shiftDate(off) {
	const D = Date, now = D.now.bind(D);
	const F = function Date(...a) { if (!new.target) return new D(now() + off).toString(); return a.length ? new D(...a) : new D(now() + off); };
	F.prototype = D.prototype; F.now = () => now() + off; F.parse = D.parse; F.UTC = D.UTC;
	globalThis.Date = F;
}
const corpus = JSON.parse(fs.readFileSync(path.join(HERE, "corpus.json"), "utf8"));
let examples = corpus.examples;
if (arg("only")) { const s = new Set(arg("only").split(",")); examples = examples.filter(e => s.has(e.name)); }
if (flag("skip-dev")) examples = examples.filter(e => !e.flags.dev);

// what the page says about itself after the wait (both sides keep their viewers and widgets on window.__csx)
const STATE = () => {
	const X = window.__csx || {}, v = X.viewers?.[0], D = 180 / Math.PI;
	const out = { ran: !!X.ran, viewers: X.viewers?.length || 0, renderErrors: X.errors || [], unsupported: [] };
	try { const rep = X.Cesium?.unsupportedReport?.(); if (rep) out.unsupported = Object.entries(rep).map(([what, n]) => ({ what, n })); } catch { /* ref */ }
	if (!v) return out;
	try {
		const c = v.camera, p = c.positionCartographic;
		out.camera = { lng: p.longitude * D, lat: p.latitude * D, height: p.height, heading: c.heading * D, pitch: c.pitch * D, roll: c.roll * D };
	} catch (e) { out.cameraError = String(e?.message || e); }
	try { const k = v.clock; out.clock = { time: String(k.currentTime), animating: !!k.shouldAnimate, multiplier: k.multiplier }; } catch (e) { out.clockError = String(e?.message || e); }   // the simulation time of the shot (JulianDate.toString = ISO 8601)
	try {
		const ds = v.dataSources, dsd = v.dataSourceDisplay, prims = v.scene.primitives;
		let entities = v.entities?.values?.length || 0;
		for (let i = 0; i < (ds?.length || 0); i++) entities += ds.get(i).entities.values.length;
		let primitives = 0;   // the ones the example added (not the data source display's collections, nor what an entity's visualizer put there)
		const own = new Set();   // what the visualizers put straight into scene.primitives (PathVisualizer's polyline collections, one per reference frame)
		for (const d of [dsd?._defaultDataSource, ...Array.from({ length: ds?.length || 0 }, (_, i) => ds.get(i))]) for (const z of d?._visualizers || []) for (const u of Object.values(z?._updaters || {})) if (u?._polylineCollection) own.add(u._polylineCollection);
		for (let i = 0; i < prims.length; i++) { const q = prims.get(i); if (q !== dsd?._primitives && q !== dsd?._groundPrimitives && !own.has(q) && !(X.Cesium?.Entity && q?.id instanceof X.Cesium.Entity)) primitives++; }
		out.counts = { entities, dataSources: ds?.length || 0, primitives, imageryLayers: v.imageryLayers?.length ?? v.scene.imageryLayers?.length ?? 0 };
		// what the 3D tilesets actually draw (a tileset that is "loaded" but draws nothing is not the same answer: 3d-tiles-interactivity 2026-10-28)
		let tilesets = 0, tiles = 0, triangles = 0;
		for (let i = 0; i < prims.length; i++) { const q = prims.get(i); const st = q && q.show !== false && "tilesLoaded" in q ? q.statistics : null; if (!st) continue; tilesets++; tiles += st.selected || 0; triangles += st.numberOfTrianglesSelected || 0; }
		out.drawn = { tilesets, tiles, triangles };
	} catch (e) { out.countsError = String(e?.message || e); }
	// ours: the camera the globe really drew with (the camera above is the Cesium-side pose; a wrong conversion, such as roll 180 looking straight down, only shows here)
	try { const g = v.orthoMap?.getCamera?.(); if (g) out.globeCam = { heading: g.heading, pitch: g.pitch - 90, roll: g.roll, distance: g.distance, lng: g.lng, lat: g.lat }; } catch (e) { out.globeCamError = String(e?.message || e); }
	return out;
};

// the page furniture over the map, as rectangles in CSS px of the 800 × 600 shot: Cesium's widgets (toolbar, help, animation, timeline, credits)
// and the example's own panels (Sandcastle toolbar, legends). The grade leaves these cells out: they are the same real elements on both sides
// (so they always "matched"), and the final shoot hides them on the ortho side only. Outermost visible absolute / fixed elements outside the
// map's canvas, plus the credits inside the widget
const UI_RECTS = hide => {
	const canvas = document.querySelector(".cesium-widget canvas"), out = [], els = [];
	const vis = el => { const cs = getComputedStyle(el); return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05; };
	const put = (r, el) => { if (hide) els.push(el); if (r.width > 2 && r.height > 2 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight) out.push([r.left, r.top, r.right, r.bottom].map(v => Math.round(v))); };
	const inner = el => { for (const d of el.querySelectorAll("*")) { if (!vis(d)) continue; const p = getComputedStyle(d).position; if (p === "absolute" || p === "fixed") put(d.getBoundingClientRect(), d); } };
	const walk = el => {
		for (const c of el.children) {
			if (c === canvas || c.contains(canvas)) { walk(c); continue; }
			if (c.closest(".cesium-widget") && !c.matches(".cesium-widget-credits")) continue;   // the map itself (and ortho's own furniture inside it)
			if (!vis(c)) continue;
			const cs = getComputedStyle(c), r = c.getBoundingClientRect();
			if ((cs.position === "absolute" || cs.position === "fixed" || c.matches(".cesium-widget-credits, #toolbar")) && r.width > 2 && r.height > 2) { put(r, c); inner(c); }   // and what drops out of it (the help panel under the toolbar)
			else walk(c);
		}
	};
	walk(document.body);
	for (const el of els) el.style.setProperty("visibility", "hidden", "important");   // --hide-ui: the shot shows the globe only
	return out;
};

// everything in view loaded: the globe's tiles (globe.tilesLoaded, on ortho the map's idle) and each 3D tileset's
const SETTLED = () => {
	const v = window.__csx?.viewers?.[0], s = v?.scene;
	if (!s) return true;
	if (s.globe && s.globe.show !== false && s.globe.tilesLoaded === false) return false;
	for (let i = 0; i < s.primitives.length; i++) { const p = s.primitives.get(i); if (p && p.show !== false && "tilesLoaded" in p && !p.tilesLoaded) return false; }
	return true;
};

// a fresh browser compiles every shader on first use, and on the sandbox's software GPU (SwiftShader) that takes tens of seconds,
// so whichever example comes first after a launch would be graded on that cold start: open hello-world on each side first (not recorded)
async function warm(browser) {
	for (const side of SIDES) {
		const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
		const page = await ctx.newPage();
		try {
			await page.goto(`${BASE}/cs/${side}/gallery/hello-world/`, { timeout: 60000 });
			await page.waitForFunction(() => window.__csx?.ran, null, { timeout: 45000 });
			await page.waitForFunction(SETTLED, null, { timeout: 60000, polling: 500 });
			await page.waitForTimeout(2000);
		} catch { /* a warm-up that does not finish still compiled what it got to */ }
		await ctx.close().catch(() => {});
	}
}

async function runOne(browser, side, ex) {
	const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
	const page = await ctx.newPage();
	const rec = { name: ex.name, side, exceptions: [], consoleErrors: [], warnings: [], failedRequests: 0, t0: Date.now() };
	page.on("pageerror", e => rec.exceptions.push(String(e.message).slice(0, 400)));
	page.on("console", m => {
		const t = m.text().slice(0, 400);
		if (m.type() === "error") rec.consoleErrors.push(t);
		else if (m.type() === "warning" && /\[csshim\]/.test(t)) rec.warnings.push(t);
	});
	page.on("requestfailed", () => rec.failedRequests++);
	page.on("load", () => rec.loads = (rec.loads || 0) + 1);   // more than 1 = the dev server reloaded the page (a dependency re-optimised)
	await page.addInitScript(() => { try { localStorage.removeItem("cesium-hasSeenNavHelp"); } catch { /* none */ } });   // the help panel opens as on a first visit, also after a reload
	let refClock = null;
	// 古い記録（t0 も timeFrom も無い）＝ファイルの mtime は写した時刻（v220 は 188 例が 3.3 時間ずれた＝bloom の光が逆から当たって見えた・2026-10-31）。
	// 例の時計が壁の時計から始まる（mtime と 1 日以内）なら、その時計（止まっている＝作った時・動いている＝撮った時−撮影の長さ）を始まりにする。CZML などの決まった日付の時計は mtime のまま
	const refStartOf = (r, byMtime) => { const c = Date.parse(r.clock?.time ?? ""); if (!Number.isFinite(c) || Math.abs(c - byMtime) > 864e5) return byMtime; return r.clock.animating ? c - (r.ms || 0) : c; };
	if (TIME_FROM) {   // the ref's start: the record's own t0; a ref shot with --time-from itself: its page started at its timeFrom; older records: the example's own wall clock (refStartOf), else the file's mtime less the run time (a copy that did not keep the mtime moves the clock)
		const j = path.join(TIME_FROM, "ref", `${ex.name}.json`);
		if (fs.existsSync(j)) { const st = fs.statSync(j), r = JSON.parse(fs.readFileSync(j, "utf8")), t0 = r.t0 ?? (r.timeFrom ? Date.parse(r.timeFrom) : refStartOf(r, st.mtimeMs - (r.ms || 0))); rec.timeFrom = new Date(t0).toISOString(); await page.addInitScript(shiftDate, t0 - Date.now()); refClock = (r.clock?.animating || r.paused) && r.clock.time || null; }
	}
	try {
		await page.goto(`${BASE}/cs/${side}/gallery/${ex.name}/${side === "ortho" && ORTHO_QUERY ? `?${ORTHO_QUERY}` : ""}`, { timeout: 60000 });
		await page.waitForFunction(() => window.__csx?.ran || window.__csx?.errors?.some(e => /^import:/.test(e)), null, { timeout: 45000 }).catch(() => {});
		await page.waitForTimeout(WAIT);
		// then until the globe and the tilesets say everything in view is loaded (real Cesium was often shot with its imagery still blurred)
		const t1 = Date.now();
		rec.settled = await page.waitForFunction(SETTLED, null, { timeout: SETTLE, polling: 250 }).then(() => true, () => false);
		rec.settleMs = Date.now() - t1;
		if (rec.settled) await page.waitForTimeout(500);   // the frame after the last tile
		if (refClock && side === "ortho") {   // an animated example (the ref's clock was running): shoot at the ref's simulation time — the clock runs on while the page loads, which takes longer here, so a tracked satellite or a CZML vehicle would be elsewhere
			rec.clockFrom = refClock;
			const CAM = () => { const c = window.__csx?.viewers?.[0]?.camera?.positionWC; return c ? `${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)}` : ""; };
			const cam0 = await page.evaluate(CAM).catch(() => "");
			const tracked = await page.evaluate(iso => { const X = window.__csx, v = X?.viewers?.[0]; if (!v || !X.Cesium?.JulianDate) return false; v.clock.shouldAnimate = false; v.clock.currentTime = X.Cesium.JulianDate.fromIso8601(iso); return !!v.trackedEntity; }, refClock).catch(() => false);
			// a tracked entity's camera follows the new time a few frames later (seconds on a busy SwiftShader): wait until it has moved (at most 20 s), then until it has stood still for a second (at most 8 s)
			await page.waitForTimeout(2000);
			for (let i = 0; tracked && i < 36; i++) { if (await page.evaluate(CAM).catch(() => "") !== cam0) break; await page.waitForTimeout(500); }
			let last = "", still = 0;
			for (let i = 0; i < 12 && still < 2; i++) { await page.waitForTimeout(500); const now = await page.evaluate(CAM).catch(() => ""); still = now === last ? still + 1 : 0; last = now; }
		}
		// an animated example is shot with its clock paused, so the record's clock (and a tracked camera) is the shot's: the shot itself takes seconds = minutes at 300×
		rec.paused = await page.evaluate(() => { const v = window.__csx?.viewers?.[0]; if (!v?.clock?.shouldAnimate) return false; v.clock.shouldAnimate = false; return true; }).catch(() => false);
		if (rec.paused) await page.waitForTimeout(1000);   // the frame at the paused time
		Object.assign(rec, await page.evaluate(STATE));
		rec.ui = await page.evaluate(UI_RECTS, HIDE_UI && side === "ortho").catch(() => null);
		if (HIDE_UI && side === "ortho") await page.waitForTimeout(300);
		const shot = await page.screenshot({ timeout: 120000 });   // a frame of a city of 3D Tiles takes seconds on SwiftShader (on both sides)
		fs.writeFileSync(path.join(OUT, side, `${ex.name}.png`), shot);
		rec.cells = cells(decodePng(shot));
	} catch (e) { rec.harnessError = String(e?.message || e).split("\n")[0].slice(0, 300); }
	rec.ms = Date.now() - rec.t0;   // t0 stays: a later --time-from run starts its clock there
	fs.writeFileSync(path.join(OUT, side, `${ex.name}.json`), JSON.stringify(rec));
	await ctx.close().catch(() => {});
	return rec;
}

// a record, its cells measured again from the shot when they were measured another way (an older run, other THRESH)
const load = (side, name) => {
	let r;
	try { r = JSON.parse(fs.readFileSync(path.join(OUT, side, `${name}.json`), "utf8")); } catch { return null; }
	if (r.cells?.c?.length !== THRESH.gridW * THRESH.gridH) { try { r.cells = cells(decodePng(fs.readFileSync(path.join(OUT, side, `${name}.png`)))); } catch { r.cells = null; } }
	return r;
};

if (!flag("regrade")) {
	const { chromium } = createRequire(import.meta.url)("playwright");
	for (const s of SIDES) fs.mkdirSync(path.join(OUT, s), { recursive: true });
	const tasks = examples.flatMap(ex => SIDES.map(side => ({ side, ex })));
	let next = 0, done = 0;
	const worker = async () => {
		let browser = null, uses = 0;
		while (next < tasks.length) {
			const t = tasks[next++];
			if (!browser || uses++ >= 20) { await browser?.close().catch(() => {}); browser = await chromium.launch({ ...(process.env.CHROME && { executablePath: process.env.CHROME }), args: ["--no-sandbox", "--disable-dev-shm-usage", ...(flag("gpu") ? ["--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])] }); uses = 1; if (!flag("no-warm")) await warm(browser); }
			const r = await runOne(browser, t.side, t.ex);
			done++;
			console.log(`[${done}/${tasks.length}] ${t.side} ${t.ex.name} ${r.harnessError ? "HARNESS " + r.harnessError : r.exceptions.length ? "EXC " + r.exceptions[0].slice(0, 100) : r.ran ? "ok" : "not ran"} (${Math.round(r.ms / 1000)} s)`);
		}
		await browser?.close().catch(() => {});
	};
	await Promise.all(Array.from({ length: JOBS }, worker));
}

// grade every example that has both records
const graded = [];
for (const ex of corpus.examples) {
	const R = load("ref", ex.name), O = load("ortho", ex.name);
	if (!R || !O) continue;
	graded.push({ ...grade(R, O), dev: ex.flags.dev, ion: ex.flags.ion });
}
const count = list => { const c = { null: 0, 0: 0, 1: 0, 2: 0, 3: 0 }; for (const g of list) c[g.level]++; return c; };
const blockers = rankBlockers(graded);
const summary = { at: new Date().toISOString(), cesium: corpus.cesium.version, n: graded.length, levels: count(graded), levelsNonDev: count(graded.filter(g => !g.dev)), blockers, graded };
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
const cell = t => String(t).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");   // a markdown table cell
const L = summary.levels, md = [
	`# Cesium examples gate (CesiumJS ${summary.cesium}) — ${summary.at}`, "",
	`${summary.n} examples · not graded (real Cesium does not run it here, it starts in 2D, or it is the Moon / Mars): ${L.null} · ours does not run: ${L[0]} · runs: ${L[1]} · same answers: ${L[2]} · same picture: ${L[3]}`, "",
	"## Blockers", "", "| n | blocker | examples |", "|---|---|---|",
	...blockers.slice(0, 60).map(b => `| ${b.n} | ${cell(b.blocker)} | ${b.examples.slice(0, 6).join(", ")}${b.examples.length > 6 ? " …" : ""} |`), "",
	"## Examples", "", "| example | level | why |", "|---|---|---|",
	...graded.map(g => `| ${g.name}${g.dev ? " (dev)" : ""} | ${g.level ?? "–"} | ${cell((g.level == null ? g.refWhy : g.reasons.join("; ")).slice(0, 200))} |`),
].join("\n");
fs.writeFileSync(path.join(OUT, "summary.md"), md + "\n");
console.log(`levels ${JSON.stringify(L)} (non-dev ${JSON.stringify(summary.levelsNonDev)}) → ${path.join(OUT, "summary.md")}`);
