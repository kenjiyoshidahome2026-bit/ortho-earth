#!/usr/bin/env node
// 湖と川の形＝国土数値情報（W09 湖沼・W05 河川）から、種に結んだ地形ぶんだけ切り出す → .cache/shapes-lakes.json / shapes-rivers.json（qid → GeoJSON geometry）
//   引数: --ksj DIR（W09-05-g_Lake.* と w05/<都道府県コード>/*Stream.* がある場所。既定 .cache/ksj）
//   川＝同じ名の川が各地にある（荒川・大野川）→ 河川名 × 水系域コード（W05_001）で束ね、種の位置（地理院の注記の位置）に最も近い束を取る。
//       束の区間（LineString）を端点でつないで本数を減らし、0.0003°（約 30 m）の Douglas–Peucker で間引く（1:25,000 の折れを z16 でも足りる程度に）
//   湖＝湖沼名（W09_001）の一致（名前のゆれ込み）で最寄り。面はそのまま（環の向きは RFC 7946 に直す）
import fs from "node:fs";
import path from "node:path";
import { readShp } from "./shp.mjs";
import { CACHE, readSeed, readManual, variants, kmOf } from "./lib.mjs";
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const KSJ = opt("--ksj", path.join(CACHE, "ksj"));
const seed = readSeed(), match = JSON.parse(fs.readFileSync(path.join(CACHE, "match.json"), "utf8"));
const want = cat => seed.filter(s => s.cat === cat && match[s.key]).map(s => ({ ...s, qid: match[s.key].qid }));

// ── 間引き（lib の simplify＝physical.js と同じ DP・経度は cos 緯度で縮める）──
function simplify(P, tol, closed) {
	const n = P.length, min = closed ? 4 : 2; if (n <= min || !(tol > 0)) return P;
	const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1; const t2 = tol * tol, st = [[0, n - 1]];
	while (st.length) { const [a, b] = st.pop(); if (b - a < 2) continue;
		const k = Math.cos(((P[a][1] + P[b][1]) / 2) * Math.PI / 180), ax = P[a][0] * k, ay = P[a][1], dx = P[b][0] * k - ax, dy = P[b][1] - ay, L2 = dx * dx + dy * dy; let best = -1, bd = t2;
		for (let i = a + 1; i < b; i++) { const px = P[i][0] * k - ax, py = P[i][1] - ay, t = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0, ex = px - t * dx, ey = py - t * dy, d = ex * ex + ey * ey; if (d > bd) { bd = d; best = i; } }
		if (best > 0) { keep[best] = 1; st.push([a, best], [best, b]); } }
	const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(P[i]); return out.length >= min ? out : P;
}
const round = p => [+p[0].toFixed(5), +p[1].toFixed(5)];

// ── 湖 ──
const lakes = {};
{
	const L = readShp(path.join(KSJ, "W09-05-g_Lake"));
	const byName = new Map(); for (const r of L.records) { if (!r.geometry) continue; for (const v of variants(r.props.W09_001)) (byName.get(v) || byName.set(v, []).get(v)).push(r); }
	const centroid = g => { const r = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0]; return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length]; };
	for (const s of want("lake")) {
		const cands = []; for (const v of variants(s.name)) for (const r of byName.get(v) || []) if (!cands.includes(r)) cands.push(r);
		let best = null, bd = 40; for (const r of cands) { const d = kmOf([s.lon, s.lat], centroid(r.geometry)); if (d < bd) { bd = d; best = r; } }
		if (!best) continue;
		// 同名・同湖の複数面（湖が面で分かれる＝霞ヶ浦・中海）は 40 km 内の同名を全部まとめる
		const parts = cands.filter(r => kmOf(centroid(best.geometry), centroid(r.geometry)) < 40).flatMap(r => r.geometry.type === "Polygon" ? [r.geometry.coordinates] : r.geometry.coordinates);
		const fix = poly => poly.map((ring, i) => { let a = 0; for (let k = 1; k < ring.length; k++) a += (ring[k][0] - ring[k - 1][0]) * (ring[k][1] + ring[k - 1][1]); const ccw = a < 0; return (i === 0 ? ccw : !ccw) ? ring : ring.slice().reverse(); }).map(r => simplify(r, 0.0003, true).map(round));
		lakes[s.qid] = parts.length === 1 ? { type: "Polygon", coordinates: fix(parts[0]) } : { type: "MultiPolygon", coordinates: parts.map(fix) };
	}
	console.error("湖", Object.keys(lakes).length, "/", want("lake").length);
}
fs.writeFileSync(path.join(CACHE, "shapes-lakes.json"), JSON.stringify(lakes));

// ── 川 ──
const rivers = {};
{
	// 国土数値情報の河川名が台帳の名と違う物（四万十川＝渡川・十津川＝熊野川の上流名…）＝手動層 w05 の別名を variants に足す
	const w05alias = (readManual().w05 || {});
	const namesOf = s => [...variants(s.name), ...(w05alias[s.name] ? [w05alias[s.name]] : [])];
	const R = want("river"), names = new Map(); for (const s of R) for (const v of namesOf(s)) (names.get(v) || names.set(v, []).get(v)).push(s);
	const groups = new Map();   // name|水系 → { pts: [...], lines }
	for (const d of fs.readdirSync(path.join(KSJ, "w05")).sort()) {
		const dir = path.join(KSJ, "w05", d); if (!fs.statSync(dir).isDirectory()) continue;
		const found = []; (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/Stream\.shp$/i.test(f)) found.push(p); } })(dir);
		if (!found.length) continue;   // zip の中の入れ子（W05-09_01-g_GML/）も探す
		const S = readShp(found[0].replace(/\.shp$/i, ""));
		for (const r of S.records) { const n = r.props.W05_004; if (!r.geometry || !n || !names.has(n)) continue;
			const k = n + "|" + r.props.W05_001, g = groups.get(k) || groups.set(k, { name: n, lines: [] }).get(k);
			const ls = r.geometry.type === "LineString" ? [r.geometry.coordinates] : r.geometry.coordinates; g.lines.push(...ls); }
		process.stderr.write(`W05 ${d} 束 ${groups.size}\r`);
	}
	// 種ごとに最寄りの束（束の全点の最小距離）
	for (const s of R) {
		let best = null, bd = 60;
		for (const g of groups.values()) { if (!namesOf(s).includes(g.name)) continue;
			let d = Infinity; for (const l of g.lines) for (let i = 0; i < l.length; i += 5) d = Math.min(d, kmOf([s.lon, s.lat], l[i])); if (d < bd) { bd = d; best = g; } }
		if (!best) continue;
		// 端点でつなぐ（同じ点で終わる・始まる区間を 1 本に）
		const key = p => p[0].toFixed(6) + "," + p[1].toFixed(6), byStart = new Map(), lines = best.lines.map(l => l.slice());
		for (const l of lines) (byStart.get(key(l[0])) || byStart.set(key(l[0]), []).get(key(l[0]))).push(l);
		const used = new Set(), out = [];
		for (const l0 of lines) { if (used.has(l0)) continue; used.add(l0); let cur = l0;
			for (;;) { const nx = (byStart.get(key(cur[cur.length - 1])) || []).find(x => !used.has(x)); if (!nx) break; used.add(nx); cur = cur.concat(nx.slice(1)); }
			out.push(simplify(cur, 0.0003, false).map(round)); }
		rivers[s.qid] = out.length === 1 ? { type: "LineString", coordinates: out[0] } : { type: "MultiLineString", coordinates: out };
	}
	console.error("\n川", Object.keys(rivers).length, "/", R.length);
}
fs.writeFileSync(path.join(CACHE, "shapes-rivers.json"), JSON.stringify(rivers));
