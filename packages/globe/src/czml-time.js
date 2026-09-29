// CZML・GPX の時刻付きの位置を共通の時計で引く純関数（#113 段 2・2026-09-29）。main でも worker でも使える（依存なし）。
// 入り口は geopbf の地物＝時刻付きの線（LineString／MultiLineString）＋属性 time（ISO・点と同じ長さ・切った部品ごとの入れ子）＋ele（高さ m）。
// ±180° の切断で足された縫い目の点は時刻が null（geopbf 1.17.0〜・元の標本でない）＝時刻の無い点として除く。
// 補間は地球固定の直交座標（ECEF・WGS84）で行う＝Cesium と同じ（線形でも弦で結ぶ＝標本の間で高さが沈む・LAGRANGE は次数＋1 点）。
// 窓の決め方も Cesium（SampledProperty）と同じ：t より後の最初の標本 i → [i − ⌊次数/2⌋ − 1, その＋次数]（端は内側へずらす）・標本ちょうどはその標本・
// 標本の範囲の外は無し（外挿しない＝Cesium の既定 ExtrapolationType.NONE）。HERMITE は速度を読まない＝LAGRANGE として扱う（本人裁定）。
// 慣性系（INERTIAL）から地球固定へ直された標本（geopbf が czml.position に "ortho:frame" の印）は、慣性系へ戻して補間し、引いた時刻で地球固定へ回す
// ＝Cesium と同じ手順（固定系のまま補間すると継ぎ目と端で 20〜90 m ずれた）。時刻は ms の小数まで（geopbf の isoMs）。
import { inertialToFixed, isoMs, FRAME_KEY } from "geopbf/czml";
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F), D2R = Math.PI / 180;

export function llhToEcef(lon, lat, h = 0) {
	const s = Math.sin(lat * D2R), c = Math.cos(lat * D2R), N = A / Math.sqrt(1 - E2 * s * s);
	return [(N + h) * c * Math.cos(lon * D2R), (N + h) * c * Math.sin(lon * D2R), (N * (1 - E2) + h) * s];
}
export function ecefToLlh(x, y, z) {
	const lon = Math.atan2(y, x), p = Math.hypot(x, y);
	let lat = Math.atan2(z, p * (1 - E2)), N = A, h = 0;
	for (let i = 0; i < 5; i++) { const s = Math.sin(lat); N = A / Math.sqrt(1 - E2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - E2 * N / (N + h))); }
	return [lon / D2R, lat / D2R, h];
}

// 区間（"a/b" の ISO・その配列）→ [[a, b]…]（ms）｜null（無指定＝いつも）
export function parseIntervals(v) {
	if (v == null) return null;
	const list = (Array.isArray(v) ? v : [v]).map(s => typeof s === "string" ? s.split("/") : null).filter(q => q && q.length === 2).map(([a, b]) => [Date.parse(a), Date.parse(b)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
	return list.length ? list : null;
}
export const inIntervals = (ivs, ms) => !ivs || ivs.some(([a, b]) => ms >= a && ms <= b);

// 時刻付きの値（CZML の number プロパティ）：数・{ number }・区間ごと [{ interval, number（数か [t, v, …]）, epoch }]。標本の数列は線形（区間の外は dflt）
export function numberAt(v, ms, dflt = null) {
	if (v == null) return dflt;
	if (typeof v === "number") return v;
	if (Array.isArray(v)) { for (const q of v) { const iv = parseIntervals(q?.interval); if (!iv || inIntervals(iv, ms)) { const r = numberAt(q, ms, undefined); if (r !== undefined) return r; } } return dflt; }
	if (typeof v !== "object") return dflt;
	const n = v.number;
	if (typeof n === "number") return n;
	if (!Array.isArray(n) || n.length < 2) return dflt;
	const e = Date.parse(v.epoch || "1970-01-01T00:00:00Z"), T = i => typeof n[i] === "string" ? Date.parse(n[i]) : e + n[i] * 1000;
	if (ms <= T(0)) return n[1];
	for (let i = 2; i + 1 < n.length; i += 2) if (ms <= T(i)) { const t0 = T(i - 2), t1 = T(i); return n[i - 1] + (n[i + 1] - n[i - 1]) * (ms - t0) / (t1 - t0); }
	return n[n.length - 1];
}

// 地物 → 軌跡 { t: Float64Array（ms・昇順）, p: Float64Array（ECEF×3）, degree, avail, id, name, czml }｜null（時刻付きの線でない）
export function trackOf(f) {
	const g = f?.geometry, pr = f?.properties || {};
	if (!g || (g.type !== "LineString" && g.type !== "MultiLineString") || !Array.isArray(pr.time)) return null;
	const parts = g.type === "LineString" ? [g.coordinates] : g.coordinates;
	const nested = Array.isArray(pr.time[0]);
	const at = (arr, s, j) => arr == null ? null : nested || (g.type === "MultiLineString" && Array.isArray(arr[0])) ? arr[s]?.[j] : arr[j];
	const rows = [];
	parts.forEach((seg, s) => seg.forEach(([lon, lat], j) => {
		const ms = isoMs(at(pr.time, s, j)); if (!Number.isFinite(ms)) return;
		const h = +(typeof pr.ele === "number" ? pr.ele : at(pr.ele, s, j)) || 0;
		rows.push([ms, lon, lat, h]);
	}));
	if (!rows.length) return null;
	rows.sort((a, b) => a[0] - b[0]);   // 並べ替えは安定＝同じ時刻は元の順のまま
	const t = [], p = [];
	for (const [ms, lon, lat, h] of rows) {
		const q = llhToEcef(lon, lat, h);
		if (t.length && t[t.length - 1] === ms) { p.splice(p.length - 3, 3, ...q); continue; }   // 同じ時刻の標本＝後の方が勝つ（Cesium の mergeNewSamples と同じ・軌道の継ぎ目で位置が違う組がある）
		t.push(ms); p.push(...q);
	}
	const czml = pr.czml && typeof pr.czml === "object" ? pr.czml : {};
	const alg = String(czml.position?.interpolationAlgorithm || "LINEAR").toUpperCase();
	const degree = alg === "LINEAR" ? 1 : Math.max(1, Math.round(+czml.position?.interpolationDegree || 1));
	const inertial = czml.position?.[FRAME_KEY] === "INERTIAL";
	if (inertial) for (let i = 0; i < t.length; i++) { const v = toInertial(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], t[i]); p[i * 3] = v[0]; p[i * 3 + 1] = v[1]; p[i * 3 + 2] = v[2]; }
	return { t: Float64Array.from(t), p: Float64Array.from(p), degree, inertial, avail: parseIntervals(pr.availability), id: pr.id ?? pr.name ?? null, name: pr.name ?? pr.id ?? null, czml };
}

// 慣性系 ⇄ 地球固定（geopbf の inertialToFixed＝歳差＋章動＋視恒星時）。逆は転置（直交行列）＝基底の像から組む
const rotOf = ms => [inertialToFixed(1, 0, 0, ms), inertialToFixed(0, 1, 0, ms), inertialToFixed(0, 0, 1, ms)];   // 列＝e_i の像
const toInertial = (x, y, z, ms) => { const c = rotOf(ms); return [c[0][0] * x + c[0][1] * y + c[0][2] * z, c[1][0] * x + c[1][1] * y + c[1][2] * z, c[2][0] * x + c[2][1] * y + c[2][2] * z]; };
const toFixed = (v, ms) => { const c = rotOf(ms); return [0, 1, 2].map(k => c[0][k] * v[0] + c[1][k] * v[1] + c[2][k] * v[2]); };

// 時刻 ms の位置（ECEF）｜null（標本の範囲の外）
export function positionAt(tr, ms) {
	const q = interp(tr, ms);
	return q && tr.inertial ? toFixed(q, ms) : q;
}
function interp(tr, ms) {
	const { t, p } = tr, n = t.length;
	if (!n || !(ms >= t[0] && ms <= t[n - 1])) return null;
	let lo = 0, hi = n;   // 挿入点＝t[i] > ms の最初の i
	while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] <= ms) lo = m + 1; else hi = m; }
	if (lo > 0 && t[lo - 1] === ms) { const k = (lo - 1) * 3; return [p[k], p[k + 1], p[k + 2]]; }   // 標本ちょうど
	const deg = Math.min(tr.degree, n - 1);
	if (deg < 1) return null;
	let first = Math.max(0, lo - ((deg / 2) | 0) - 1), last = first + deg;
	if (last > n - 1) { last = n - 1; first = Math.max(0, last - deg); }
	const x = (ms - t[last]) / 1000, out = [0, 0, 0];
	for (let i = first; i <= last; i++) {   // Lagrange（線形は 2 点の場合）＝x は t[last] 基準の秒（Cesium と同じ表）
		let w = 1; const xi = (t[i] - t[last]) / 1000;
		for (let j = first; j <= last; j++) if (j !== i) w *= (x - (t[j] - t[last]) / 1000) / (xi - (t[j] - t[last]) / 1000);
		out[0] += w * p[i * 3]; out[1] += w * p[i * 3 + 1]; out[2] += w * p[i * 3 + 2];
	}
	return out;
}
export const availableAt = (tr, ms) => inIntervals(tr.avail, ms);
// 見えるか＝出ている区間の中で、位置がある
export const visibleAt = (tr, ms) => availableAt(tr, ms) && positionAt(tr, ms) != null;

// path の時刻の列：[ms − trail, ms + lead]（標本の範囲と出ている区間の中）を resolution 秒ごと＋その中の標本の時刻。lead/trail が無ければ出ている全区間（Cesium と同じ）
export function pathTimes(tr, ms, { lead = null, trail = null, resolution = 60 } = {}) {
	const n = tr.t.length; if (!n) return [];
	let a = trail == null ? tr.t[0] : Math.max(tr.t[0], ms - trail * 1000), b = lead == null ? tr.t[n - 1] : Math.min(tr.t[n - 1], ms + lead * 1000);
	const iv = tr.avail?.find(([s, e]) => ms >= s && ms <= e); if (iv) { a = Math.max(a, iv[0]); b = Math.min(b, iv[1]); }
	if (!(b > a)) return [];
	const step = Math.max(1, +resolution || 60) * 1000, out = [];
	for (let x = a; x < b; x += step) out.push(x);
	for (let i = 0; i < n; i++) if (tr.t[i] > a && tr.t[i] < b) out.push(tr.t[i]);
	out.push(b);
	return [...new Set(out)].sort((u, v) => u - v);
}

// ── 見た目（#113 段 3）＝CZML の point / billboard / label / path を描く側の形に揃える（時刻で変わる値は描く時に引く）──
// 時刻付きの真偽（show）：真偽・{ boolean }・区間ごと [{ interval, boolean }]（区間の外は dflt）
export function boolAt(v, ms, dflt = true) {
	if (v == null) return dflt;
	if (typeof v === "boolean") return v;
	if (Array.isArray(v)) { for (const q of v) { const iv = parseIntervals(q?.interval); if (!iv || inIntervals(iv, ms)) return boolAt(q, ms, dflt); } return false; }   // 区間の並び＝どれにも入らない時刻は出さない（Cesium の TimeIntervalCollectionProperty）
	return typeof v.boolean === "boolean" ? v.boolean : dflt;
}
// 色：{ rgba: [0..255] }・{ rgbaf: [0..1] }・{ color: … }（material の solidColor 等）→ CSS。時刻付きの列は最初の標本
export function colorOf(c, dflt = null) {
	if (c == null) return dflt;
	if (Array.isArray(c)) return colorOf(c[0], dflt);
	if (typeof c !== "object") return dflt;
	if (c.color) return colorOf(c.color, dflt);
	if (c.solidColor) return colorOf(c.solidColor, dflt);
	if (c.polylineOutline) return colorOf(c.polylineOutline, dflt);
	const q = Array.isArray(c.rgba) ? (c.rgba.length > 4 ? c.rgba.slice(1, 5) : c.rgba).map((v, i) => i < 3 ? v : v / 255) : Array.isArray(c.rgbaf) ? (c.rgbaf.length > 4 ? c.rgbaf.slice(1, 5) : c.rgbaf).map((v, i) => i < 3 ? v * 255 : v) : null;
	return q ? `rgba(${Math.round(q[0])},${Math.round(q[1])},${Math.round(q[2])},${+(q[3] ?? 1).toFixed(3)})` : dflt;
}
const offsetOf = v => Array.isArray(v?.cartesian2) ? [+v.cartesian2[0] || 0, +v.cartesian2[1] || 0] : [0, 0];
const fontPx = f => { const m = /(\d+(?:\.\d+)?)\s*(pt|px)/.exec(String(f || "")); return m ? (m[2] === "pt" ? +m[1] * 4 / 3 : +m[1]) : 14; };
const textOf = v => typeof v === "string" ? v : typeof v?.string === "string" ? v.string : Array.isArray(v) ? textOf(v[0]) : null;
const imageOf = v => typeof v === "string" ? v : typeof v?.uri === "string" ? v.uri : Array.isArray(v) ? imageOf(v[0]) : null;
// 地物 → { point, image, label, path }（null＝描かない）。見た目の指定が無い（GPX など）＝点＋今までの軌跡・名前の札（本人裁定＝GPX も同じ再生）
export function styleOf(f) {
	const pr = f?.properties || {}, cz = pr.czml && typeof pr.czml === "object" ? pr.czml : null;
	if (!cz || !(cz.point || cz.billboard || cz.label || cz.path)) {
		return { point: { size: 8, color: "rgba(255,127,14,1)", outline: "rgba(255,255,255,0.9)", outlineWidth: 1.5, show: true }, image: null,
			label: pr.name ? { text: String(pr.name), color: "rgba(255,255,255,1)", px: 13, offset: [10, 0], align: "left", show: true } : null,
			path: { show: true, width: 2, color: "rgba(255,127,14,0.8)", lead: 0, trail: null, resolution: 60 } };
	}
	const pt = cz.point, bb = cz.billboard, lb = cz.label, ph = cz.path;
	return {
		point: pt ? { size: +pt.pixelSize || 1, color: colorOf(pt.color, "rgba(255,255,255,1)"), outline: colorOf(pt.outlineColor, null), outlineWidth: +pt.outlineWidth || 0, show: pt.show ?? true } : null,
		image: bb && imageOf(bb.image) ? { src: imageOf(bb.image), scale: +bb.scale || 1, offset: offsetOf(bb.pixelOffset), show: bb.show ?? true } : null,
		label: lb && textOf(lb.text) != null ? { text: textOf(lb.text), color: colorOf(lb.fillColor, "rgba(255,255,255,1)"), outline: colorOf(lb.outlineColor, "rgba(0,0,0,1)"), px: fontPx(lb.font) * (+lb.scale || 1),
			offset: offsetOf(lb.pixelOffset), align: String(lb.horizontalOrigin || "CENTER").toLowerCase(), show: lb.show ?? true } : null,
		path: ph ? { show: ph.show ?? true, width: +ph.width || 1, color: colorOf(ph.material, "rgba(255,255,255,1)"), lead: ph.leadTime ?? null, trail: ph.trailTime ?? null, resolution: ph.resolution ?? 60 } : null,
	};
}
