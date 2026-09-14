// 山脈ポリゴン（Natural Earth geography_regions_polys）→ 軸線（Kenji 2026-09-11「range は点では表しにくい＝ラインで持ち、表示時に spline＋ポリゴン化」・9/15「点数を増やして追従させる」）
//   手順: ポリゴン内部を格子で標本化 → 格子グラフ（8 近傍・km 距離）で最遠の 2 端を取り（2 回の Dijkstra）→ 一端からの測地距離の等値帯ごとに標本の重心を置く
//   ＝弧や鉤（アルプス・カルパティア・ヒマラヤ）でも「帯の中央」を通る折れ線になる。点数＝測地長 ÷ spacingKm（3〜40）。幅＝各帯で軸に直交する広がり（p10〜p90）の中央値 km
//   旧法（主成分軸に 2〜4 点）は弧に追従できなかったので置き換えた（9/15）。飛び地（MultiPolygon の別片）は最大の連結成分だけを使う
export function rangeAxis(features, { spacingKm = 120, minPoints = 3, maxPoints = 40, cells = 20000 } = {}) {
	const polys = [];   // [outer, holes...] の配列
	for (const f of features) { const g = f.geometry; if (!g) continue; (g.type == "MultiPolygon" ? g.coordinates : g.type == "Polygon" ? [g.coordinates] : []).forEach(p => polys.push(p)); }
	if (!polys.length) return null;
	let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
	for (const p of polys) for (const [x, y] of p[0]) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
	const lat0 = (miny + maxy) / 2, ky = 110.57, kx0 = 111.32 * Math.cos(lat0 * Math.PI / 180);
	const stepKm = Math.sqrt((maxx - minx) * kx0 * (maxy - miny) * ky / cells) || 1;   // 格子＝bbox に約 cells 点
	const dx = stepKm / kx0, dy = stepKm / ky, nx = Math.max(1, Math.ceil((maxx - minx) / dx)), ny = Math.max(1, Math.ceil((maxy - miny) / dy));
	const id = new Int32Array(nx * ny).fill(-1), P = [];   // 内部セル → 標本番号。標本＝[lon, lat, xkm, ykm]
	for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
		const x = minx + (i + 0.5) * dx, y = miny + (j + 0.5) * dy;
		if (polys.some(p => insidePoly(p, x, y))) { id[j * nx + i] = P.length; P.push([x, y, (x - minx) * 111.32 * Math.cos(y * Math.PI / 180), (y - miny) * ky]); }
	}
	if (P.length < 20) return null;
	const cell = P.map((_, k) => k); const ci = new Int32Array(P.length), cj = new Int32Array(P.length);
	for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = id[j * nx + i]; if (k >= 0) { ci[k] = i; cj[k] = j; } }
	const nbr = k => { const out = []; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { if (!di && !dj) continue; const i = ci[k] + di, j = cj[k] + dj; if (i < 0 || j < 0 || i >= nx || j >= ny) continue; const m = id[j * nx + i]; if (m >= 0) out.push([m, di && dj ? stepKm * Math.SQRT2 : stepKm]); } return out; };
	const dijkstra = src => {   // 格子グラフの測地距離（二分ヒープ）
		const d = new Float64Array(P.length).fill(Infinity); d[src] = 0; const h = [[0, src]];
		const up = i => { while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } };
		const down = i => { for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < h.length && h[l][0] < h[m][0]) m = l; if (r < h.length && h[r][0] < h[m][0]) m = r; if (m === i) break; [h[m], h[i]] = [h[i], h[m]]; i = m; } };
		while (h.length) { const [dk, k] = h[0]; const last = h.pop(); if (h.length) { h[0] = last; down(0); } if (dk > d[k]) continue; for (const [m, w] of nbr(k)) if (dk + w < d[m]) { d[m] = dk + w; h.push([d[m], m]); up(h.length - 1); } }
		return d;
	};
	const far = d => { let b = -1, bd = -1; for (let k = 0; k < d.length; k++) if (d[k] < Infinity && d[k] > bd) { bd = d[k]; b = k; } return b; };
	// 最大の連結成分の中で最遠の 2 端（任意点 → 最遠 a → 最遠 b）
	let comp = new Int32Array(P.length).fill(-1), best = -1, bestN = 0;
	for (let s = 0; s < P.length; s++) if (comp[s] < 0) { const st = [s]; comp[s] = s; let n = 0; while (st.length) { const k = st.pop(); n++; for (const [m] of nbr(k)) if (comp[m] < 0) { comp[m] = s; st.push(m); } } if (n > bestN) { bestN = n; best = s; } }
	const a = far(dijkstra(best)), dA = dijkstra(a), b = far(dA), L = dA[b];
	if (!(L > 0)) return null;
	const k = Math.max(minPoints, Math.min(maxPoints, Math.round(L / spacingKm)));
	// 一端 a からの測地距離を k 帯に分け、帯ごとの重心を軸点に。帯は端を少し内側に寄せる（端の帯は細く歪む）
	const line = [], widths = [], bins = Array.from({ length: k }, () => []);
	for (let m = 0; m < P.length; m++) { if (comp[m] !== comp[a] || dA[m] === Infinity) continue; const t = Math.min(k - 1, Math.floor(dA[m] / L * k)); bins[t].push(m); }
	const cen = bins.map(B => B.length ? [B.reduce((s, m) => s + P[m][2], 0) / B.length, B.reduce((s, m) => s + P[m][3], 0) / B.length] : null).filter(Boolean);
	if (cen.length < 2) return null;
	for (let i = 0; i < cen.length; i++) {   // 幅＝軸の接線に直交する方向の広がり（p10〜p90）
		const B = bins[i]; if (!B || !B.length) continue;
		const p0 = cen[Math.max(0, i - 1)], p1 = cen[Math.min(cen.length - 1, i + 1)], tx = p1[0] - p0[0], ty = p1[1] - p0[1], tl = Math.hypot(tx, ty) || 1, nxv = -ty / tl, nyv = tx / tl;
		const off = B.map(m => (P[m][2] - cen[i][0]) * nxv + (P[m][3] - cen[i][1]) * nyv).sort((u, v) => u - v);
		widths.push(off[Math.floor(off.length * 0.9)] - off[Math.floor(off.length * 0.1)]);
	}
	const sm = cen.map((c, i) => i === 0 || i === cen.length - 1 ? c : [0.25 * cen[i - 1][0] + 0.5 * c[0] + 0.25 * cen[i + 1][0], 0.25 * cen[i - 1][1] + 0.5 * c[1] + 0.25 * cen[i + 1][1]]);   // 軽い平滑化（端は固定）
	for (const [xk, yk] of sm) { const lat = miny + yk / ky; line.push([+(minx + xk / (111.32 * Math.cos(lat * Math.PI / 180))).toFixed(3), +lat.toFixed(3)]); }
	widths.sort((u, v) => u - v);
	return { line, width: Math.round(widths[Math.floor(widths.length / 2)]), length: Math.round(lineLengthKm(line)) };
}
// 手書きの軸線（seed の axis 列 "lon lat;lon lat;…"）
export function parseAxis(s) {
	const line = String(s || "").split(";").map(p => p.trim().split(/\s+/).map(Number)).filter(p => p.length == 2 && p.every(Number.isFinite));
	return line.length >= 2 ? { line, length: Math.round(lineLengthKm(line)) } : null;
}
export function lineLengthKm(line) {
	let d = 0; for (let i = 1; i < line.length; i++) d += haversine(line[i - 1], line[i]); return d;
}
function haversine([x1, y1], [x2, y2]) {
	const r = Math.PI / 180, dLat = (y2 - y1) * r, dLon = (x2 - x1) * r, a = Math.sin(dLat / 2) ** 2 + Math.cos(y1 * r) * Math.cos(y2 * r) * Math.sin(dLon / 2) ** 2;
	return 6371 * 2 * Math.asin(Math.sqrt(a));
}
function insidePoly(rings, x, y) {   // 外環＋穴の偶奇判定
	let inside = false;
	for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i], [xj, yj] = ring[j];
		if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}
