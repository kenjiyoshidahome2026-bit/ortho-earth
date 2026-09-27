#!/usr/bin/env node
// 公式例の門（台帳 §8）の走らせ台＝MapLibre 公式の例を本文無改修で本物（ref）とこちら（ortho）に流し、答えと写しを取る。
// 常設の関門（verify）には入れない＝手で／節目に回す（本人裁定 3・verify:net と同じ扱い）。
//   ・器＝tests/mlexamples/vite.config.mjs（/ref と /ortho に例をバイトのまま配る）・口は VGE_PORT（既定 5253）
//   ・例ごとに Chrome を立て直す（cdp.mjs）・800×600・dpr 1・実 GPU（--gl2＝こちらを WebGL2 で）
//   ・網＝録り置き（tests/mlexamples/netstore.mjs・<repo>/.cache/mlexamples/net/）。既定は再生だけ（無い物は net-miss）
//   ・描き終わり＝load の後、その側の idle（無ければ load から 10 秒）→「取得が 1 秒止まる」＋「canvas だけの写しが 500ms 空けて 2 回同じ」（双方同じ判定）。上限 45 秒。
//     動きのある例（見立て animated）は load から 6 秒で撮る・取得が止まっても写しが 4 秒違い続けたら「moving」で撮る（どちらも絵の採点はしない）。
//     地図が 10 秒出なければ打ち切る。UA は普通の Chrome（headless を嫌う配信がある・双方同じ）
//   ・記録＝<repo>/.cache/mlexamples/runs/<label>/<side>/<例>.{json,canvas.png,full.png}
// 使い方:
//   node scripts/verify-examples.mjs --side ref --record-missing --label r1   （録りながら本物を回す）
//   node scripts/verify-examples.mjs --side ref --label r2                    （再生だけで回す）
//   node scripts/verify-examples.mjs --compare r1 r2 --side ref               （2 回の走りの揺れ）
//   node scripts/verify-examples.mjs --side ortho --ref r6 --label o1           （こちら＝本物の記録 r6 の標本点で比べる）
//   node scripts/verify-examples.mjs --grade --ref r6 --ortho o1 [--update]    （採点・見比べ帳・順位表・known.json の爪車）
//   他：--only a,b（例の名前）・--jobs N（並行・既定 3）・--record（全部取り直す）・--gl2（こちらを WebGL2 で）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite } from "./lib/ui-runner.mjs";
import { launchChrome, connect, REALGPU } from "./lib/cdp.mjs";
import { ensureCorpus, CACHE } from "../tests/mlexamples/corpus.mjs";
import { createNetStore, UA } from "../tests/mlexamples/netstore.mjs";
import { decodePng, probeColors, diffRuns, grade, rankBlockers, THRESH } from "../tests/mlexamples/compare.mjs";
import { buildReport } from "../tests/mlexamples/report.mjs";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.resolve(CACHE, "..");   // <repo>/.cache/mlexamples
const PORT = +process.env.VGE_PORT || 5253;
const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = k => argv.includes(k);
const W = 800, H = 600, CAP_S = 45, ANIM_S = 6, NOMAP_S = 10, MOVING_N = 8, IDLE_WAIT_S = 10;   // MOVING_N＝取得が止まってから写しが続けて違った回数（×500ms）＝絵が動き続ける例

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 頁に差す物 ──
// 乱数に種（例の Math.random を毎回同じ列に）＝mulberry32
const SEED = `(() => { let a = 0x9e3779b9; Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; })();`;
const STATE = `(() => { const X = window.__mlx; if (!X) return null; const m = X.maps[0];
	let rect = null; try { const r = m?.getContainer().getBoundingClientRect(); rect = r && { left: r.left, top: r.top, W: r.width, H: r.height }; } catch {}
	let ml = null; try { ml = m?.loaded?.() ?? null; } catch {}
	const t = e => X.ev.find(v => v[0] === 0 && v[1] === e)?.[2] ?? null;
	return { maps: X.maps.length, load: t("load"), styleLoad: t("style.load"), idle: t("idle"), ml, now: Math.round(performance.now()), rect }; })()`;
// 写しの間は DOM の上物（操作部品・Marker・Popup）を隠す＝canvas だけを比べる
const HIDE = { ref: ".maplibregl-control-container,.maplibregl-marker,.maplibregl-popup{visibility:hidden!important}",
	ortho: "#map > :not(canvas){visibility:hidden!important}" };   // こちら＝容れ物（エンジンが id を map に揃える）の canvas は全部残す（#c・#labels・重ね描きの .overlay-gl＝記号・ヒートマップ・集約）。旧＝#c と #labels だけ残して重ね描きまで隠していた（2 巡目で発見）
// 頁に差す関数（文字列を組み立てない＝値は Runtime.callFunctionOn の引数で渡す・CodeQL js/bad-code-sanitization）
const HIDE_FN = `function (css) { let s = document.getElementById("__mlx_hide"); if (!s) { s = document.createElement("style"); s.id = "__mlx_hide"; document.head.appendChild(s); } s.textContent = css; }`;
// 本物の答え：16×10 の格子（縁 48px を除く）→unproject（|lat|≤85.051・project で戻る点だけ ok）→問い合わせ。層・カメラ・範囲・Marker の位置
const PROBE_REF = `(() => { const X = window.__mlx, m = X.maps[0]; const r = m.getContainer().getBoundingClientRect();
	const Wc = r.width, Hc = r.height, M = 48, NX = 16, NY = 10, probes = [];
	for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
		const x = M + (Wc - 2 * M) * (i + 0.5) / NX, y = M + (Hc - 2 * M) * (j + 0.5) / NY;
		let ll = null, ok = false; try { ll = m.unproject([x, y]); } catch {}
		if (ll && Math.abs(ll.lat) <= 85.051) { const p = m.project(ll); ok = Math.hypot(p.x - x, p.y - y) < 1; }
		let feats = []; try { feats = m.queryRenderedFeatures([x, y]).map(f => ({ layer: f.layer?.id, type: f.layer?.type, source: f.source, sourceLayer: f.sourceLayer ?? null, id: f.id ?? null })); } catch (e) { feats = [{ error: String(e.message) }]; }
		probes.push({ x, y, lng: ll?.lng ?? null, lat: ll?.lat ?? null, ok, feats });
	}
	const st = (() => { try { return m.getStyle(); } catch { return null; } })();
	const c = m.getCenter();
	const mk = el => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2 - r.left, y: b.top + b.height / 2 - r.top }; };
	return { container: { left: r.left, top: r.top, W: Wc, H: Hc },
		camera: { lng: c.lng, lat: c.lat, zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() },
		bounds: (() => { try { return m.getBounds().toArray(); } catch { return null; } })(),
		projection: (() => { try { return m.getProjection?.()?.type ?? null; } catch { return null; } })(),
		layers: (st?.layers || []).map(l => ({ id: l.id, type: l.type, source: l.source ?? null })),
		sources: Object.keys(st?.sources || {}),
		markers: [...document.querySelectorAll(".maplibregl-marker")].map(mk),
		popups: [...document.querySelectorAll(".maplibregl-popup")].map(mk),
		loaded: m.loaded(), mapErrors: X.errors.slice(0, 20).map(e => [e[0], String(e[1]).slice(0, 300)]), mapErrorCount: X.errors.length, ev: X.ev.slice(0, 50), added: [...new Set(X.added || [])], probes }; })()`;
// こちらの答え：本物の標本点（経緯度）をこちらの projectLL で画面へ→問い合わせ（非同期）。比べる点＝front>0（裏でない）・画面の内側・
// unproject で同じ場所へ戻る（標本の間隔の 1/4 以内＝地平線に寄せられた点・大気の縁を除く）。front は高さ／半径の量＝高ズームでは 1e-4 程度でも表（閾値を置かない）
// 本物の記録が無い例は自分の格子（unproject）で取る（絵の比べはできない）
const PROBE_ORTHO = refProbes => `(async (REF) => { const X = window.__mlx, m = X.maps[0], eng = X.engines?.[0]; const r = m.getContainer().getBoundingClientRect();
	const Wc = r.width, Hc = r.height, M = 48, NX = 16, NY = 10, probes = [];
	const grid = REF || Array.from({ length: NX * NY }, (_, k) => { const i = k % NX, j = (k / NX) | 0; const x = M + (Wc - 2 * M) * (i + 0.5) / NX, y = M + (Hc - 2 * M) * (j + 0.5) / NY; const ll = m.unproject([x, y]); return { lng: ll?.lng ?? null, lat: ll?.lat ?? null, ok: !!ll }; });
	const hav = (a, b) => { const d = Math.PI / 180, s = Math.sin((b.lat - a.lat) * d / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin((b.lng - a.lng) * d / 2) ** 2; return 12742017.6 * Math.asin(Math.min(1, Math.sqrt(s))); };
	const okPts = grid.filter(p => p.ok && p.lng != null);
	let step = Infinity; for (let k = 1; k < grid.length; k++) if (grid[k].ok && grid[k - 1].ok && grid[k].lng != null && grid[k - 1].lng != null) step = Math.min(step, hav(grid[k], grid[k - 1]));   // 隣り合う標本の間隔（最小）
	for (const p of grid) {
		let x = null, y = null, front = -1, ok = false, feats = [];
		if (eng && p.ok && p.lng != null) {
			[x, y, front] = eng.projectLL(p.lng, p.lat);
			ok = front > 0 && x >= 0 && y >= 0 && x < Wc && y < Hc;
			if (ok) { const back = eng.unproject([x, y]); ok = !!back && (!(step < Infinity) || hav(back, p) <= step / 4); }
		}
		if (ok) { try { feats = (await eng.queryRenderedFeatures([x, y])).map(f => ({ layer: f.layer?.id, type: f.layer?.type, source: f.source, sourceLayer: f.sourceLayer ?? null, id: f.id ?? null })); } catch (e) { feats = [{ error: String(e.message) }]; } }
		probes.push({ x, y, lng: p.lng, lat: p.lat, ok, front, feats });
	}
	const st = (() => { try { return eng?.getStyle(); } catch { return null; } })();
	const c = m.getCenter(), mk = el => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2 - r.left, y: b.top + b.height / 2 - r.top }; };
	const b = m.getBounds();
	return { container: { left: r.left, top: r.top, W: Wc, H: Hc },
		camera: { lng: c.lng, lat: c.lat, zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() },
		bounds: b && !b.isEmpty() ? b.toArray() : null, projection: "globe",
		layers: (st?.layers || []).map(l => ({ id: l.id, type: l.type, source: l.source ?? null })),
		sources: Object.keys(st?.sources || {}),
		markers: [...document.querySelectorAll(".oe-marker")].map(mk),
		popups: [...document.querySelectorAll(".oe-popup")].map(mk),
		loaded: m.loaded(), backend: eng?.backend ?? null, mapErrors: X.errors.slice(0, 20).map(e => [e[0], String(e[1]).slice(0, 300)]), mapErrorCount: X.errors.length, ev: X.ev.slice(0, 50), added: [...new Set(X.added || [])], probes }; })(${JSON.stringify(refProbes)})`;
const PROBE = { ref: () => PROBE_REF, ortho: PROBE_ORTHO };

async function runExample(ex, side, { seq, label, mode, gl2, refLabel }) {
	const outDir = path.join(ROOT, "runs", label, side);
	fs.mkdirSync(outDir, { recursive: true });
	const q = side === "ortho" ? [gl2 && "gl2=1", has("--mllat") && "mllat=1"].filter(Boolean).join("&") : "";   // --mllat＝実験（ortho-entry の起動の視点に緯度の縮尺）
	const url = `http://localhost:${PORT}/${side}/test/examples/${ex.name}.html${q ? "?" + q : ""}`;
	const rec = { name: ex.name, side, url, exceptions: [], consoleErrors: [], consoleWarnings: [], unsupported: [], workerErrors: [] };
	const store = createNetStore({ dir: path.join(ROOT, "net"), assetsDir: path.join(CACHE, "assets"), mode });
	const t0 = Date.now();
	let ch = null, cdp = null;
	try {
		ch = await launchChrome({ flags: REALGPU, profilePrefix: "oe-vex", seq, extraArgs: [`--user-agent=${UA}`] });
		cdp = await connect(ch.browserWs);
		const kinds = new Map();
		const { targetId } = await cdp.call("Target.createTarget", { url: "about:blank" });
		const { sessionId: page } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
		kinds.set(page, "page");
		const text = a => (a || []).map(x => x.value ?? x.description ?? x.type).join(" ");
		cdp.on(m => {
			const s = m.sessionId, p = m.params;
			if (m.method === "Fetch.requestPaused" && s === page) store.handle(cdp, page, p);
			else if (m.method === "Target.attachedToTarget") {   // worker＝例外と console を拾う（網は頁の session で捕まる）
				kinds.set(p.sessionId, p.targetInfo.type);
				const ws = p.sessionId;
				Promise.all([cdp.send("Runtime.enable", {}, { session: ws }),
					cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, { session: ws })])
					.finally(() => cdp.send("Runtime.runIfWaitingForDebugger", {}, { session: ws }));
			} else if (m.method === "Runtime.exceptionThrown") {
				const d = p.exceptionDetails, msg = (d.exception?.description || d.text || "").split("\n")[0];
				(kinds.get(s) === "page" ? rec.exceptions : rec.workerErrors).push(msg);
			} else if (m.method === "Runtime.consoleAPICalled") {
				const msg = text(p.args);
				if (/\[mlshim\] unsupported/.test(msg)) rec.unsupported.push(msg.replace(/^.*\[mlshim\] unsupported:\s*/, ""));
				else if (p.type === "error") (kinds.get(s) === "page" ? rec.consoleErrors : rec.workerErrors).push(msg.slice(0, 300));
				else if (p.type === "warning" && rec.consoleWarnings.length < 30) rec.consoleWarnings.push(msg.slice(0, 300));
			} else if (m.method === "Page.javascriptDialogOpening") cdp.send("Page.handleJavaScriptDialog", { accept: true }, { session: page });
		});
		const on = (method, params = {}) => cdp.call(method, params, { session: page });
		await on("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
		await on("Page.enable"); await on("Runtime.enable");
		await on("Page.addScriptToEvaluateOnNewDocument", { source: SEED });
		await cdp.call("Browser.grantPermissions", { permissions: ["geolocation"], origin: `http://localhost:${PORT}` });
		await on("Emulation.setGeolocationOverride", { latitude: 48.8584, longitude: 2.2945, accuracy: 10 });
		await on("Fetch.enable", { patterns: [{ urlPattern: "https://*" }] });
		await on("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
		await on("Page.navigate", { url });
		const evalv = async expr => (await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, { session: page, timeoutMs: 15000 }))?.result?.value;
		// 関数を頁で呼ぶ（引数は値で渡す＝コードの文字列に埋め込まない）。this＝window
		let winId = null;
		const callFn = async (fnSrc, args) => {
			winId ??= (await cdp.send("Runtime.evaluate", { expression: "window" }, { session: page }))?.result?.objectId ?? null;
			if (!winId) return undefined;
			return (await cdp.send("Runtime.callFunctionOn", { functionDeclaration: fnSrc, objectId: winId, arguments: args.map(value => ({ value })), returnByValue: true, awaitPromise: true }, { session: page, timeoutMs: 15000 }))?.result?.value;
		};
		const shotOf = async (rect, clip = true) => {
			const r = await cdp.send("Page.captureScreenshot", { format: "png", ...(clip && rect ? { clip: { x: rect.left, y: rect.top, width: rect.W, height: rect.H, scale: 1 } } : {}) }, { session: page, timeoutMs: 20000 });
			return r?.data ? Buffer.from(r.data, "base64") : null;
		};
		let loadAt = 0, prev = null, last = null, st = null, hidden = false, differ = 0;
		for (;;) {
			await sleep(500);
			if (cdp.dead()) { rec.end = "crash"; break; }
			const el = (Date.now() - t0) / 1000;
			st = await evalv(STATE);
			// 入口＝load 事象／map.loaded() が真／style.load から 15 秒（毎フレーム Marker を足し直す例は MapLibre でも load が来ない）
			if (!loadAt && st) {
				const via = st.load != null ? "event" : st.ml === true ? "loaded()" : (st.styleLoad != null && st.now - st.styleLoad > 15000) ? "style.load+15s" : null;
				if (via) { loadAt = Date.now(); rec.loadVia = via; }
			}
			if (!st?.maps && el > NOMAP_S) { rec.end = "no-map"; break; }
			if (el > CAP_S) { rec.end = "timeout"; break; }
			if (!loadAt || !st?.rect) continue;
			if (!hidden) { await callFn(HIDE_FN, [HIDE[side] || ""]); hidden = true; }
			if (ex.flags.animated) { if (Date.now() - loadAt > ANIM_S * 1000) { last = await shotOf(st.rect); rec.end = "animated"; break; } continue; }
			// 撮るのはその側の idle（MapLibre の idle／こちらの idle）が来てから。来ない例は load から 10 秒で下の判定だけに（取得の隙に早撮りしない・r1/r2 の揺れの正体）
			if (st.idle == null && Date.now() - loadAt < IDLE_WAIT_S * 1000) continue;
			if (!rec.idleVia) rec.idleVia = st.idle != null ? "idle" : "timeout";
			if (store.quietMs() < 1000) { prev = null; differ = 0; continue; }
			last = await shotOf(st.rect);
			if (prev && last && prev.equals(last)) { rec.end = "stable"; break; }
			if (prev && ++differ >= MOVING_N) { rec.end = "moving"; break; }
			prev = last;
		}
		rec.t = { load: loadAt ? loadAt - t0 : null, done: Date.now() - t0 };
		rec.map = !!st?.maps;
		if (rec.map && !cdp.dead()) {
			if (!last && st?.rect) last = await shotOf(st.rect);
			const refRec = side === "ortho" ? (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "runs", refLabel, "ref", `${ex.name}.json`), "utf8")); } catch { return null; } })() : null;
			const probe = await evalv(PROBE[side](refRec?.probes?.map(p => ({ lng: p.lng, lat: p.lat, ok: p.ok })) ?? null));
			Object.assign(rec, probe || { probeError: true });
			if (last) {
				fs.writeFileSync(path.join(outDir, `${ex.name}.canvas.png`), last);
				try { rec.colors = probeColors(decodePng(last), rec.probes || []); } catch (e) { rec.colorError = e.message; }
			}
			await callFn(HIDE_FN, [""]);
			const full = await shotOf(null, false);
			if (full) fs.writeFileSync(path.join(outDir, `${ex.name}.full.png`), full);
		}
	} catch (e) {
		rec.end = "harness-error"; rec.harnessError = String(e?.message || e);
	} finally {
		rec.net = { ...store.stats, misses: store.stats.misses.slice(0, 50), missCount: store.stats.misses.length, errors: store.stats.errors.slice(0, 20) };
		delete rec.net.inflight; delete rec.net.last;
		cdp?.close(); if (ch) await ch.close();
	}
	fs.writeFileSync(path.join(outDir, `${ex.name}.json`), JSON.stringify(rec, null, 1));
	return rec;
}

async function pool(items, n, fn) {
	let k = 0;
	await Promise.all(Array.from({ length: n }, async (_, w) => { while (k < items.length) { const i = k++; await fn(items[i], i, w); } }));
}

// ── 2 回の走りの揺れ ──
function compareRuns(la, lb, side) {
	const da = path.join(ROOT, "runs", la, side), db = path.join(ROOT, "runs", lb, side);
	const names = fs.readdirSync(da).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).filter(n => fs.existsSync(path.join(db, n + ".json"))).sort();
	const rows = names.map(n => {
		const a = JSON.parse(fs.readFileSync(path.join(da, n + ".json"), "utf8")), b = JSON.parse(fs.readFileSync(path.join(db, n + ".json"), "utf8"));
		const d = diffRuns(a, b);
		if (a.end !== b.end) d.reasons.unshift(`end ${a.end}/${b.end}`), d.stable = false;
		return { name: n, ...d, end: a.end };
	});
	const bad = rows.filter(r => !r.stable);
	for (const r of bad) console.log(`揺れ  ${r.name.padEnd(56)} ${r.reasons.join(" ")}  （色 max ${r.maxDist ?? "-"} p95 ${r.p95 ?? "-"}）`);
	console.log(`\n${side}: ${rows.length} 本中 揺れない ${rows.length - bad.length}・揺れる ${bad.length}`);
	const out = path.join(ROOT, "runs", `stability-${side}-${la}-${lb}.json`);
	fs.writeFileSync(out, JSON.stringify(rows, null, 1));
	console.log(`記録：${path.relative(process.cwd(), out)}`);
}

// ── 採点（段 4）＋爪車（段 5）：本物 runs/<ref> とこちら runs/<ortho> を突き合わせ、見比べ帳と順位表を出し、known.json と比べる ──
const KNOWN = path.join(PKG, "tests/mlexamples/known.json");
const STILL = r => r.R?.end === "stable" && r.O?.end === "stable";
function gradeRuns(refLabel, orthoLabel, { update = false } = {}) {
	const corpus = JSON.parse(fs.readFileSync(path.join(PKG, "tests/mlexamples/corpus.json"), "utf8"));
	const read = (label, s, n) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "runs", label, s, `${n}.json`), "utf8")); } catch { return null; } };
	const rows = corpus.examples.map(ex => {
		const R = read(refLabel, "ref", ex.name), O = read(orthoLabel, "ortho", ex.name);
		return { name: ex.name, title: ex.title, category: ex.category, plain: ex.plain, R, O, grade: { ...grade(R, O), name: ex.name } };
	}).filter(r => r.O);   // こちらを回した例だけ（--only の走りも採点できる）
	const LV = ["0 動かない", "1 動く", "2 同じ答え", "3 同じ絵"], levels = Object.fromEntries([...LV, "分母の外"].map(k => [k, 0]));
	for (const r of rows) levels[r.grade.level == null ? "分母の外" : LV[r.grade.level]]++;
	const inDen = rows.filter(r => r.grade.level != null), plain = inDen.filter(r => r.plain);
	const summary = { levels, n: inDen.length, plainN: plain.length, plain3: plain.filter(r => r.grade.level === 3).length,
		pictureOnly: inDen.filter(r => r.grade.pictureOnly).length, pictureN: inDen.filter(r => r.grade.color && r.grade.pictureOnly !== undefined && STILL(r)).length };
	const ranking = rankBlockers(rows.map(r => r.grade));
	console.log(`\n採点：本物 ${refLabel} × こちら ${orthoLabel}（${rows.length} 本・分母 ${summary.n}）`);
	for (const [k, v] of Object.entries(levels)) console.log(`  ${k.padEnd(10)} ${v}`);
	console.log(`  鍵・外部ライブラリ・custom 無しの例で同じ絵：${summary.plain3}/${summary.plainN}`);
	console.log(`  絵だけ見れば同じ（段 2 に依らない）：${summary.pictureOnly}/${summary.pictureN}（両側とも止まって撮れた例）`);
	console.log("\n足りない口の順位表（上位 15）：");
	for (const b of ranking.slice(0, 15)) console.log(`  ${String(b.n).padStart(3)}  ${b.blocker}`);
	const dir = path.join(ROOT, "report", orthoLabel);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "index.html"), buildReport({ rows, summary, ranking, thresh: THRESH, refLabel, orthoLabel, when: new Date().toISOString().slice(0, 16) }));
	fs.writeFileSync(path.join(dir, "grades.json"), JSON.stringify({ refLabel, orthoLabel, summary, ranking, grades: rows.map(r => ({ name: r.name, ...r.grade, color: undefined })) }, null, 1));
	console.log(`\n見比べ帳：${path.relative(process.cwd(), path.join(dir, "index.html"))}`);
	// 爪車：段が下がった例＝落ちる／上がった例＝--update で書き換える（実 GPU 1 回では落とさない）
	const now = Object.fromEntries(rows.map(r => [r.name, r.grade.level]));
	const known = fs.existsSync(KNOWN) ? JSON.parse(fs.readFileSync(KNOWN, "utf8")) : null;
	if (update || !known) {
		const all = { ...(known?.levels || {}), ...now };
		fs.writeFileSync(KNOWN, JSON.stringify({ _: "公式例の門の爪車（台帳 §8）＝例ごとの今の段（null＝本物も落ちる＝分母の外）。下がったら落ちる・上がったら --update で書き換える", maplibre: corpus.maplibre.version, refLabel, levels: Object.fromEntries(Object.entries(all).sort()) }, null, "\t") + "\n");
		console.log(known ? "known.json を書き換えた" : "known.json を作った（最初の点数）");
		return 0;
	}
	const down = [], up = [];
	for (const [n, l] of Object.entries(now)) {
		if (!(n in known.levels)) continue;
		const k = known.levels[n];
		if ((l ?? -1) < (k ?? -1)) down.push(`${n} ${k}→${l}`); else if ((l ?? -1) > (k ?? -1)) up.push(`${n} ${k}→${l}`);
	}
	if (up.length) console.log(`\n上がった（--update で known.json へ）：${up.join("・")}`);
	if (down.length) { console.log(`\n✗ 下がった：${down.join("・")}`); return 1; }
	console.log("\n✓ known.json どおり（下がった例なし）");
	return 0;
}

const side = opt("--side", "ref");
if (has("--compare")) { const i = argv.indexOf("--compare"); compareRuns(argv[i + 1], argv[i + 2], side); process.exit(0); }
if (has("--grade")) process.exit(gradeRuns(opt("--ref"), opt("--ortho"), { update: has("--update") }));

const corpus = await ensureCorpus();
const mode = has("--record") ? "record" : has("--record-missing") ? "record-missing" : "replay";
const label = opt("--label", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
const only = opt("--only") ? new Set(opt("--only").split(",")) : null;
const jobs = +opt("--jobs", 3);
const sides = side === "both" ? ["ref", "ortho"] : [side];
const list = corpus.examples.filter(e => !only || only.has(e.name));
if (only && list.length !== only.size) console.warn(`知らない例：${[...only].filter(n => !list.some(e => e.name === n)).join(", ")}`);

const stop = await startVite({ cwd: PKG, port: PORT, portEnv: "VGE_PORT", args: ["--config", "tests/mlexamples/vite.config.mjs"], readyUrl: `http://localhost:${PORT}/ref/dist/maplibre-gl.css` });
try {
	for (const s of sides) await fetch(`http://localhost:${PORT}/${s}/dist/maplibre-gl-dev.mjs`).catch(() => {});   // 温める（こちらは vite の変換が最初に走る）
	console.log(`公式例の門：${list.length} 本 × ${sides.join("+")}・網=${mode}・並行 ${jobs}・記録 runs/${label}/`);
	const t0 = Date.now();
	let seq = 0, n = 0;
	for (const s of sides) {
		await pool(list, jobs, async ex => {
			const r = await runExample(ex, s, { seq: ++seq, label, mode, gl2: has("--gl2"), refLabel: opt("--ref", label) });
			n++;
			const errs = r.exceptions.length + r.consoleErrors.length;
			console.log(`${String(n).padStart(3)} ${s.padEnd(5)} ${ex.name.padEnd(56)} ${String(r.end).padEnd(8)} ${((r.t?.done ?? 0) / 1000).toFixed(1).padStart(5)}s  例外${errs}  net ${r.net.hits}/${r.net.recorded}${r.net.missCount ? ` miss${r.net.missCount}` : ""}`);
		});
	}
	console.log(`\n${((Date.now() - t0) / 60000).toFixed(1)} 分`);
} finally {
	stop();
}
if (sides.includes("ortho") && opt("--ref")) process.exitCode = gradeRuns(opt("--ref"), label, { update: has("--update") });
