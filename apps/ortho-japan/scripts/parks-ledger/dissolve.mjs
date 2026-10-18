// 国立公園の外周を溶かす（2026-10-18 に dissolve.py から移植）：node dissolve.mjs ＝ nps_all.geojson → parks-boundary.geojson
// 地種区分の面を公園（名称）ごとに束ね、共有辺の相殺→環の連結→DP 間引き（TOL°）→入れ子で穴を決める。
import fs from "node:fs";

const fc = JSON.parse(fs.readFileSync("nps_all.geojson", "utf8"));
const TOL = 0.0005;
// python の round（偶数丸め）と同じ
const roundEven = v => { const f = Math.floor(v), d = v - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); };

function dp(pts, tol) {
	if (pts.length < 5) return pts;
	const keep = pts.map(() => false); keep[0] = keep[pts.length - 1] = true;
	const st = [[0, pts.length - 1]];
	while (st.length) {
		const [a, b] = st.pop(), [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
		let mx = -1, mi = -1;
		for (let i = a + 1; i < b; i++) {
			const [px, py] = pts[i];
			let d;
			if (L === 0) d = Math.hypot(px - ax, py - ay);
			else { const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)); d = Math.hypot(px - ax - t * dx, py - ay - t * dy); }
			if (d > mx) { mx = d; mi = i; }
		}
		if (mx > tol) { keep[mi] = true; st.push([a, mi]); st.push([mi, b]); }
	}
	return pts.filter((_, i) => keep[i]);
}
function sarea(r) {
	let s = 0;
	for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
	return s / 2;
}
function pip([x, y], r) {
	let ins = false;
	for (let i = 0; i < r.length - 1; i++) {
		const [x1, y1] = r[i], [x2, y2] = r[i + 1];
		if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) ins = !ins;
	}
	return ins;
}

const parks = new Map();
for (const f of fc.features) {
	const g = f.geometry, polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates], name = f.properties["名称"];
	if (!parks.has(name)) parks.set(name, []);
	parks.get(name).push(...polys);
}
const out = [], stats = [];
for (const [name, polys] of parks) {
	// 1) 共有辺の相殺（整数化キー）
	const K = p => `${roundEven(p[0] * 1e6)},${roundEven(p[1] * 1e6)}`;
	const edges = new Map();   // "a|b" → 回数（Map は python の dict と同じく挿入順）
	for (const poly of polys) for (const ring of poly) for (let i = 0; i < ring.length - 1; i++) {
		const a = K(ring[i]), b = K(ring[i + 1]);
		if (a === b) continue;
		if (edges.has(`${b}|${a}`)) edges.delete(`${b}|${a}`);
		else edges.set(`${a}|${b}`, (edges.get(`${a}|${b}`) ?? 0) + 1);
	}
	// 2) 残った辺を環に繋ぐ
	const nxt = new Map(), xy = k => k.split(",").map(Number);
	for (const e of edges.keys()) { const [a, b] = e.split("|"); if (!nxt.has(a)) nxt.set(a, []); nxt.get(a).push(b); }
	const rings = [], used = new Set();
	for (const e of [...edges.keys()]) {
		if (used.has(e)) continue;
		const a = e.split("|")[0], ring = [a];
		let cur = a, prev = null;
		for (;;) {
			const cands = (nxt.get(cur) ?? []).filter(c => !used.has(`${cur}|${c}`));
			if (!cands.length) break;
			// 分岐点は直前の進行方向から最も右に曲がる辺を選ぶ（外周を保つ）
			if (cands.length > 1 && prev !== null) {
				const [px, py] = xy(prev), [cx, cy] = xy(cur);
				const ang = c => { const [nx, ny] = xy(c), v1 = [cx - px, cy - py], v2 = [nx - cx, ny - cy]; return -Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1]); };
				cands.sort((p, q) => ang(p) - ang(q));
			}
			const c = cands[0]; used.add(`${cur}|${c}`); ring.push(c); prev = cur; cur = c;
			if (cur === a) break;
		}
		if (ring.length > 3 && ring[0] === ring[ring.length - 1]) rings.push(ring.map(k => xy(k).map(v => v / 1e6)));
	}
	// 3) 間引き・極小を捨てる
	const rs = [];
	for (const r of rings) {
		if (Math.abs(sarea(r)) < (TOL * 3) ** 2) continue;
		const s = dp(r, TOL);
		if (s.length >= 4 && Math.abs(sarea(s)) > 0) rs.push(s);
	}
	// 4) 入れ子（偶数深さ=外周・奇数=穴）
	const depth = rs.map((r, i) => rs.filter((o, j) => j !== i && Math.abs(sarea(o)) > Math.abs(sarea(r)) && pip(r[0], o)).length);
	const polysOut = [];
	rs.forEach((r0, i) => {
		if (depth[i] % 2 !== 0) return;
		const r = sarea(r0) < 0 ? [...r0].reverse() : r0;
		const holes = rs.filter((h, j) => depth[j] === depth[i] + 1 && pip(h[0], r)).map(h => sarea(h) < 0 ? h : [...h].reverse());
		polysOut.push([r, ...holes]);
	});
	const nv = polysOut.reduce((s, p) => s + p.reduce((t, x) => t + x.length, 0), 0);
	stats.push([name, polys.length, rings.length, rs.length, polysOut.length, nv]);
	out.push({ type: "Feature", properties: { name }, geometry: { type: "MultiPolygon", coordinates: polysOut } });
}
for (const s of stats) console.log(s);
console.log("total vertices", stats.reduce((s, x) => s + x[5], 0));
fs.writeFileSync("parks-boundary.geojson", JSON.stringify({ type: "FeatureCollection", features: out }));
