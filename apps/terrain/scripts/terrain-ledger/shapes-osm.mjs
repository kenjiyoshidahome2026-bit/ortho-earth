#!/usr/bin/env node
// 川の形＝OpenStreetMap の川の関係（type=waterway）から、台帳の川ぶんだけ取る → .cache/shapes-rivers.json（qid → GeoJSON geometry）
//   © OpenStreetMap contributors・ODbL（https://www.openstreetmap.org/copyright）＝この線を含む terrain.geopbf の川は ODbL に従う。
//   なぜ OSM か：国土数値情報の河川（W05）は使用許諾が「非商用」（複製物の再配布不可・2026-10-13 に一次資料で確認）＝配る台帳に使えない。
//   結び＝関係の wikidata タグ＝台帳の qid（名前で探さない＝荒川・大野川のような同名の取り違えが起きない）。2026-10-13＝298 本中 290 本台。
//   取り方＝① Overpass で日本の川の関係のタグだけ（1 回・.cache/osm/relations.json）② 本家 API の relation/<id>/full.json を 1 本ずつ
//          （.cache/osm/<id>.json・在る物は取り直さない＝Overpass の geom 一括は 504 が出る）
//   形＝本流（role が main_stream か空）の way を端点の節でつなぎ、0.0003°（約 30 m）の Douglas–Peucker で間引く（shapes-ksj.mjs と同じ尺）。
//       分流（side_stream・anabranch）と支流（関係のメンバーの関係）は入れない
//   補い＝関係が無い川・関係が途中までの川（長さが台帳の 75% 未満）・手動層 osm.byName の川は、同じ名の way（waterway=river|stream・
//       台帳の位置の ±1.5°）を Overpass で取り（.cache/osm/name-<名前>.json）、関係の線（無ければ台帳の位置に最も近い束）から
//       20 km 以内で続く束だけ足す＝ダム湖で線が切れる川（梓川）は拾い、離れた同名の川は拾わない
//   引数: --refresh（関係の一覧を取り直す）  --only 信濃川,利根川（名指し）
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DIR, CACHE, kmOf, readManual } from "./lib.mjs";
const argv = process.argv.slice(2), opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);   // 細い回線だと既定の 250 ms では IPv6/IPv4 の試し分けが間に合わず fetch が UND_ERR_CONNECT_TIMEOUT で落ちる（curl は通る・2026-10-13）
const OSM = path.join(CACHE, "osm"); fs.mkdirSync(OSM, { recursive: true });
const UA = { "User-Agent": "ortho-earth terrain-ledger (https://www.ortho-earth.com/)" };
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const db = JSON.parse(fs.readFileSync(path.join(DIR, "../../../../ortho-data/japan/terrain.json"), "utf8"));
const only = (opt("--only") || "").split(",").filter(Boolean);
const R = db.items.filter(it => it.category === "river" && (!only.length || only.includes(it.name.ja)));

// ── ① 日本の川の関係の一覧（タグだけ）──
const relFile = path.join(OSM, "relations.json");
if (argv.includes("--refresh") || !fs.existsSync(relFile)) {
	const q = '[out:json][timeout:180];area["ISO3166-1"="JP"][admin_level=2]->.jp;relation["type"="waterway"](area.jp);out tags;';
	let ok = false;
	for (let n = 0; n < 6 && !ok; n++) { const ep = OVERPASS[n % OVERPASS.length];
		try { const r = await fetch(ep, { method: "POST", headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q), signal: AbortSignal.timeout(240e3) });
			if (r.ok) { fs.writeFileSync(relFile, await r.text()); ok = true; } else console.error("Overpass", ep, r.status); } catch (e) { console.error("Overpass", ep, e.message); }
		if (!ok) await sleep(20e3); }
	if (!ok) { console.error("川の関係の一覧が取れない（Overpass が混んでいる）＝時間を置く"); process.exit(1); }
}
const byQid = new Map(); for (const e of JSON.parse(fs.readFileSync(relFile, "utf8")).elements) { const q = e.tags?.wikidata; if (q) (byQid.get(q) || byQid.set(q, []).get(q)).push(e.id); }

// ── ② 関係の中身（way と節）──
async function full(id) {
	const f = path.join(OSM, id + ".json"); if (fs.existsSync(f) && fs.statSync(f).size > 200) return JSON.parse(fs.readFileSync(f, "utf8"));
	for (let n = 0; n < 4; n++) {
		try { const r = await fetch(`https://api.openstreetmap.org/api/0.6/relation/${id}/full.json`, { headers: UA, signal: AbortSignal.timeout(120e3) });
			if (r.ok) { const t = await r.text(); fs.writeFileSync(f, t); await sleep(600); return JSON.parse(t); } console.error("OSM", id, r.status); } catch (e) { console.error("OSM", id, e.message); }
		await sleep(5e3 * (n + 1)); }
	return null;
}

function simplify(P, tol) {   // shapes-ksj.mjs と同じ DP（経度は cos 緯度で縮める）
	const n = P.length; if (n <= 2 || !(tol > 0)) return P;
	const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1; const t2 = tol * tol, st = [[0, n - 1]];
	while (st.length) { const [a, b] = st.pop(); if (b - a < 2) continue;
		const k = Math.cos(((P[a][1] + P[b][1]) / 2) * Math.PI / 180), ax = P[a][0] * k, ay = P[a][1], dx = P[b][0] * k - ax, dy = P[b][1] - ay, L2 = dx * dx + dy * dy; let best = -1, bd = t2;
		for (let i = a + 1; i < b; i++) { const px = P[i][0] * k - ax, py = P[i][1] - ay, t = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0, ex = px - t * dx, ey = py - t * dy, d = ex * ex + ey * ey; if (d > bd) { bd = d; best = i; } }
		if (best > 0) { keep[best] = 1; st.push([a, best], [best, b]); } }
	const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(P[i]); return out;
}
const round = p => [+p[0].toFixed(5), +p[1].toFixed(5)];
const lenOf = ls => ls.reduce((s, l) => { for (let i = 1; i < l.length; i++) s += kmOf(l[i - 1], l[i]); return s; }, 0);

// way（節の id の列）を端の節でつなぐ＝端の節に集まる線がちょうど 2 本の所だけ（分かれ目では繋がない）。向きが逆の way は裏返す
function chain(ways) {
	let lines = ways.map(w => w.slice());
	for (;;) {
		const ends = new Map(); for (const l of lines) for (const n of [l[0], l[l.length - 1]]) (ends.get(n) || ends.set(n, []).get(n)).push(l);
		let merged = false;
		for (const [n, ls] of ends) { if (ls.length !== 2 || ls[0] === ls[1]) continue;
			const [a, b] = ls, A = a[a.length - 1] === n ? a : a.slice().reverse(), B = b[0] === n ? b : b.slice().reverse();
			lines = lines.filter(l => l !== a && l !== b); lines.push(A.concat(B.slice(1))); merged = true; break; }
		if (!merged) return lines;
	}
}

// ── 補い：同じ名の way（節の id と座標つき）──
let overpassDown = false; const unfilled = [];   // Overpass が落ちている時は 1 本目で見切る＝補えなかった川を名指しして、後で回し直す（取れた物は .cache に残る）
async function byName(name, [lon, lat]) {
	const f = path.join(OSM, `name-${name}.json`); if (fs.existsSync(f) && fs.statSync(f).size > 100) return JSON.parse(fs.readFileSync(f, "utf8")).elements;
	if (overpassDown) { unfilled.push(name); return null; }
	const q = `[out:json][timeout:60];way["waterway"~"^(river|stream)$"]["name"="${name}"](${lat - 1.5},${lon - 1.5},${lat + 1.5},${lon + 1.5});out geom;`;
	for (let n = 0; n < 8; n++) { const ep = OVERPASS[n % 2 ? 1 + (n >> 1) % (OVERPASS.length - 1) : 0];   // 本家を 1 回おきに・間に他の口
		try { const r = await fetch(ep, { method: "POST", headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q), signal: AbortSignal.timeout(45e3) });
			if (r.ok) { const t = await r.text(); if (t.startsWith("{")) { fs.writeFileSync(f, t); return JSON.parse(t).elements; } } } catch { /* 混んでいる＝次の口へ */ }
		await sleep(8e3); }
	overpassDown = true; unfilled.push(name); return null;
}
// 束（節を共有する way の集まり）のうち、種（関係の線の点・無ければ台帳の位置に最も近い束）から gap km 以内で続く物の way
function nearBundles(E, seedPts, coord, gap = 20) {
	const par = new Map(), find = x => { while ((par.get(x) ?? x) !== x) { par.set(x, par.get(par.get(x)) ?? par.get(x)); x = par.get(x); } return x; };
	for (const e of E) for (const n of e.nodes) par.set(find("n" + n), find("w" + e.id));
	const B = new Map(); for (const e of E) { const k = find("w" + e.id); (B.get(k) || B.set(k, []).get(k)).push(e); }
	const ptsOf = b => b.flatMap(e => e.geometry.filter((_, i) => i % 4 === 0 || i === e.geometry.length - 1).map(p => [p.lon, p.lat]));
	const rest = [...B.values()].map(b => ({ b, pts: ptsOf(b) })), dist = (A, P) => { let d = Infinity; for (const a of A) for (const p of P) d = Math.min(d, kmOf(a, p)); return d; };
	let S = seedPts;
	if (!S.length) { rest.sort((x, y) => dist([coord], x.pts) - dist([coord], y.pts)); if (!rest.length || dist([coord], rest[0].pts) > 30) return []; }
	const out = [];
	for (let grew = true; grew;) { grew = false;
		for (const r of rest) { if (r.used) continue; if (!S.length || dist(S.filter((_, i) => i % 3 === 0), r.pts) <= gap) { r.used = true; out.push(...r.b); S = S.concat(r.pts); grew = true; if (!seedPts.length && out.length === r.b.length) break; } } }
	return out;
}
const forceByName = new Set(readManual().osm?.byName || []);

const rivers = {}, report = [], none = [];
for (const it of R) {
	const ids = byQid.get(it.qid) || [];
	const nodes = new Map(), ways = [], wayIds = new Set(); let filled = 0;
	for (const id of ids) {
		const d = await full(id); if (!d) { console.error("取れない", it.name.ja, id); continue; }
		const wayOf = new Map(); for (const e of d.elements) { if (e.type === "node") nodes.set(e.id, [e.lon, e.lat]); else if (e.type === "way") wayOf.set(e.id, e.nodes); }
		const rel = d.elements.find(e => e.type === "relation" && e.id === id), mem = (rel?.members || []).filter(m => m.type === "way" && wayOf.has(m.ref));
		const main = mem.filter(m => m.role === "main_stream" || m.role === "");
		for (const m of main.length ? main : mem) { ways.push(wayOf.get(m.ref)); wayIds.add(m.ref); }
	}
	const kmNow = lenOf(ways.map(w => w.map(n => nodes.get(n)).filter(Boolean)));
	if (!ways.length || forceByName.has(it.name.ja) || (it.length && kmNow < it.length * 0.75)) {
		const E = await byName(it.name.ja, it.coord);
		if (E) for (const e of nearBundles(E.filter(e => !wayIds.has(e.id)), ways.flatMap(w => w.filter((_, i) => i % 4 === 0).map(n => nodes.get(n)).filter(Boolean)), it.coord)) {
			e.nodes.forEach((n, i) => nodes.set(n, [e.geometry[i].lon, e.geometry[i].lat])); ways.push(e.nodes); wayIds.add(e.id); filled++; }
	}
	if (!ways.length) { none.push(it.name.ja); continue; }
	const lines = chain(ways).map(l => simplify(l.map(n => nodes.get(n)).filter(Boolean), 0.0003).map(round)).filter(l => l.length >= 2).sort((a, b) => lenOf([b]) - lenOf([a]));
	rivers[it.qid] = lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines };
	let near = Infinity; for (const l of lines) for (const p of l) near = Math.min(near, kmOf(it.coord, p));
	report.push({ name: it.name.ja, qid: it.qid, rel: ids.join(" "), ...(filled ? { byName: filled } : {}), parts: lines.length, pts: lines.reduce((s, l) => s + l.length, 0), km: Math.round(lenOf(lines)), ledgerKm: it.length ?? "", nearKm: +near.toFixed(1) });
	process.stderr.write(`川 ${report.length}/${R.length}\r`);
}
if (!only.length) fs.writeFileSync(path.join(CACHE, "shapes-rivers.json"), JSON.stringify(rivers));
fs.writeFileSync(path.join(CACHE, "shapes-rivers-report.json"), JSON.stringify(report, null, 1));
// 検札：長さが台帳（Wikidata）と大きく違う物・台帳の位置から遠い物を名指しする（人が見る）
const off = report.filter(r => r.ledgerKm && (r.km < r.ledgerKm * 0.7 || r.km > r.ledgerKm * 1.3)), far = report.filter(r => r.nearKm > 30);
console.error(`\n川 ${report.length} / ${R.length}・頂点 ${report.reduce((s, r) => s + r.pts, 0)}・線 ${report.reduce((s, r) => s + r.parts, 0)} 本`);
if (none.length) console.error("OSM に形が無い:", none.join(" "));
if (unfilled.length) console.error("Overpass が不通で補えなかった（後で回し直す）:", unfilled.join(" "));
const fill = report.filter(r => r.byName); if (fill.length) console.error("同じ名の way で補った:", fill.map(r => `${r.name} +${r.byName} 本 → ${r.km}${r.ledgerKm ? "/" + r.ledgerKm : ""}km`).join("・"));
if (off.length) console.error("長さが台帳と 3 割以上違う:", off.map(r => `${r.name} ${r.km}/${r.ledgerKm}km`).join("・"));
if (far.length) console.error("台帳の位置から 30 km 以上:", far.map(r => `${r.name} ${r.nearKm}km`).join("・"));
