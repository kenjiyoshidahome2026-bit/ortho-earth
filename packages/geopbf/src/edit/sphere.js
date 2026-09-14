// geopbf/edit/sphere.js — 完全球体の純幾何（DOM なし・worker 安全・Node 試験可）。
// 編集モデル（回転移動）・エディタのオーバレイ/作図・gint 焼きの度アンカーが共有する正典。
// 方針（本人裁定 2026-09-14）: ①頂点は大円で結ぶ ②図形の移動は球の中心まわりの回転 ③円は球面上の小円。
// 楕円体は使わない（geoedit は ell=0 の完全球体として編集。計測だけが WGS84＝ortho-core geodesic.js）。
// 単位ベクトル [x,y,z]（x=経度0°赤道・z=北極）と四元数 [x,y,z,w] だけを使う。
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const wrapLon = x => (x >= -180 && x < 180) ? x : ((x + 180) % 360 + 360) % 360 - 180;
export const toVec = (lon, lat) => { const c = Math.cos(lat * D2R); return [c * Math.cos(lon * D2R), c * Math.sin(lon * D2R), Math.sin(lat * D2R)]; };
export const toLL = v => [wrapLon(Math.atan2(v[1], v[0]) * R2D), Math.atan2(v[2], Math.hypot(v[0], v[1])) * R2D];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
// 中心角 [0,π]（内積の acos より 0/π 近傍で安定）
export const angleBetween = (a, b) => { const c = cross(a, b); return Math.atan2(Math.hypot(c[0], c[1], c[2]), dot(a, b)); };
// 大円補間 a→b（最短側）。t∈[0,1]。ω≈0 は線形。対蹠（ω≈π）は大円が不定＝呼び手が避ける前提
export const slerp = (a, b, t) => {
	const w = angleBetween(a, b), s = Math.sin(w);
	if (s < 1e-12) return norm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
	const ka = Math.sin((1 - t) * w) / s, kb = Math.sin(t * w) / s;
	return [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
};
export const gcInterpolate = (p, q, t) => toLL(slerp(toVec(p[0], p[1]), toVec(q[0], q[1]), t));   // 経緯度→経緯度
export const gcMidpoint = (p, q) => gcInterpolate(p, q, 0.5);
export const gcDistanceDeg = (p, q) => angleBetween(toVec(p[0], p[1]), toVec(q[0], q[1])) * R2D;   // 中心角（度）
// ---- 回転（四元数 [x,y,z,w]）----
const anyPerp = a => norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
export const quatFromAxisAngle = (axis, ang) => { const u = norm(axis), s = Math.sin(ang / 2); return [u[0] * s, u[1] * s, u[2] * s, Math.cos(ang / 2)]; };
export const quatBetween = (a, b) => {   // a を b へ運ぶ最小回転（軸＝a×b）
	const c = cross(a, b), l = Math.hypot(c[0], c[1], c[2]), d = dot(a, b);
	if (l < 1e-15) return d > 0 ? [0, 0, 0, 1] : quatFromAxisAngle(anyPerp(a), Math.PI);
	return quatFromAxisAngle(c, Math.atan2(l, d));
};
export const quatMul = (p, q) => [   // p∘q（q を先に、p を後に）
	p[3] * q[0] + p[0] * q[3] + p[1] * q[2] - p[2] * q[1],
	p[3] * q[1] - p[0] * q[2] + p[1] * q[3] + p[2] * q[0],
	p[3] * q[2] + p[0] * q[1] - p[1] * q[0] + p[2] * q[3],
	p[3] * q[3] - p[0] * q[0] - p[1] * q[1] - p[2] * q[2],
];
export const quatInverse = q => [-q[0], -q[1], -q[2], q[3]];
export const quatAngle = q => 2 * Math.atan2(Math.hypot(q[0], q[1], q[2]), Math.abs(q[3]));   // 回転角 [0,π]
export const rotateVec = (q, v) => {   // v' = q v q*
	const [x, y, z, w] = q;
	const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
	return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
export const rotateLL = (q, lon, lat) => toLL(rotateVec(q, toVec(lon, lat)));
// 重心（ホイール回転の軸）＝折れ線列の辺長（中心角）重み球面平均（頂点密度の偏りに引かれない）。lists＝[[lon,lat],…] の配列（環は閉じ点込みでよい）。
// 辺が無い（全て単点/同一点）なら点の単純平均。退化（全点対蹠で打ち消し）は先頭点
export const gcCentroid = lists => {
	let sx = 0, sy = 0, sz = 0, first = null;
	const add = (v, w) => { sx += v[0] * w; sy += v[1] * w; sz += v[2] * w; };
	let edges = 0;
	for (const pts of lists) {
		let prev = null;
		for (const p of pts) {
			const v = toVec(p[0], p[1]);
			first ??= v;
			if (prev) { const w = Math.hypot(v[0] - prev[0], v[1] - prev[1], v[2] - prev[2]); if (w > 0) { add(slerp(prev, v, 0.5), w); edges++; } }   // 大円中点×弦長(=2sin(ω/2))＝弧上の単位ベクトル積分そのもの＝辺を細分しても同じ重心
			prev = v;
		}
	}
	if (!edges || Math.hypot(sx, sy, sz) < 1e-12) { sx = sy = sz = 0; for (const pts of lists) for (const p of pts) add(toVec(p[0], p[1]), 1); }
	const L = Math.hypot(sx, sy, sz);
	if (!(L > 1e-12)) return first ? toLL(first) : null;
	return toLL([sx / L, sy / L, sz / L]);
};
// 球面上の小円：中心 center から中心角 rDeg の n 点（閉じない・東から反時計回り＝経緯度の cos 補正円と同じ向き）
export const smallCircle = (center, rDeg, n = 36) => {
	const c = toVec(center[0], center[1]);
	let e = cross([0, 0, 1], c);
	e = Math.hypot(e[0], e[1], e[2]) < 1e-12 ? [1, 0, 0] : norm(e);   // 極では東が不定＝任意の基底
	const nn = cross(c, e);
	const cr = Math.cos(rDeg * D2R), sr = Math.sin(rDeg * D2R), out = [];
	for (let i = 0; i < n; i++) {
		const t = i / n * 2 * Math.PI, ct = Math.cos(t) * sr, st = Math.sin(t) * sr;
		out.push(toLL([c[0] * cr + e[0] * ct + nn[0] * st, c[1] * cr + e[1] * ct + nn[1] * st, c[2] * cr + e[2] * ct + nn[2] * st]));
	}
	return out;
};
