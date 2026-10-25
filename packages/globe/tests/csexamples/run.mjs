#!/usr/bin/env node
// The Cesium examples gate (stage 0): run each example on real CesiumJS (ref) and on the facade (ortho), record what each side did, grade (grade.mjs).
// Needs the example server: (packages/globe) npx vite --config tests/csexamples/vite.config.mjs --port 5460 --strictPort
// CHROME=<path> picks the browser binary (the cloud sandbox: /opt/pw-browsers/chromium).
// Usage: node packages/globe/tests/csexamples/run.mjs [--base http://localhost:5460] [--out <dir>] [--jobs 3] [--wait 10000] [--side ref|ortho] [--only a,b] [--skip-dev] [--regrade]
//   records: <out>/<side>/<name>.json and .png (default out: <repo>/.cache/csexamples/runs/latest) · summary: <out>/summary.json and summary.md
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { cells, decodePng, grade, rankBlockers } from "./grade.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, "../../../..");
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const flag = k => process.argv.includes(`--${k}`);
const BASE = arg("base", "http://localhost:5460"), OUT = path.resolve(arg("out", path.join(REPO, ".cache/csexamples/runs/latest")));
const JOBS = +arg("jobs", 3), WAIT = +arg("wait", 10000), SIDES = arg("side") ? [arg("side")] : ["ref", "ortho"];
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
	try {
		const ds = v.dataSources, dsd = v.dataSourceDisplay, prims = v.scene.primitives;
		let entities = v.entities?.values?.length || 0;
		for (let i = 0; i < (ds?.length || 0); i++) entities += ds.get(i).entities.values.length;
		let primitives = 0;   // the ones the example added (not the data source display's collections, nor what an entity's visualizer put there)
		for (let i = 0; i < prims.length; i++) { const q = prims.get(i); if (q !== dsd?._primitives && q !== dsd?._groundPrimitives && !(X.Cesium?.Entity && q?.id instanceof X.Cesium.Entity)) primitives++; }
		out.counts = { entities, dataSources: ds?.length || 0, primitives, imageryLayers: v.imageryLayers?.length ?? v.scene.imageryLayers?.length ?? 0 };
	} catch (e) { out.countsError = String(e?.message || e); }
	return out;
};

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
	try {
		await page.goto(`${BASE}/cs/${side}/gallery/${ex.name}/`, { timeout: 60000 });
		await page.waitForFunction(() => window.__csx?.ran || window.__csx?.errors?.some(e => /^import:/.test(e)), null, { timeout: 45000 }).catch(() => {});
		await page.waitForTimeout(WAIT);
		Object.assign(rec, await page.evaluate(STATE));
		const shot = await page.screenshot({ timeout: 30000 });
		fs.writeFileSync(path.join(OUT, side, `${ex.name}.png`), shot);
		rec.cells = cells(decodePng(shot)).map(c => c.map(Math.round));
	} catch (e) { rec.harnessError = String(e?.message || e).split("\n")[0].slice(0, 300); }
	rec.ms = Date.now() - rec.t0; delete rec.t0;
	fs.writeFileSync(path.join(OUT, side, `${ex.name}.json`), JSON.stringify(rec));
	await ctx.close().catch(() => {});
	return rec;
}

const load = (side, name) => { try { return JSON.parse(fs.readFileSync(path.join(OUT, side, `${name}.json`), "utf8")); } catch { return null; } };

if (!flag("regrade")) {
	const { chromium } = createRequire(import.meta.url)("playwright");
	for (const s of SIDES) fs.mkdirSync(path.join(OUT, s), { recursive: true });
	const tasks = examples.flatMap(ex => SIDES.map(side => ({ side, ex })));
	let next = 0, done = 0;
	const worker = async () => {
		let browser = null, uses = 0;
		while (next < tasks.length) {
			const t = tasks[next++];
			if (!browser || uses++ >= 20) { await browser?.close().catch(() => {}); browser = await chromium.launch({ ...(process.env.CHROME && { executablePath: process.env.CHROME }), args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage"] }); uses = 1; }
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
const L = summary.levels, md = [
	`# Cesium examples gate (CesiumJS ${summary.cesium}) — ${summary.at}`, "",
	`${summary.n} examples · real Cesium does not run here: ${L.null} · ours does not run: ${L[0]} · runs: ${L[1]} · same answers: ${L[2]} · same picture: ${L[3]}`, "",
	"## Blockers", "", "| n | blocker | examples |", "|---|---|---|",
	...blockers.slice(0, 60).map(b => `| ${b.n} | ${b.blocker.replace(/\|/g, "\\|")} | ${b.examples.slice(0, 6).join(", ")}${b.examples.length > 6 ? " …" : ""} |`), "",
	"## Examples", "", "| example | level | why |", "|---|---|---|",
	...graded.map(g => `| ${g.name}${g.dev ? " (dev)" : ""} | ${g.level ?? "–"} | ${(g.level == null ? g.refWhy : g.reasons.join("; ")).replace(/\|/g, "\\|").slice(0, 200)} |`),
].join("\n");
fs.writeFileSync(path.join(OUT, "summary.md"), md + "\n");
console.log(`levels ${JSON.stringify(L)} (non-dev ${JSON.stringify(summary.levelsNonDev)}) → ${path.join(OUT, "summary.md")}`);
