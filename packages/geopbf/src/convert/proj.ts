// convert/proj.js ── CRS の WKT（OGC / Esri）を読んで「経緯度へ戻せるか」を判定し、戻せるなら逆変換関数を返す（依存ゼロ）。
// GeoPBF は経緯度だけを持つので、入口（FileGDB / GeoPackage）で PROJCS を経緯度に戻す。対応は
//   ・GEOGCS: WGS84 / JGD2011 / ITRF / ETRS89 / NAD83 / GDA 系＝そのまま経緯度（測地系差は m 未満〜1m 級）
//   ・PROJCS Transverse_Mercator（平面直角座標系 I〜XIX・UTM・Gauss-Krüger）＝Krüger 級数の逆変換（GSI の式・mm 級）
//   ・PROJCS Mercator_Auxiliary_Sphere / Popular Visualisation Pseudo Mercator（Web メルカトル）＝球の逆変換
//   ・PROJCS Lambert_Conformal_Conic（1SP/2SP＝米国 State Plane の多く）・Albers_Conic_Equal_Area（2026-09-30・#178＝LAS/COPC の座標系）
//   ・測地系（convert/datum.js）: 日本測地系（GCS_Tokyo / D_Tokyo）→ JGD2000（格子で 0.2 m 級・無ければ Helmert 10 m 級）、
//     JGD2000 → JGD2011（PatchJGD の格子を渡した時だけ・対象域外は無変換）。経緯度でも平面直角でも同じように後段で効く
//   crsFromWKT(wkt, { datum }) → { kind: "lonlat" | "projected" | "datum" | "other", label, name, approx?, toLonLat?: ([x, y]) => [lon, lat] }
//     toLonLat があれば変換が要る（projected＝投影の逆変換・datum＝測地系変換・両方のこともある）。datum＝resolveDatum() の戻り { tokyo, patch }

import { tokyoToJGD, jgd2000To2011 } from "./datum.ts";
import type { Datum } from "./datum.ts";
import { mercYToLat, latToMercY } from "../modules/mercator.ts";
import type { LonLat, XF, CrsInfo } from "./types.ts";

// 末尾の "_" を落とす（WKT の方法名の正規化）。旧 /_+$/ は "_" が多い入力で二乗の後戻り（CodeQL）＝添字で削る
const trimUnderscores = (s: string): string => { let e = s.length; while (e > 0 && s[e - 1] === "_") e--; return e === s.length ? s : s.slice(0, e); };
export type { CrsInfo, CrsKind, XF, LonLat } from "./types.ts";

const D = 180 / Math.PI, R = 6378137;
const TOKYO = /D_Tokyo|^Tokyo\b|GCS_Tokyo|Tokyo Datum|Tokyo_Datum/i;
const JGD2000 = /JGD_?2000|Japanese_Geodetic_Datum_2000/i;

/** WKT の木: NAME["str", child, 1.5, …] */
export interface WKTNode { name: string; args: WKTArg[] }
export type WKTArg = string | number | WKTNode;
/** (x, y) → [lon, lat]（投影の逆変換・メートル入力） */
export type InverseXY = (x: number, y: number) => LonLat;
/** (lon, lat) → [x, y] */
export type ForwardXY = (lon: number, lat: number) => [number, number];
export interface CrsOptions { datum?: Datum | null }

/** WKT を木にする: NAME["str", child, 1.5, …] → { name, args: [ string | number | node ] } */
export function parseWKTTree(wkt: unknown): WKTNode | null {
	let p = 0; const s = String(wkt || "").trim();
	const ws = (): void => { while (p < s.length && /\s/.test(s[p])) p++; };
	const node = (): WKTNode | null => {
		ws(); const m = s.slice(p).match(/^[A-Za-z_][A-Za-z0-9_]*/); if (!m) return null; p += m[0].length; ws();
		const n: WKTNode = { name: m[0].toUpperCase(), args: [] };
		if (s[p] !== "[" && s[p] !== "(") return n;
		const close = s[p] === "[" ? "]" : ")"; p++;
		for (;;) {
			ws(); if (s[p] === close) { p++; break; }
			if (s[p] === '"') { let q = p + 1, str = ""; while (q < s.length && s[q] !== '"') str += s[q++]; p = q + 1; n.args.push(str); }
			else if (/[-+.\d]/.test(s[p])) { const mm = s.slice(p).match(/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/) as RegExpMatchArray; p += mm[0].length; n.args.push(+mm[0]); }   // 合わなければ TypeError＝下の try が null にする（旧と同じ）
			else { const c = node(); if (!c) break; n.args.push(c); }
			ws(); if (s[p] === ",") p++;
		}
		return n;
	};
	try { return node(); } catch { return null; }
}
const isNode = (a: WKTArg | undefined): a is WKTNode => !!a && typeof a === "object";
const child = (n: WKTNode | null | undefined, name: string): WKTNode | undefined => n?.args.find((a): a is WKTNode => isNode(a) && a.name === name);
const children = (n: WKTNode | null | undefined, name: string): WKTNode[] => n?.args.filter((a): a is WKTNode => isNode(a) && a.name === name) ?? [];

// JGD2024（2025-04 施行）＝水平は JGD2011 と同じ（変わったのは標高の基準）＝経緯度として素通し。PROJ 9.6 以降の EPSG 辞書は 6668・6669–6687 の名前を JGD2024 にした（PDAL 2.10 の WKT に出る・2026-10-15 熱海の点群で踏んだ）
const LONLAT_DATUMS = /Not_specified_based_on_GRS_1980|WGS_?1984|WGS_?84|JGD_?2011|Japanese_Geodetic_Datum_2011|JGD_?2024|Japanese_Geodetic_Datum_2024|ITRF|ETRS_?(19)?89|European_Terrestrial|NAD_?(19)?83|North_American_1983|GDA_?(19)?94|GDA_?2020|Geocentric_Datum_of_Australia|CGCS2000|China_2000|Korea_2000|KGD2002|SIRGAS|Hartebeesthoek94|NZGD_?2000|PZ-?90|CH1903\+|Swiss/i;

/** WKT → 判定と逆変換。 */
export function crsFromWKT(wkt: unknown, opts: CrsOptions = {}): CrsInfo {
	const t = parseWKTTree(wkt);
	if (!t) return { kind: "other", label: String(wkt || "").slice(0, 40) || "unknown", name: null };
	const root = t.name === "PROJCS" || t.name === "GEOGCS" || t.name === "GEOGCRS" || t.name === "PROJCRS" ? t : (child(t, "PROJCS") || child(t, "GEOGCS") || t);
	const name = typeof root.args[0] === "string" ? root.args[0] : null;
	const auth = child(root, "AUTHORITY"); const label = auth && auth.args.length >= 2 ? `${auth.args[0]}:${auth.args[1]}` : (name || root.name);
	const geog = root.name === "GEOGCS" || root.name === "GEOGCRS" ? root : (child(root, "GEOGCS") || child(root, "BASEGEOGCRS") || child(root, "GEOGCRS"));
	// GEOGCS の角度単位（degree 以外＝grad など）と本初子午線（PRIMEM・角度単位で）＝旧は無視（改良点 15）
	const aunit = child(geog, "UNIT") || child(geog, "ANGLEUNIT"); let toDeg = aunit && typeof aunit.args[1] === "number" && aunit.args[1] > 0 ? aunit.args[1] * D : 1; if (Math.abs(toDeg - 1) < 1e-9) toDeg = 1;   // degree の書き方の末位差は 1
	const pm = child(geog, "PRIMEM"); const prime = pm && typeof pm.args[1] === "number" ? pm.args[1] * toDeg : 0;
	const datum = child(geog, "DATUM"); const datumName = (datum && typeof datum.args[0] === "string" ? datum.args[0] : "") + " " + (geog && typeof geog.args[0] === "string" ? geog.args[0] : "");
	// 測地系: Tokyo → JGD2000（→ JGD2011）／JGD2000 → JGD2011（PatchJGD がある時だけ）／それ以外の既知は素通し
	const { tokyo: tokyoGrid = null, patch = null } = opts.datum || {};
	const isTokyo = TOKYO.test(datumName), isJGD2000 = !isTokyo && JGD2000.test(datumName), geogOK = !isTokyo && !isJGD2000 && LONLAT_DATUMS.test(datumName);
	let shift: XF | null = null, shiftLabel = "", approx = false;
	if (isTokyo) {
		shift = patch ? (p => jgd2000To2011(tokyoToJGD(p, tokyoGrid), patch)) : (p => tokyoToJGD(p, tokyoGrid));
		shiftLabel = `Tokyo→${patch ? "JGD2011" : "JGD2000"} (${tokyoGrid ? "TKY2JGD ±0.2 m" : "Helmert ±10 m"}${patch ? " + PatchJGD" : ""})`;
		approx = !tokyoGrid;
	} else if (isJGD2000 && patch) {
		shift = (p => jgd2000To2011(p, patch));
		shiftLabel = "JGD2000→JGD2011 (PatchJGD)";
	}
	if (root.name === "GEOGCS" || root.name === "GEOGCRS") {
		const ang: XF | null = toDeg !== 1 || prime ? (([x, y]) => [x * toDeg + prime, y * toDeg]) : null;   // grad・Paris 基準などは度・Greenwich へ
		if (shift) { const sh = shift; return { kind: "datum", label: `${label} → ${shiftLabel}`, name, approx, toLonLat: ang ? p => sh(ang(p)) : sh }; }
		if (geogOK || isJGD2000) return ang ? { kind: "projected", label: `${label} (${aunit?.args[0] ?? "degree"}${prime ? `, PM ${prime}°` : ""})`, name, toLonLat: ang, fromLonLat: ([lon, lat]) => [(lon - prime) / toDeg, lat / toDeg] } : { kind: "lonlat", label, name };
		return { kind: "other", label: `${label} (datum ${datumName.trim() || "?"})`, name };
	}
	if (root.name !== "PROJCS" && root.name !== "PROJCRS") return { kind: "other", label, name };
	// 楕円体
	const sph = child(datum, "SPHEROID") || child(datum, "ELLIPSOID");
	const a = sph && typeof sph.args[1] === "number" ? sph.args[1] : 6378137, rf = sph && typeof sph.args[2] === "number" ? sph.args[2] : 298.257223563;
	const f = rf === 0 ? 0 : 1 / rf;
	// 投影とパラメータ
	const proj = child(root, "PROJECTION") || child(child(root, "CONVERSION"), "METHOD");
	const method = proj && typeof proj.args[0] === "string" ? proj.args[0] : "";
	const params: Record<string, WKTArg | undefined> = {}; for (const pn of children(root, "PARAMETER").concat(children(child(root, "CONVERSION"), "PARAMETER"))) if (typeof pn.args[0] === "string") params[pn.args[0].toLowerCase().replace(/[\s_]+/g, "_")] = pn.args[1];
	const P = (...names: string[]): number | undefined => { for (const n of names) { const k = n.toLowerCase().replace(/[\s_]+/g, "_"); if (params[k] !== undefined) return +(params[k] as string | number); } return undefined; };
	const unit = child(root, "UNIT") || child(root, "LENGTHUNIT"); const toM = unit && typeof unit.args[1] === "number" ? unit.args[1] : 1;
	if (!geogOK && !isTokyo && !isJGD2000) return { kind: "other", label: `${label} (datum ${datumName.trim() || "?"})`, name };
	// 投影の緯度経度のパラメタは GEOGCS の角度単位・本初子午線基準（WKT1）＝度・Greenwich へ直してから式へ。PA＝角度のパラメタ
	const PA = (...names: string[]): number | undefined => { const v = P(...names); return v === undefined ? undefined : v * toDeg; };
	// wrap(inv, fwd): inv＝[x, y] → [lon, lat]（本初子午線を足して Greenwich 基準に）、fwd＝[lon, lat] → [x, y]（測地系変換の順方向は無いので
	// shift がある時は fromLonLat を付けない）。fromLonLat は COG の warp（経緯度→源画素）が使う（2026-10-12・改良点 15）
	const wrap = (inv: XF, fwd: XF | undefined): CrsInfo => {
		const toLL: XF = prime ? (p => { const q = inv(p); q[0] += prime; return q; }) : inv;
		const fromLL: XF | undefined = fwd && (prime ? (([lon, lat]) => fwd([lon - prime, lat])) : fwd);
		if (shift) { const sh = shift; return { kind: "projected", label: `${label} → ${shiftLabel}`, name, approx, toLonLat: p => sh(toLL(p)) }; }
		return { kind: "projected", label, name, toLonLat: toLL, fromLonLat: fromLL };
	};
	if (/transverse_?mercator|gauss_?kruger/i.test(method) && !/south_orientated/i.test(method)) {
		// 原点移動も投影の単位（フィート等）で書かれている。旧測地系なら元の楕円体（Bessel 等）で逆変換してから測地系変換
		const o: TMParams = { a, f, k0: P("scale_factor", "Scale factor at natural origin") ?? 1, lat0: PA("latitude_of_origin", "Latitude of natural origin", "latitude_of_center") ?? 0, lon0: PA("central_meridian", "Longitude of natural origin", "longitude_of_center") ?? 0, fe: (P("false_easting") ?? 0) * toM, fn: (P("false_northing") ?? 0) * toM };
		const inv = tmInverse(o), fwd = tmForward(o);
		return wrap(([x, y]) => inv(x * toM, y * toM), (ll) => { const q = fwd(ll); return [q[0] / toM, q[1] / toM]; });
	}
	// メルカトル（2026-09-25・B9c）：球（Web メルカトル＝EPSG:3857・Esri 102100）と楕円体（Mercator 1SP/2SP＝EPSG:3395 等）を分ける。
	// 旧＝楕円体のメルカトルも球の式で逆変換（緯度 35° で約 −20 km）し、中央子午線 0 以外・縮尺係数・原点移動を扱わなかった
	const m = trimUnderscores(method.replace(/[\s()]+/g, "_"));
	// GDAL の WKT1 は EPSG:3857 を PROJECTION["Mercator_1SP"]＋WGS84 楕円体で書く（球であることは名前・AUTHORITY・PROJ4 の拡張にしか出ない）＝
	// 方法の名前だけで見ると楕円体の逆変換になり緯度 40° で約 0.19° ずれる（2026-09-30・#178 の COPC の試料で発見）
	const ext = child(root, "EXTENSION"), proj4 = ext && typeof ext.args[1] === "string" ? ext.args[1] : "";
	const pseudo = /mercator_auxiliary_sphere|pseudo_?mercator|popular_visualisation/i.test(m)
		|| /pseudo[\s_-]?mercator|web[\s_-]?mercator|popular visualisation/i.test(name || "")
		|| /^(EPSG|ESRI):(3857|3785|900913|102100|102113)$/.test(label)
		|| (/\+a=6378137\b/.test(proj4) && /\+b=6378137\b/.test(proj4));
	if (pseudo || /^mercator(_1sp|_2sp|_variant_[ab])?$/i.test(m)) {
		const lon0 = PA("central_meridian", "Longitude of natural origin", "longitude_of_origin") ?? 0;
		const fe = (P("false_easting") ?? 0) * toM, fn = (P("false_northing") ?? 0) * toM;
		if (pseudo) return wrap(([x, y]) => [(x * toM - fe) / R * D + lon0, mercYToLat(y * toM - fn)], ([lon, lat]) => [((lon - lon0) / D * R + fe) / toM, (latToMercY(lat) + fn) / toM]);
		const phi1 = PA("standard_parallel_1", "Latitude of 1st standard parallel");
		const mo: MercParams = { a, f, k0: P("scale_factor", "Scale factor at natural origin") ?? 1, phi1, lon0, fe, fn };
		const inv = mercInverse(mo), fwd = mercForward(mo);
		return wrap(([x, y]) => inv(x * toM, y * toM), ([lon, lat]) => { const q = fwd(lon, lat); return [q[0] / toM, q[1] / toM]; });
	}
	// ランベルト正角円錐（LCC 1SP/2SP＝米国の State Plane の多く）・アルベルス正積円錐（CONUS Albers 等）（2026-09-30・#178）
	const lonF = PA("central_meridian", "longitude_of_center", "Longitude of false origin", "Longitude of natural origin", "longitude_of_origin") ?? 0;
	const latO = PA("latitude_of_origin", "latitude_of_center", "Latitude of false origin", "Latitude of natural origin"), latF = latO ?? 0;
	const fe = (P("false_easting", "Easting at false origin", "False easting") ?? 0) * toM, fn = (P("false_northing", "Northing at false origin", "False northing") ?? 0) * toM;
	const sp1 = PA("standard_parallel_1", "Latitude of 1st standard parallel"), sp2 = PA("standard_parallel_2", "Latitude of 2nd standard parallel");
	// 標準緯線も原点緯度も無い円錐＝円錐の定数が 0（赤道で潰れる）＝読めない物として other（パラメタの抜けた WKT を黙って誤配置しない）
	if (/lambert_?conformal_?conic|albers/i.test(m) && sp1 == null && !latO) return { kind: "other", label: `${label} (${method}: no standard parallel)`, name };
	if (/lambert_?conformal_?conic/i.test(m)) {
		const k0 = P("scale_factor", "Scale factor at natural origin") ?? 1;
		const one = /1sp/i.test(m) || sp1 == null;
		const lo: LCCParams = { a, f, lat1: one ? latF : (sp1 as number), lat2: one ? null : (sp2 ?? sp1 ?? null), latF, lonF, k0: one ? k0 : 1, fe, fn };
		const inv = lccInverse(lo), fwd = lccForward(lo);
		return wrap(([x, y]) => inv(x * toM, y * toM), ([lon, lat]) => { const q = fwd(lon, lat); return [q[0] / toM, q[1] / toM]; });
	}
	if (/albers/i.test(m)) {
		const ao: AlbersParams = { a, f, lat1: sp1 ?? latF, lat2: sp2 ?? sp1 ?? latF, latF, lonF, fe, fn };
		const inv = albersInverse(ao), fwd = albersForward(ao);
		return wrap(([x, y]) => inv(x * toM, y * toM), ([lon, lat]) => { const q = fwd(lon, lat); return [q[0] / toM, q[1] / toM]; });
	}
	return { kind: "other", label: `${label} (${method || "projection ?"})`, name };
}

// ── 円錐図法（EPSG Guidance Note 7-2 の式）──
/** ランベルト正角円錐のパラメタ（度・m）。lat2 を省く（null）＝1SP */
export interface LCCParams { a: number; f: number; lat1: number; lat2?: number | null; latF: number; lonF: number; k0?: number; fe?: number; fn?: number }
/** アルベルス正積円錐のパラメタ（度・m） */
export interface AlbersParams { a: number; f: number; lat1: number; lat2: number; latF: number; lonF: number; fe?: number; fn?: number }
const eOf = (f: number): number => Math.sqrt(2 * f - f * f);
const mOf = (e: number, phi: number): number => Math.cos(phi) / Math.sqrt(1 - e * e * Math.sin(phi) ** 2);
const tOf = (e: number, phi: number): number => Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
function lccConsts({ a, f, lat1, lat2, latF, k0 = 1 }: LCCParams): { e: number; n: number; F: number; rF: number; aFk: number } {
	const e = eOf(f), p1 = lat1 / D, pF = latF / D;
	let n: number, F: number;
	if (lat2 == null) { n = Math.sin(p1); F = mOf(e, p1) / (n * tOf(e, p1) ** n); }   // 1SP＝原点緯度が標準緯線（lat1＝latF）・縮尺係数 k0
	else {
		const p2 = lat2 / D, m1 = mOf(e, p1), m2 = mOf(e, p2), t1 = tOf(e, p1), t2 = tOf(e, p2);
		n = Math.abs(p1 - p2) < 1e-12 ? Math.sin(p1) : (Math.log(m1) - Math.log(m2)) / (Math.log(t1) - Math.log(t2));
		F = m1 / (n * t1 ** n);
	}
	return { e, n, F, rF: a * F * tOf(e, pF) ** n * k0, aFk: a * F * k0 };
}
/** ランベルト正角円錐の逆変換（lat2 を省く＝1SP）。x=東距 y=北距（m）→ [lon, lat]（度） */
export function lccInverse(o: LCCParams): InverseXY {
	const { e, n, rF, aFk } = lccConsts(o), lonF = o.lonF / D, fe = o.fe ?? 0, fn = o.fn ?? 0, sg = Math.sign(n);
	return (x, y) => {
		const dx = x - fe, dy = rF - (y - fn), r = sg * Math.hypot(dx, dy), t = (r / aFk) ** (1 / n), th = Math.atan2(sg * dx, sg * dy);
		let phi = Math.PI / 2 - 2 * Math.atan(t);
		for (let i = 0; i < 8; i++) phi = Math.PI / 2 - 2 * Math.atan(t * ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2));
		return [(th / n + lonF) * D, phi * D];
	};
}
/** ランベルト正角円錐の順変換（検定用）。[lon, lat]（度）→ [x, y]（m） */
export function lccForward(o: LCCParams): ForwardXY {
	const { e, n, rF, aFk } = lccConsts(o), lonF = o.lonF / D, fe = o.fe ?? 0, fn = o.fn ?? 0;
	return (lon, lat) => { const r = aFk * tOf(e, lat / D) ** n, th = n * (lon / D - lonF); return [fe + r * Math.sin(th), fn + rF - r * Math.cos(th)]; };
}
const qOf = (e: number, phi: number): number => { const s = Math.sin(phi); return (1 - e * e) * (s / (1 - e * e * s * s) - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s))); };
function albersConsts({ a, f, lat1, lat2, latF }: AlbersParams): { e: number; n: number; C: number; rho0: number } {
	const e = eOf(f), p1 = lat1 / D, p2 = lat2 / D, m1 = mOf(e, p1), m2 = mOf(e, p2), q1 = qOf(e, p1), q2 = qOf(e, p2);
	const n = Math.abs(p1 - p2) < 1e-12 ? Math.sin(p1) : (m1 * m1 - m2 * m2) / (q2 - q1), C = m1 * m1 + n * q1;
	return { e, n, C, rho0: a * Math.sqrt(C - n * qOf(e, latF / D)) / n };
}
/** アルベルス正積円錐の逆変換。x=東距 y=北距（m）→ [lon, lat]（度） */
export function albersInverse(o: AlbersParams): InverseXY {
	const { a } = o, { e, n, C, rho0 } = albersConsts(o), lonF = o.lonF / D, fe = o.fe ?? 0, fn = o.fn ?? 0, sg = Math.sign(n), e2 = e * e, e4 = e2 * e2, e6 = e4 * e2;
	const qp = 1 - ((1 - e2) / (2 * e)) * Math.log((1 - e) / (1 + e));
	return (x, y) => {
		const dx = x - fe, dy = rho0 - (y - fn), rho = Math.hypot(dx, dy), th = Math.atan2(sg * dx, sg * dy);
		const q = (C - rho * rho * n * n / (a * a)) / n, beta = Math.asin(Math.max(-1, Math.min(1, q / qp)));
		const phi = beta + (e2 / 3 + 31 * e4 / 180 + 517 * e6 / 5040) * Math.sin(2 * beta) + (23 * e4 / 360 + 251 * e6 / 3780) * Math.sin(4 * beta) + (761 * e6 / 45360) * Math.sin(6 * beta);
		return [(lonF + th / n) * D, phi * D];
	};
}
/** アルベルス正積円錐の順変換（検定用）。[lon, lat]（度）→ [x, y]（m） */
export function albersForward(o: AlbersParams): ForwardXY {
	const { a } = o, { e, n, C, rho0 } = albersConsts(o), lonF = o.lonF / D, fe = o.fe ?? 0, fn = o.fn ?? 0;
	return (lon, lat) => { const rho = a * Math.sqrt(C - n * qOf(e, lat / D)) / n, th = n * (lon / D - lonF); return [fe + rho * Math.sin(th), fn + rho0 - rho * Math.cos(th)]; };
}

/** 楕円体のメルカトルのパラメタ。phi1（度）があれば variant B（2SP） */
export interface MercParams { a: number; f: number; k0?: number; phi1?: number | null; lon0?: number; fe?: number; fn?: number }
/** 楕円体のメルカトル（EPSG 9804 variant A／9805 variant B）の逆変換。x=東距 y=北距（m）→ [lon, lat]（度）。
 *  variant B（2SP）は標準緯線 phi1（度）から縮尺係数を出す。緯度は共形緯度からの級数（EPSG Guidance Note 7-2 と同じ）。 */
export function mercInverse({ a, f, k0 = 1, phi1, lon0 = 0, fe = 0, fn = 0 }: MercParams): InverseXY {
	const e2 = 2 * f - f * f, e4 = e2 * e2, e6 = e4 * e2, e8 = e6 * e2;
	if (phi1 != null) { const s = Math.sin(phi1 / D); k0 = Math.cos(phi1 / D) / Math.sqrt(1 - e2 * s * s); }
	return (x, y) => {
		const t = Math.exp((fn - y) / (a * k0)), chi = Math.PI / 2 - 2 * Math.atan(t);
		const phi = chi + (e2 / 2 + 5 * e4 / 24 + e6 / 12 + 13 * e8 / 360) * Math.sin(2 * chi)
			+ (7 * e4 / 48 + 29 * e6 / 240 + 811 * e8 / 11520) * Math.sin(4 * chi)
			+ (7 * e6 / 120 + 81 * e8 / 1120) * Math.sin(6 * chi) + (4279 * e8 / 161280) * Math.sin(8 * chi);
		return [((x - fe) / (a * k0)) * D + lon0, phi * D];
	};
}

/** 楕円体のメルカトルの順変換（検定・COG の warp 用）。(lon, lat)（度）→ [x, y]（m） */
export function mercForward({ a, f, k0 = 1, phi1, lon0 = 0, fe = 0, fn = 0 }: MercParams): ForwardXY {
	const e2 = 2 * f - f * f, e = Math.sqrt(e2);
	if (phi1 != null) { const s = Math.sin(phi1 / D); k0 = Math.cos(phi1 / D) / Math.sqrt(1 - e2 * s * s); }
	return (lon, lat) => { const phi = lat / D, es = e * Math.sin(phi); return [fe + a * k0 * (lon - lon0) / D, fn + a * k0 * Math.log(Math.tan(Math.PI / 4 + phi / 2) * ((1 - es) / (1 + es)) ** (e / 2))]; };
}

/** 横メルカトルのパラメタ（度・m） */
export interface TMParams { a: number; f: number; k0?: number; lat0?: number; lon0?: number; fe?: number; fn?: number }
/** 横メルカトル（Krüger n 級数 6 次・Karney 2011 "Transverse Mercator with an accuracy of a few nanometers" の α/β 展開）。
 *  旧 cog/proj.js（UTM 専用・nm 級）の式を原点緯度 lat0・縮尺係数・原点移動つきに一般化して一本化（2026-10-12・改良点 15）。
 *  旧 convert/proj.js の GSI 式（5 次・mm 級）はこれに置き換え＝平面直角座標系 I〜XIX・UTM・Gauss-Krüger とも同じ式。
 *  共形緯度→測地緯度は打ち切り級数でなく Newton 反復＝機械精度で往復が閉じる。 */
function tmConsts({ a, f, k0 = 1, lat0 = 0, lon0 = 0, fe = 0, fn = 0 }: TMParams) {
	const n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
	const e2 = f * (2 - f), e = Math.sqrt(e2);
	const A = a / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
	const AL = [
		n / 2 - 2 / 3 * n2 + 5 / 16 * n3 + 41 / 180 * n4 - 127 / 288 * n5 + 7891 / 37800 * n6,
		13 / 48 * n2 - 3 / 5 * n3 + 557 / 1440 * n4 + 281 / 630 * n5 - 1983433 / 1935360 * n6,
		61 / 240 * n3 - 103 / 140 * n4 + 15061 / 26880 * n5 + 167603 / 181440 * n6,
		49561 / 161280 * n4 - 179 / 168 * n5 + 6601661 / 7257600 * n6,
		34729 / 80640 * n5 - 3418889 / 1995840 * n6,
		212378941 / 319334400 * n6,
	];
	const BE = [
		n / 2 - 2 / 3 * n2 + 37 / 96 * n3 - 1 / 360 * n4 - 81 / 512 * n5 + 96199 / 604800 * n6,
		1 / 48 * n2 + 1 / 15 * n3 - 437 / 1440 * n4 + 46 / 105 * n5 - 1118711 / 3870720 * n6,
		17 / 480 * n3 - 37 / 840 * n4 - 209 / 4480 * n5 + 5569 / 90720 * n6,
		4397 / 161280 * n4 - 11 / 504 * n5 - 830251 / 7257600 * n6,
		4583 / 161280 * n5 - 108847 / 3991680 * n6,
		20648693 / 638668800 * n6,
	];
	// 測地緯度 tan → 共形緯度 tan、その逆（Newton・2〜3 回で収束）
	const tauPrime = (tau: number): number => { const sig = Math.sinh(e * Math.atanh(e * tau / Math.hypot(1, tau))); return tau * Math.hypot(1, sig) - sig * Math.hypot(1, tau); };
	const tauOf = (taup: number): number => {
		let tau = taup / (1 - e2);
		for (let i = 0; i < 5; i++) {
			const d = taup - tauPrime(tau);
			if (Math.abs(d) < 1e-15 * Math.max(1, Math.abs(taup))) break;
			const dt = (Math.hypot(1, tauPrime(tau)) * Math.hypot(1, tau) * (1 - e2)) / (1 + (1 - e2) * tau * tau) || 1;
			tau += d / dt;
		}
		return tau;
	};
	const fwd0 = (lonDeg: number, latDeg: number): [number, number] => {   // [東距, 北距]（原点移動なし・赤道基準）
		const lam = (lonDeg - lon0) / D, phi = latDeg / D;
		const taup = tauPrime(Math.tan(phi)), xip = Math.atan2(taup, Math.cos(lam)), etap = Math.asinh(Math.sin(lam) / Math.hypot(taup, Math.cos(lam)));
		let xi = xip, eta = etap;
		for (let j = 1; j <= 6; j++) { xi += AL[j - 1] * Math.sin(2 * j * xip) * Math.cosh(2 * j * etap); eta += AL[j - 1] * Math.cos(2 * j * xip) * Math.sinh(2 * j * etap); }
		return [k0 * A * eta, k0 * A * xi];
	};
	const N0 = lat0 ? fwd0(lon0, lat0)[1] : 0;   // 原点緯度の北距＝k0 × 子午線弧長
	return { A, k0, lon0, fe, fn, N0, AL, BE, tauOf, fwd0 };
}
/** 横メルカトルの逆変換。x=東距 y=北距（m）→ [lon, lat]（度）。 */
export function tmInverse(o: TMParams): InverseXY {
	const { A, k0, lon0, fe, fn, N0, BE, tauOf } = tmConsts(o);
	return (x, y) => {
		const eta0 = (x - fe) / (k0 * A), xi0 = (y - fn + N0) / (k0 * A);
		let xip = xi0, etap = eta0;
		for (let j = 1; j <= 6; j++) { xip -= BE[j - 1] * Math.sin(2 * j * xi0) * Math.cosh(2 * j * eta0); etap -= BE[j - 1] * Math.cos(2 * j * xi0) * Math.sinh(2 * j * eta0); }
		const taup = Math.sin(xip) / Math.hypot(Math.sinh(etap), Math.cos(xip));
		return [lon0 + Math.atan2(Math.sinh(etap), Math.cos(xip)) * D, Math.atan(tauOf(taup)) * D];
	};
}
/** 横メルカトルの順変換。[lon, lat]（度）→ [x=東距, y=北距]（m）。 */
export function tmForward(o: TMParams): XF {
	const { fe, fn, N0, fwd0 } = tmConsts(o);
	return ([lon, lat]) => { const [e, n] = fwd0(lon, lat); return [e + fe, n - N0 + fn]; };
}
