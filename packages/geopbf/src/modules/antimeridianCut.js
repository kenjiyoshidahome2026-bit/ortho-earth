export function antimeridianCut(points, isLine = false) {
	const { PI, sin, cos, sqrt, atan2, abs } = Math, d2r = PI / 180, tub = [];
	if (!points?.length) return tub;
	const is_ring = _ => _.length > 1 && _[0][0] === _[_.length - 1][0] && _[0][1] === _[_.length - 1][1];
	const fix = x => x === 180 ? 180 : ((((x + 180) % 360) + 360) % 360) - 180;   // +180 は保つ（-180 へ書き換えると西側の縫い目頂点が偽の跨ぎになる）
	const pts = points.filter(t => t && typeof t[0] === 'number').map(t => [fix(t[0]), t[1]]);
	const north = (pts.reduce((s, t) => s + t[1], 0) / pts.length) > 0;
	const straddles = p => {
		const a = [[], []];
		for (let i = 0; i < p.length - 1; i++) {
			if (p[i][0] * p[i + 1][0] < 0 && abs(p[i][0] - p[i + 1][0]) > 180) {
				a[((p[i][0] > 0) ? (p[i + 1][0] < p[i][0] - 180) : (p[i][0] < p[i + 1][0] - 180)) ? 0 : 1].push(i);
			}
		}
		return a;
	};
	const intersect = ([x0, y0], [x1, y1], f = 1) => {
		const x = sin((y0 - y1) * d2r) * sin((x0 + x1) / 2 * d2r) * cos((x0 - x1) / 2 * d2r) - sin((y0 + y1) * d2r) * cos((x0 + x1) / 2 * d2r) * sin((x0 - x1) / 2 * d2r);
		const z = cos(y0 * d2r) * cos(y1 * d2r) * sin((x0 - x1) * d2r), r = (f * z < 0 ? -1 : 1) * atan2(x, abs(z)) / d2r;
		return isNaN(r) ? y0 : r;
	};
	(is_ring(pts) && !isLine ? splitPolygon : splitPloyLine)(pts);
	return tub;
	function splitPolygon(p) {
		let s = 0; for (let i = 0; i < p.length - 1; i++) s += (p[i + 1][0] - p[i][0]) * (p[i + 1][1] + p[i][1]);
		if (s < 0) p.reverse();
		const cr = straddles(p);
		if (cr[0].length + cr[1].length === 1) return tub.push(poleRing(p, cr[0].length ? [cr[0][0], 1] : [cr[1][0], -1]));   // 縫い目を1回だけ跨ぐ環＝極を囲む（球面では閉じているが経緯度では極が特異点）
		if (!cr[0].length) return tub.push(p);
		const c0 = cr[0].map(i => [intersect(p[i], p[i + 1], 1), i]).sort(([a], [b]) => north ? a - b : b - a);
		const c1 = cr[1].map(i => [intersect(p[i], p[i + 1], -1), i]).sort(([a], [b]) => north ? b - a : a - b);
		const start = c0[0], end = c0[1], rev = c1[0];
		if (!start) return tub.push(p);
		if (end || rev) { cut(start, 1, end || rev, !!end); cut(end || rev, !!end, start, 1); } else tub.push(p);
		function cut(sP, sF, eP, eF) {
			if (!sP || !eP) return;
			const a = [], len = p.length - 1; let i = (sP[1] < len - 1) ? sP[1] + 1 : 0;
			const deg = 180 * (p[i][0] < 0 ? -1 : 1);
			a.push([sF ? deg : 0, sP[0]], p[i]);
			while (i !== eP[1]) a.push(p[i = (i < len - 1) ? i + 1 : 0]);
			a.push([eF ? deg : 0, eP[0]], [...a[0]]); tub.push(a);
		}
	}
	// 極を囲む環（縫い目跨ぎ1回）＝跨ぎ辺 p[i]→p[i+1] を切り [±180,lat]→[±180,±90]→[∓180,±90]→[∓180,lat] の柱で閉じる（RFC 7946 の極表現）。
	// 極の側は環の平均緯度（north）。球面編集（回転で極を越える・極を囲む作図）で生まれる環はこれで初めて GeoJSON/gint に載る（9/14）。
	function poleRing(p, [i, f]) {
		const lat = intersect(p[i], p[i + 1], f), pole = north ? 90 : -90, len = p.length - 1;
		const d0 = 180 * (p[i][0] < 0 ? -1 : 1), d1 = -d0, a = [];
		for (let k = 1; k <= len; k++) a.push(p[(i + k) % len]);   // p[i+1] … p[i]（閉じ重複を除く1周）
		a.push([d0, lat], [d0, pole], [d1, pole], [d1, lat], [...a[0]]);
		return a;
	}
	function splitPloyLine(p) {
		let i = 0; for (; i < p.length - 1; i++) if (p[i][0] * p[i + 1][0] < 0 && abs(p[i][0] - p[i + 1][0]) > 180) break;
		if (i === p.length - 1) return tub.push(p);
		const lat = intersect(p[i], p[i + 1], 1), s0 = 180 * (p[i][0] < 0 ? -1 : 1), s1 = -s0;   // 縫い目の側＝跨ぐ直前の点の符号（旧＝部品の最初の点＝0° を先に跨ぐ線で逆の側に付けていた）
		tub.push(p.slice(0, i + 1).concat([[s0, lat]]));
		splitPloyLine([[s1, lat]].concat(p.slice(i + 1)));
	}
}

// 頂点ごとの配列（attrs＝[time, ele …]・どれも点と同じ長さ）を連れて線を切る（#113 段 1・2026-09-29）＝GPX の trk・CZML の sampled position。
// 切り方は splitPloyLine と同じ（跨ぐ辺ごとに縫い目の点を両側へ足す）。縫い目の点の値は跨ぐ辺の上で経度の割合で内挿（時刻＝ISO 文字列・数＝線形・片方が null なら null）。
// 戻り＝{ parts: [[点…]…], attrs: [[部品ごとの配列…]（attrs[k][部品]）] }
export function antimeridianCutLineAttrs(points, attrs) {
	const { PI, sin, cos, atan2, abs } = Math, d2r = PI / 180;
	const fix = x => x === 180 ? 180 : ((((x + 180) % 360) + 360) % 360) - 180;
	const p = points.map(t => [fix(t[0]), t[1]]);
	const intersect = ([x0, y0], [x1, y1]) => {
		const x = sin((y0 - y1) * d2r) * sin((x0 + x1) / 2 * d2r) * cos((x0 - x1) / 2 * d2r) - sin((y0 + y1) * d2r) * cos((x0 + x1) / 2 * d2r) * sin((x0 - x1) / 2 * d2r);
		const z = cos(y0 * d2r) * cos(y1 * d2r) * sin((x0 - x1) * d2r), r = (z < 0 ? -1 : 1) * atan2(x, abs(z)) / d2r;
		return isNaN(r) ? y0 : r;
	};
	const lerp = (a, b, f) => {
		if (a == null || b == null) return null;
		if (typeof a === "number" && typeof b === "number") return a + (b - a) * f;
		const ta = Date.parse(a), tb = Date.parse(b);
		return Number.isFinite(ta) && Number.isFinite(tb) ? new Date(ta + (tb - ta) * f).toISOString() : null;
	};
	const parts = [], out = attrs.map(() => []);
	let cur = [], curA = attrs.map(() => []);
	for (let i = 0; i < p.length; i++) {
		cur.push(p[i]); attrs.forEach((a, k) => curA[k].push(a[i] ?? null));
		if (i + 1 < p.length && p[i][0] * p[i + 1][0] < 0 && abs(p[i][0] - p[i + 1][0]) > 180) {
			const a0 = p[i][0], b0 = p[i + 1][0], s0 = 180 * (a0 < 0 ? -1 : 1);
			const f = (s0 - a0) / ((a0 > 0 ? b0 + 360 : b0 - 360) - a0), lat = intersect(p[i], p[i + 1]);
			const v = attrs.map(a => lerp(a[i], a[i + 1], f));
			cur.push([s0, lat]); v.forEach((x, k) => curA[k].push(x));
			parts.push(cur); curA.forEach((a, k) => out[k].push(a));
			cur = [[-s0, lat]]; curA = v.map(x => [x]);
		}
	}
	parts.push(cur); curA.forEach((a, k) => out[k].push(a));
	return { parts, attrs: out };
}
