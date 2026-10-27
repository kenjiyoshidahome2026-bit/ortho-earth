// CZML・GPX の時刻付きの位置を共通の時計で引く純関数（#113 段 2・2026-09-29）。main でも worker でも使える（依存なし）。
// 入り口は geopbf の地物＝時刻付きの線（LineString／MultiLineString）＋属性 time（ISO・点と同じ長さ・切った部品ごとの入れ子）＋ele（高さ m）。
// ±180° の切断で足された縫い目の点は時刻が null（geopbf 1.17.0〜・元の標本でない）＝時刻の無い点として除く。
// 補間は地球固定の直交座標（ECEF・WGS84）で行う＝Cesium と同じ（線形でも弦で結ぶ＝標本の間で高さが沈む・LAGRANGE は次数＋1 点）。
// 窓の決め方も Cesium（SampledProperty）と同じ：t より後の最初の標本 i → [i − ⌊次数/2⌋ − 1, その＋次数]（端は内側へずらす）・標本ちょうどはその標本・
// 標本の範囲の外は無し（外挿しない＝Cesium の既定 ExtrapolationType.NONE）。HERMITE は速度を読まない＝LAGRANGE として扱う（本人裁定）。
// 慣性系（INERTIAL）から地球固定へ直された標本（geopbf が czml.position に "ortho:frame" の印）は、慣性系へ戻して補間し、引いた時刻で地球固定へ回す
// ＝Cesium と同じ手順（固定系のまま補間すると継ぎ目と端で 20〜90 m ずれた）。時刻は ms の小数まで（geopbf の isoMs）。
import { inertialToFixed, isoMs, FRAME_KEY } from "geopbf/czml";

type Loose = Record<string, unknown>;
type Vec3 = [number, number, number];
/** 区間（ms） */
export type Interval = [number, number];
/** 入り口の地物（geopbf の地物＝時刻付きの線＋属性 time・ele・czml・availability・id・name） */
export interface CzmlFeature { geometry?: { type: string; coordinates?: unknown } | null; properties?: Loose | null }
/** CZML／GPX の時刻つきの軌跡（trackOf の戻り） */
export interface CzmlTrack {
	id?: string | null; name?: string | null;
	/** 標本の時刻（ms・昇順）・位置（ECEF×3・m） */
	t: Float64Array; p: Float64Array;
	/** 補間の次数（線形＝1）・慣性系で補間するか */
	degree: number; inertial: boolean;
	/** 出ている区間（ms・null＝いつも） */
	avail: Interval[] | null;
	czml: Loose;
	[k: string]: unknown;
}
/** 見た目（styleOf の戻り）。show・lead・trail・resolution は CZML の生の値（時刻つきもある＝boolAt／numberAt で引く） */
export interface CzmlStyle {
	point: { size: number; color: string; outline: string | null; outlineWidth: number; show: unknown } | null;
	image: { src: string; scale: number; offset: [number, number]; show: unknown } | null;
	label: { text: string | null; color: string; outline?: string; px: number; offset: [number, number]; align: string; show: unknown } | null;
	path: { show: unknown; width: number; color: string; lead: unknown; trail: unknown; resolution: unknown; relativeTo?: string | null; frame?: "fixed" | "inertial" | null } | null;
}
/** CZML の色（rgba 0..255・rgbaf 0..1・入れ子の material） */
interface CzColor { color?: unknown; solidColor?: unknown; polylineOutline?: unknown; polylineGlow?: unknown; polylineArrow?: unknown; polylineDash?: unknown; rgba?: number[]; rgbaf?: number[] }
/** CZML の packet の見た目の分（読む所だけ） */
interface CzPacket {
	point?: { pixelSize?: number; color?: unknown; outlineColor?: unknown; outlineWidth?: number; show?: unknown };
	billboard?: { image?: unknown; scale?: number; pixelOffset?: unknown; show?: unknown };
	label?: { text?: unknown; fillColor?: unknown; outlineColor?: unknown; font?: unknown; scale?: number; pixelOffset?: unknown; horizontalOrigin?: string; show?: unknown };
	path?: { show?: unknown; width?: number; material?: unknown; leadTime?: unknown; trailTime?: unknown; resolution?: unknown; relativeTo?: unknown };
	model?: unknown;
}
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F), D2R = Math.PI / 180;

export function llhToEcef(lon: number, lat: number, h = 0): Vec3 {
	const s = Math.sin(lat * D2R), c = Math.cos(lat * D2R), N = A / Math.sqrt(1 - E2 * s * s);
	return [(N + h) * c * Math.cos(lon * D2R), (N + h) * c * Math.sin(lon * D2R), (N * (1 - E2) + h) * s];
}
export function ecefToLlh(x: number, y: number, z: number): Vec3 {
	const lon = Math.atan2(y, x), p = Math.hypot(x, y);
	let lat = Math.atan2(z, p * (1 - E2)), N = A, h = 0;
	for (let i = 0; i < 5; i++) { const s = Math.sin(lat); N = A / Math.sqrt(1 - E2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - E2 * N / (N + h))); }
	return [lon / D2R, lat / D2R, h];
}

// 区間（"a/b" の ISO・その配列）→ [[a, b]…]（ms）｜null（無指定＝いつも）
export function parseIntervals(v: unknown): Interval[] | null {
	if (v == null) return null;
	const list = ((Array.isArray(v) ? v : [v]).map(s => typeof s === "string" ? s.split("/") : null).filter(q => q && q.length === 2) as string[][]).map(([a, b]): Interval => [Date.parse(a), Date.parse(b)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
	return list.length ? list : null;
}
const inIntervals = (ivs: Interval[] | null | undefined, ms: number): boolean => !ivs || ivs.some(([a, b]) => ms >= a && ms <= b);
/** 区間の列に ms が入るか（null＝いつも） */
export const inIntervalsOf = inIntervals;

// 時刻付きの値（CZML の number プロパティ）：数・{ number }・区間ごと [{ interval, number（数か [t, v, …]）, epoch }]。標本の数列は線形（区間の外は dflt）
export function numberAt<D = null>(v: unknown, ms: number, dflt: D = null as D): number | D {
	if (v == null) return dflt;
	if (typeof v === "number") return v;
	if (Array.isArray(v)) { for (const q of v) { const iv = parseIntervals(q?.interval); if (!iv || inIntervals(iv, ms)) { const r = numberAt(q, ms, undefined); if (r !== undefined) return r; } } return dflt; }
	if (typeof v !== "object") return dflt;
	const n = (v as Loose).number as number[] | number | undefined;
	if (typeof n === "number") return n;
	if (!Array.isArray(n) || n.length < 2) return dflt;
	const e = Date.parse(((v as Loose).epoch as string) || "1970-01-01T00:00:00Z"), T = (i: number): number => typeof n[i] === "string" ? Date.parse(n[i] as unknown as string) : e + n[i] * 1000;
	if (ms <= T(0)) return n[1];
	for (let i = 2; i + 1 < n.length; i += 2) if (ms <= T(i)) { const t0 = T(i - 2), t1 = T(i); return n[i - 1] + (n[i + 1] - n[i - 1]) * (ms - t0) / (t1 - t0); }
	return n[n.length - 1];
}

// 地物 → 軌跡 { t: Float64Array（ms・昇順）, p: Float64Array（ECEF×3）, degree, avail, id, name, czml }｜null（時刻付きの線でない）
export function trackOf(f: CzmlFeature | null | undefined): CzmlTrack | null {
	const g = f?.geometry, pr: Loose = f?.properties || {};
	if (!g || (g.type !== "LineString" && g.type !== "MultiLineString") || !Array.isArray(pr.time)) return null;
	const parts = (g.type === "LineString" ? [g.coordinates] : g.coordinates) as number[][][];
	const nested = Array.isArray(pr.time[0]);
	const at = (arr: unknown, s: number, j: number): unknown => arr == null ? null : nested || (g.type === "MultiLineString" && Array.isArray((arr as unknown[])[0])) ? (arr as unknown[][])[s]?.[j] : (arr as unknown[])[j];
	const rows: number[][] = [];
	parts.forEach((seg, s) => seg.forEach(([lon, lat], j) => {
		const ms = isoMs(at(pr.time, s, j)); if (!Number.isFinite(ms)) return;
		const h = +(typeof pr.ele === "number" ? pr.ele : at(pr.ele, s, j) as number) || 0;
		rows.push([ms, lon, lat, h]);
	}));
	if (!rows.length) return null;
	rows.sort((a, b) => a[0] - b[0]);   // 並べ替えは安定＝同じ時刻は元の順のまま
	const t: number[] = [], p: number[] = [];
	for (const [ms, lon, lat, h] of rows) {
		const q = llhToEcef(lon, lat, h);
		if (t.length && t[t.length - 1] === ms) { p.splice(p.length - 3, 3, ...q); continue; }   // 同じ時刻の標本＝後の方が勝つ（Cesium の mergeNewSamples と同じ・軌道の継ぎ目で位置が違う組がある）
		t.push(ms); p.push(...q);
	}
	const czml = (pr.czml && typeof pr.czml === "object" ? pr.czml : {}) as Loose & { position?: Loose };
	const alg = String(czml.position?.interpolationAlgorithm || "LINEAR").toUpperCase();
	const degree = alg === "LINEAR" ? 1 : Math.max(1, Math.round(+(czml.position?.interpolationDegree as number) || 1));
	const inertial = czml.position?.[FRAME_KEY] === "INERTIAL";
	if (inertial) for (let i = 0; i < t.length; i++) { const v = toInertial(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], t[i]); p[i * 3] = v[0]; p[i * 3 + 1] = v[1]; p[i * 3 + 2] = v[2]; }
	return { t: Float64Array.from(t), p: Float64Array.from(p), degree, inertial, avail: parseIntervals(pr.availability), id: (pr.id ?? pr.name ?? null) as string | null, name: (pr.name ?? pr.id ?? null) as string | null, czml };
}

// 慣性系 ⇄ 地球固定（geopbf の inertialToFixed＝歳差＋章動＋視恒星時）。逆は転置（直交行列）＝基底の像から組む
const rotOf = (ms: number): Vec3[] => [inertialToFixed(1, 0, 0, ms), inertialToFixed(0, 1, 0, ms), inertialToFixed(0, 0, 1, ms)];   // 列＝e_i の像
const toInertial = (x: number, y: number, z: number, ms: number): Vec3 => { const c = rotOf(ms); return [c[0][0] * x + c[0][1] * y + c[0][2] * z, c[1][0] * x + c[1][1] * y + c[1][2] * z, c[2][0] * x + c[2][1] * y + c[2][2] * z]; };
const toFixed = (v: Vec3, ms: number): Vec3 => { const c = rotOf(ms); return [0, 1, 2].map(k => c[0][k] * v[0] + c[1][k] * v[1] + c[2][k] * v[2]) as Vec3; };

// 時刻 ms の位置（ECEF）｜null（標本の範囲の外）
export function positionAt(tr: CzmlTrack, ms: number): Vec3 | null {
	const q = interp(tr, ms);
	return q && tr.inertial ? toFixed(q, ms) : q;
}
function interp(tr: CzmlTrack, ms: number): Vec3 | null {
	const { t, p } = tr, n = t.length;
	if (!n || !(ms >= t[0] && ms <= t[n - 1])) return null;
	let lo = 0, hi = n;   // 挿入点＝t[i] > ms の最初の i
	while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] <= ms) lo = m + 1; else hi = m; }
	if (lo > 0 && t[lo - 1] === ms) { const k = (lo - 1) * 3; return [p[k], p[k + 1], p[k + 2]]; }   // 標本ちょうど
	const deg = Math.min(tr.degree, n - 1);
	if (deg < 1) return null;
	let first = Math.max(0, lo - ((deg / 2) | 0) - 1), last = first + deg;
	if (last > n - 1) { last = n - 1; first = Math.max(0, last - deg); }
	const x = (ms - t[last]) / 1000, out: Vec3 = [0, 0, 0];
	for (let i = first; i <= last; i++) {   // Lagrange（線形は 2 点の場合）＝x は t[last] 基準の秒（Cesium と同じ表）
		let w = 1; const xi = (t[i] - t[last]) / 1000;
		for (let j = first; j <= last; j++) if (j !== i) w *= (x - (t[j] - t[last]) / 1000) / (xi - (t[j] - t[last]) / 1000);
		out[0] += w * p[i * 3]; out[1] += w * p[i * 3 + 1]; out[2] += w * p[i * 3 + 2];
	}
	return out;
}
// 慣性系での位置（固定系の軌跡は時刻 t の回転で慣性系へ）
const inertialAt = (tr: CzmlTrack, ms: number): Vec3 | null => { const q = interp(tr, ms); return q && !tr.inertial ? toInertial(q[0], q[1], q[2], ms) : q; };
// VVLH（Cesium の PathVisualizer computeVvlhTransform）＝慣性系の位置 r と 10 ms 後の向きから z＝r̂・y＝軌道面の法線・x＝進行方向の正規直交基底（列）｜null（止まっている）
function vvlhAt(tr: CzmlTrack, ms: number): [Vec3, Vec3, Vec3] | null {
	const r = inertialAt(tr, ms), r2 = inertialAt(tr, ms + 10);
	if (!r || !r2) return null;
	const nz = Math.hypot(r[0], r[1], r[2]), n2 = Math.hypot(r2[0], r2[1], r2[2]);
	if (!(nz > 0 && n2 > 0)) return null;
	const z: Vec3 = [r[0] / nz, r[1] / nz, r[2] / nz], d: Vec3 = [r2[0] / n2, r2[1] / n2, r2[2] / n2];
	const y: Vec3 = [z[1] * d[2] - z[2] * d[1], z[2] * d[0] - z[0] * d[2], z[0] * d[1] - z[1] * d[0]], ny = Math.hypot(y[0], y[1], y[2]);
	if (!(ny > 1e-16)) return null;
	y[0] /= ny; y[1] /= ny; y[2] /= ny;
	const x: Vec3 = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]];
	return [x, y, z];
}
/** 時刻 t の path の点（ECEF・描く時刻 ms の枠で）｜null。Cesium の PathVisualizer と同じ枠：固定系の位置はそのまま・慣性系の位置は慣性系の軌跡を時刻 ms の回転で（軌道の楕円が出る）・
 *  frame で枠を指定できる（relativeTo "FIXED"/"INERTIAL"）・rel（path.relativeTo の軌跡）があれば rel から見た相対位置を rel の VVLH 枠（時刻 t）で取り、時刻 ms の VVLH 枠と位置へ移す */
export function pathPositionAt(tr: CzmlTrack, t: number, ms: number, rel: CzmlTrack | null = null, frame: "fixed" | "inertial" | null = null): Vec3 | null {
	if (rel) {
		const p = inertialAt(tr, t), r = inertialAt(rel, t), r0 = inertialAt(rel, ms), B = vvlhAt(rel, t), B0 = vvlhAt(rel, ms);
		if (!p || !r || !r0 || !B || !B0) return null;
		const d: Vec3 = [p[0] - r[0], p[1] - r[1], p[2] - r[2]];
		const c = B.map(b => b[0] * d[0] + b[1] * d[1] + b[2] * d[2]);   // rel の枠の座標（基底は正規直交＝転置が逆）
		const v: Vec3 = [r0[0], r0[1], r0[2]];
		for (let k = 0; k < 3; k++) { v[0] += B0[k][0] * c[k]; v[1] += B0[k][1] * c[k]; v[2] += B0[k][2] * c[k]; }
		return toFixed(v, ms);
	}
	const inertial = frame ? frame === "inertial" : tr.inertial;   // frame＝枠の指定（path.relativeTo "FIXED"/"INERTIAL"）・無ければ軌跡の枠
	if (!inertial) return positionAt(tr, t);
	const q = inertialAt(tr, t);
	return q && toFixed(q, ms);
}
export const availableAt = (tr: CzmlTrack, ms: number): boolean => inIntervals(tr.avail, ms);
// 見えるか＝出ている区間の中で、位置がある
export const visibleAt = (tr: CzmlTrack, ms: number): boolean => availableAt(tr, ms) && positionAt(tr, ms) != null;

// path の時刻の列：[ms − trail, ms + lead]（標本の範囲と出ている区間の中）を resolution 秒ごと＋その中の標本の時刻。lead/trail が無ければ出ている全区間（Cesium と同じ）
export function pathTimes(tr: CzmlTrack, ms: number, { lead = null, trail = null, resolution = 60 }: { lead?: number | null; trail?: number | null; resolution?: number | null } = {}): number[] {
	const n = tr.t.length; if (!n) return [];
	let a = trail == null ? tr.t[0] : Math.max(tr.t[0], ms - trail * 1000), b = lead == null ? tr.t[n - 1] : Math.min(tr.t[n - 1], ms + lead * 1000);
	const iv = tr.avail?.find(([s, e]) => ms >= s && ms <= e); if (iv) { a = Math.max(a, iv[0]); b = Math.min(b, iv[1]); }
	if (!(b > a)) return [];
	const step = Math.max(1, +resolution! || 60) * 1000, out: number[] = [];
	for (let x = a; x < b; x += step) out.push(x);
	for (let i = 0; i < n; i++) if (tr.t[i] > a && tr.t[i] < b) out.push(tr.t[i]);
	if (ms > a && ms < b) out.push(ms);   // 今の時刻を必ず踏む（尾が印を通る・Cesium の subSample も同じ）
	out.push(b);
	return [...new Set(out)].sort((u, v) => u - v);
}

// ── 見た目（#113 段 3）＝CZML の point / billboard / label / path を描く側の形に揃える（時刻で変わる値は描く時に引く）──
// 時刻付きの真偽（show）：真偽・{ boolean }・区間ごと [{ interval, boolean }]（区間の外は dflt）
export function boolAt(v: unknown, ms: number, dflt = true): boolean {
	if (v == null) return dflt;
	if (typeof v === "boolean") return v;
	if (Array.isArray(v)) { for (const q of v) { const iv = parseIntervals(q?.interval); if (!iv || inIntervals(iv, ms)) return boolAt(q, ms, dflt); } return false; }   // 区間の並び＝どれにも入らない時刻は出さない（Cesium の TimeIntervalCollectionProperty）
	return typeof (v as Loose).boolean === "boolean" ? (v as { boolean: boolean }).boolean : dflt;
}
// 色：{ rgba: [0..255] }・{ rgbaf: [0..1] }・{ color: … }（material の solidColor 等）→ CSS。時刻付きの列は最初の標本
export function colorOf<D = null>(c: unknown, dflt: D = null as D): string | D {
	if (c == null) return dflt;
	if (Array.isArray(c)) return colorOf(c[0], dflt);
	if (typeof c !== "object") return dflt;
	if ((c as CzColor).color) return colorOf((c as CzColor).color, dflt);
	if ((c as CzColor).solidColor) return colorOf((c as CzColor).solidColor, dflt);
	if ((c as CzColor).polylineOutline) return colorOf((c as CzColor).polylineOutline, dflt);
	for (const k of ["polylineGlow", "polylineArrow", "polylineDash"] as const) if ((c as CzColor)[k]) return colorOf((c as CzColor)[k], dflt);   // 模様は色だけ写す（光彩・矢・破線の形は描かない）
	const q = Array.isArray((c as CzColor).rgba) ? ((c as CzColor).rgba!.length > 4 ? (c as CzColor).rgba!.slice(1, 5) : (c as CzColor).rgba!).map((v, i) => i < 3 ? v : v / 255) : Array.isArray((c as CzColor).rgbaf) ? ((c as CzColor).rgbaf!.length > 4 ? (c as CzColor).rgbaf!.slice(1, 5) : (c as CzColor).rgbaf!).map((v, i) => i < 3 ? v * 255 : v) : null;
	return q ? `rgba(${Math.round(q[0])},${Math.round(q[1])},${Math.round(q[2])},${+(q[3] ?? 1).toFixed(3)})` : dflt;
}
const offsetOf = (v: unknown): [number, number] => Array.isArray((v as { cartesian2?: unknown })?.cartesian2) ? [+(v as { cartesian2: number[] }).cartesian2[0] || 0, +(v as { cartesian2: number[] }).cartesian2[1] || 0] : [0, 0];
// 文字の大きさ（CSS の font の最初の「数 pt|px」）。正規表現 /(\d+(?:\.\d+)?)\s*(pt|px)/ と同じ答えを一度の走査で（数字の長い列で二乗にならない）
const isDigit = (s: string, i: number): boolean => { const c = s.charCodeAt(i); return c >= 48 && c <= 57; };
const fontPx = (f: unknown): number => {
	const s = String(f || "");
	for (let i = 0; i < s.length; i++) {
		if (!isDigit(s, i) || (i > 0 && isDigit(s, i - 1))) continue;   // 数字の列の頭だけ（途中から始まる一致は頭からも一致する）
		let k = i; while (k < s.length && isDigit(s, k)) k++;
		if (s[k] === "." && isDigit(s, k + 1)) { k += 2; while (k < s.length && isDigit(s, k)) k++; }
		let w = k; while (w < s.length && /\s/.test(s[w])) w++;
		const u = s.slice(w, w + 2);
		if (u === "pt" || u === "px") return u === "pt" ? +s.slice(i, k) * 4 / 3 : +s.slice(i, k);
	}
	return 14;
};
const textOf = (v: unknown): string | null => typeof v === "string" ? v : typeof (v as { string?: unknown })?.string === "string" ? (v as { string: string }).string : Array.isArray(v) ? textOf(v[0]) : null;
const imageOf = (v: unknown): string | null => typeof v === "string" ? v : typeof (v as { uri?: unknown })?.uri === "string" ? (v as { uri: string }).uri : Array.isArray(v) ? imageOf(v[0]) : null;
// 地物 → { point, image, label, path }（null＝描かない）。見た目の指定が無い（GPX など）＝点＋今までの軌跡・名前の札（本人裁定＝GPX も同じ再生）
export function styleOf(f: CzmlFeature | null | undefined): CzmlStyle {
	const pr: Loose = f?.properties || {}, cz = (pr.czml && typeof pr.czml === "object" ? pr.czml : null) as CzPacket | null;
	if (cz?.model && !(cz.point || cz.billboard || cz.label || cz.path)) return { point: null, image: null, label: null, path: null };   // 模型だけ（P0 #5）＝模型を描く（gadgets/czml-scene.ts）・点も尾も足さない（Cesium と同じ）
	if (!cz || !(cz.point || cz.billboard || cz.label || cz.path)) {
		return { point: { size: 8, color: "rgba(255,127,14,1)", outline: "rgba(255,255,255,0.9)", outlineWidth: 1.5, show: true }, image: null,
			label: pr.name ? { text: String(pr.name), color: "rgba(255,255,255,1)", px: 13, offset: [10, 0], align: "left", show: true } : null,
			path: { show: true, width: 2, color: "rgba(255,127,14,0.8)", lead: 0, trail: null, resolution: 60 } };
	}
	const pt = cz.point, bb = cz.billboard, lb = cz.label, ph = cz.path;
	return {
		point: pt ? { size: +pt.pixelSize! || 1, color: colorOf(pt.color, "rgba(255,255,255,1)"), outline: colorOf(pt.outlineColor, null), outlineWidth: +pt.outlineWidth! || 0, show: pt.show ?? true } : null,
		image: bb && imageOf(bb.image) ? { src: imageOf(bb.image)!, scale: +bb.scale! || 1, offset: offsetOf(bb.pixelOffset), show: bb.show ?? true } : null,
		label: lb && textOf(lb.text) != null ? { text: textOf(lb.text), color: colorOf(lb.fillColor, "rgba(255,255,255,1)"), outline: colorOf(lb.outlineColor, "rgba(0,0,0,1)"), px: fontPx(lb.font) * (+lb.scale! || 1),
			offset: offsetOf(lb.pixelOffset), align: String(lb.horizontalOrigin || "CENTER").toLowerCase(), show: lb.show ?? true } : null,
		path: ph ? { show: ph.show ?? true, width: +ph.width! || 1, color: colorOf(ph.material, "rgba(255,255,255,1)"), lead: ph.leadTime ?? null, trail: ph.trailTime ?? null, resolution: ph.resolution ?? 60, relativeTo: typeof ph.relativeTo === "string" ? ph.relativeTo : null } : null,
	};
}
