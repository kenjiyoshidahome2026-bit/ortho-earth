// convert/calibrate.js ── VW ランク閾値を arc ごとに Douglas–Peucker の予算へ較正する（tippecanoe -S 相当）。
//
// 固定則 r = 63 − 3(z + log2(extent/256)) は「VW 面積 ≈ 1 タイル単位²」の頂点を残す。tippecanoe は DP で「弦からの距離
// > 1 単位」の頂点だけ残す。VW 面積 A と DP 距離 d の関係は d ≈ 2A/L（L は隣接点間隔）＝線分が長い arc ほど VW は DP より
// 多く残し、小島のような小さな閉環では DP が最低 3 点残すのに VW は丸ごと落とす。全体の頂点数を合わせる較正では小島の
// 分を海岸線で埋めて過剰になる（NE の中国が DP 724 頂点に対し 2,711）。
//
// そこで arc ごとに：① DP 重要度（各頂点が残り始める許容差 ε・1 回の分解で全ズーム分）を求め、② ズーム z の許容差
// tol_z = tolerance 単位を世界座標に直して DP が残す数 want(z) を数え、③ その arc のランク分布から「残る数が want に最も
// 近い」ランク閾値 t(a, z) を選ぶ。頂点の選び方は VW のまま（共有境界は両側で同じ頂点列）で、予算だけ DP に合わせる。
// 出力は Uint8Array(zoomCount × arcCount)（k 優先・slot = k·arcCount + a）＝LOD カーネルが arc 毎に引く。

// 折れ線の DP 重要度：eps[i] = その頂点が残るための許容差の上限（端点は Infinity・親より大きくならない）。座標は倍精度
function dpImportance(xy, off, n, eps) {
	eps[0] = Infinity; eps[n - 1] = Infinity;
	if (n <= 2) return;
	const stack = [0, n - 1, Infinity];
	while (stack.length) {
		const pe = stack.pop(), j = stack.pop(), i = stack.pop();
		if (j - i < 2) continue;
		const ax = xy[(off + i) * 2], ay = xy[(off + i) * 2 + 1], dx = xy[(off + j) * 2] - ax, dy = xy[(off + j) * 2 + 1] - ay, l2 = dx * dx + dy * dy;
		let best = -1, bd = -1;
		for (let k = i + 1; k < j; k++) {
			const px = xy[(off + k) * 2] - ax, py = xy[(off + k) * 2 + 1] - ay;
			let d;
			if (l2 === 0) d = px * px + py * py;
			else { let u = (px * dx + py * dy) / l2; u = u < 0 ? 0 : u > 1 ? 1 : u; const ex = px - u * dx, ey = py - u * dy; d = ex * ex + ey * ey; }
			if (d > bd) { bd = d; best = k; }
		}
		const e = Math.min(pe, Math.sqrt(bd));
		eps[best] = e;
		stack.push(i, best, e, best, j, e);
	}
}

// 戻り: { arcThresholds: Uint8Array(zoomCount·arcCount), stats: { vertices, dpKept: number[], vwKept: number[] } }
// arcCount は点を含まない arc 数（点は表では 0＝常に残す）。totalArcs は点込みの表の幅。
export function calibrateArcThresholds({ xy, rk, arcs, arcCount, totalArcs = arcCount, extentShift, minZoom, maxZoom, tolerance = 1, lodBias = 0 }) {
	const zoomCount = maxZoom - minZoom + 1;
	const table = new Uint8Array(zoomCount * totalArcs);
	const tol = new Float64Array(zoomCount);
	for (let k = 0; k < zoomCount; k++) { const sh = 32 - (minZoom + k) - extentShift; tol[k] = sh >= 0 ? tolerance * Math.pow(2, sh) : tolerance / Math.pow(2, -sh); }
	const dpKept = new Float64Array(zoomCount), vwKept = new Float64Array(zoomCount);
	let epsBuf = new Float64Array(1024), vertices = 0;
	const cum = new Int32Array(65);
	for (let a = 0; a < arcCount; a++) {
		const off = arcs[a * 2], n = arcs[a * 2 + 1];
		vertices += n;
		if (n > epsBuf.length) epsBuf = new Float64Array(n * 2);
		dpImportance(xy, off, n, epsBuf);
		// ランク分布（cum[t] = ランク ≥ t の頂点数）
		cum.fill(0);
		for (let i = 0; i < n; i++) cum[rk[off + i]]++;
		for (let t = 63; t >= 0; t--) cum[t] += cum[t + 1];
		for (let k = 0; k < zoomCount; k++) {
			let want = 0; const tk = tol[k];
			for (let i = 0; i < n; i++) if (epsBuf[i] > tk) want++;
			// cum は t について単調非増加：want を跨ぐ最大の t（cum[t] ≥ want）を二分探索し、t+1 と対数比で近い方
			let lo = 0, hi = 63;
			while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cum[mid] >= want) lo = mid; else hi = mid - 1; }
			let t = lo;
			if (lo < 63 && cum[lo + 1] > 0 && Math.abs(Math.log(cum[lo + 1] / want)) < Math.abs(Math.log(cum[lo] / want))) t = lo + 1;
			dpKept[k] += want; vwKept[k] += cum[t];
			t = Math.max(0, Math.min(63, Math.round(t + lodBias)));
			table[k * totalArcs + a] = t;
		}
	}
	return { arcThresholds: table, stats: { vertices, dpKept: Array.from(dpKept), vwKept: Array.from(vwKept) } };
}
