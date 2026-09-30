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

import { tokyoToJGD, jgd2000To2011 } from "./datum.js";

const D = 180 / Math.PI, R = 6378137;
const TOKYO = /D_Tokyo|^Tokyo\b|GCS_Tokyo|Tokyo Datum|Tokyo_Datum/i;
const JGD2000 = /JGD_?2000|Japanese_Geodetic_Datum_2000/i;

/** WKT を木にする: NAME["str", child, 1.5, …] → { name, args: [ string | number | node ] } */
export function parseWKTTree(wkt) {
	let p = 0; const s = String(wkt || "").trim();
	const ws = () => { while (p < s.length && /\s/.test(s[p])) p++; };
	const node = () => {
		ws(); const m = s.slice(p).match(/^[A-Za-z_][A-Za-z0-9_]*/); if (!m) return null; p += m[0].length; ws();
		const n = { name: m[0].toUpperCase(), args: [] };
		if (s[p] !== "[" && s[p] !== "(") return n;
		const close = s[p] === "[" ? "]" : ")"; p++;
		for (;;) {
			ws(); if (s[p] === close) { p++; break; }
			if (s[p] === '"') { let q = p + 1, str = ""; while (q < s.length && s[q] !== '"') str += s[q++]; p = q + 1; n.args.push(str); }
			else if (/[-+.\d]/.test(s[p])) { const mm = s.slice(p).match(/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/); p += mm[0].length; n.args.push(+mm[0]); }
			else { const c = node(); if (!c) break; n.args.push(c); }
			ws(); if (s[p] === ",") p++;
		}
		return n;
	};
	try { return node(); } catch { return null; }
}
const child = (n, name) => n?.args.find(a => a && typeof a === "object" && a.name === name);
const children = (n, name) => n?.args.filter(a => a && typeof a === "object" && a.name === name) ?? [];

const LONLAT_DATUMS = /WGS_?1984|WGS_?84|JGD_?2011|Japanese_Geodetic_Datum_2011|ITRF|ETRS_?(19)?89|European_Terrestrial|NAD_?(19)?83|North_American_1983|GDA_?(19)?94|GDA_?2020|Geocentric_Datum_of_Australia|CGCS2000|China_2000|Korea_2000|KGD2002|SIRGAS|Hartebeesthoek94|NZGD_?2000|PZ-?90|CH1903\+|Swiss/i;

/** WKT → 判定と逆変換。 */
export function crsFromWKT(wkt, opts = {}) {
	const t = parseWKTTree(wkt);
	if (!t) return { kind: "other", label: String(wkt || "").slice(0, 40) || "unknown", name: null };
	const root = t.name === "PROJCS" || t.name === "GEOGCS" || t.name === "GEOGCRS" || t.name === "PROJCRS" ? t : (child(t, "PROJCS") || child(t, "GEOGCS") || t);
	const name = typeof root.args[0] === "string" ? root.args[0] : null;
	const auth = child(root, "AUTHORITY"); const label = auth && auth.args.length >= 2 ? `${auth.args[0]}:${auth.args[1]}` : (name || root.name);
	const geog = root.name === "GEOGCS" || root.name === "GEOGCRS" ? root : (child(root, "GEOGCS") || child(root, "BASEGEOGCRS") || child(root, "GEOGCRS"));
	const datum = child(geog, "DATUM"); const datumName = (datum && typeof datum.args[0] === "string" ? datum.args[0] : "") + " " + (geog && typeof geog.args[0] === "string" ? geog.args[0] : "");
	// 測地系: Tokyo → JGD2000（→ JGD2011）／JGD2000 → JGD2011（PatchJGD がある時だけ）／それ以外の既知は素通し
	const { tokyo: tokyoGrid = null, patch = null } = opts.datum || {};
	const isTokyo = TOKYO.test(datumName), isJGD2000 = !isTokyo && JGD2000.test(datumName), geogOK = !isTokyo && !isJGD2000 && LONLAT_DATUMS.test(datumName);
	let shift = null, shiftLabel = "", approx = false;
	if (isTokyo) {
		shift = patch ? (p => jgd2000To2011(tokyoToJGD(p, tokyoGrid), patch)) : (p => tokyoToJGD(p, tokyoGrid));
		shiftLabel = `Tokyo→${patch ? "JGD2011" : "JGD2000"} (${tokyoGrid ? "TKY2JGD ±0.2 m" : "Helmert ±10 m"}${patch ? " + PatchJGD" : ""})`;
		approx = !tokyoGrid;
	} else if (isJGD2000 && patch) {
		shift = (p => jgd2000To2011(p, patch));
		shiftLabel = "JGD2000→JGD2011 (PatchJGD)";
	}
	if (root.name === "GEOGCS" || root.name === "GEOGCRS") {
		if (shift) return { kind: "datum", label: `${label} → ${shiftLabel}`, name, approx, toLonLat: shift };
		if (geogOK || isJGD2000) return { kind: "lonlat", label, name };
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
	const params = {}; for (const pn of children(root, "PARAMETER").concat(children(child(root, "CONVERSION"), "PARAMETER"))) if (typeof pn.args[0] === "string") params[pn.args[0].toLowerCase().replace(/[\s_]+/g, "_")] = pn.args[1];
	const P = (...names) => { for (const n of names) { const k = n.toLowerCase().replace(/[\s_]+/g, "_"); if (params[k] !== undefined) return +params[k]; } return undefined; };
	const unit = child(root, "UNIT") || child(root, "LENGTHUNIT"); const toM = unit && typeof unit.args[1] === "number" ? unit.args[1] : 1;
	if (!geogOK && !isTokyo && !isJGD2000) return { kind: "other", label: `${label} (datum ${datumName.trim() || "?"})`, name };
	const wrap = (fn) => shift ? { kind: "projected", label: `${label} → ${shiftLabel}`, name, approx, toLonLat: p => shift(fn(p)) } : { kind: "projected", label, name, toLonLat: fn };
	if (/transverse_?mercator|gauss_?kruger/i.test(method) && !/south_orientated/i.test(method)) {
		const inv = tmInverse({ a, f, k0: P("scale_factor", "Scale factor at natural origin") ?? 1, lat0: P("latitude_of_origin", "Latitude of natural origin", "latitude_of_center") ?? 0, lon0: P("central_meridian", "Longitude of natural origin", "longitude_of_center") ?? 0, fe: (P("false_easting") ?? 0) * toM, fn: (P("false_northing") ?? 0) * toM });   // 原点移動も投影の単位（フィート等）で書かれている。旧測地系なら元の楕円体（Bessel 等）で逆変換してから測地系変換
		return wrap(([x, y]) => inv(x * toM, y * toM));
	}
	// メルカトル（2026-09-25・B9c）：球（Web メルカトル＝EPSG:3857・Esri 102100）と楕円体（Mercator 1SP/2SP＝EPSG:3395 等）を分ける。
	// 旧＝楕円体のメルカトルも球の式で逆変換（緯度 35° で約 −20 km）し、中央子午線 0 以外・縮尺係数・原点移動を扱わなかった
	const m = method.replace(/[\s()]+/g, "_").replace(/_+$/, "");
	// GDAL の WKT1 は EPSG:3857 を PROJECTION["Mercator_1SP"]＋WGS84 楕円体で書く（球であることは名前・AUTHORITY・PROJ4 の拡張にしか出ない）＝
	// 方法の名前だけで見ると楕円体の逆変換になり緯度 40° で約 0.19° ずれる（2026-09-30・#178 の COPC の試料で発見）
	const ext = child(root, "EXTENSION"), proj4 = ext && typeof ext.args[1] === "string" ? ext.args[1] : "";
	const pseudo = /mercator_auxiliary_sphere|pseudo_?mercator|popular_visualisation/i.test(m)
		|| /pseudo[\s_-]?mercator|web[\s_-]?mercator|popular visualisation/i.test(name || "")
		|| /^(EPSG|ESRI):(3857|3785|900913|102100|102113)$/.test(label)
		|| (/\+a=6378137\b/.test(proj4) && /\+b=6378137\b/.test(proj4));
	if (pseudo || /^mercator(_1sp|_2sp|_variant_[ab])?$/i.test(m)) {
		const lon0 = P("central_meridian", "Longitude of natural origin", "longitude_of_origin") ?? 0;
		const fe = (P("false_easting") ?? 0) * toM, fn = (P("false_northing") ?? 0) * toM;
		if (pseudo) return wrap(([x, y]) => [(x * toM - fe) / R * D + lon0, (2 * Math.atan(Math.exp((y * toM - fn) / R)) - Math.PI / 2) * D]);
		const phi1 = P("standard_parallel_1", "Latitude of 1st standard parallel");
		const inv = mercInverse({ a, f, k0: P("scale_factor", "Scale factor at natural origin") ?? 1, phi1, lon0, fe, fn });
		return wrap(([x, y]) => inv(x * toM, y * toM));
	}
	// ランベルト正角円錐（LCC 1SP/2SP＝米国の State Plane の多く）・アルベルス正積円錐（CONUS Albers 等）（2026-09-30・#178）
	const lonF = P("central_meridian", "longitude_of_center", "Longitude of false origin", "Longitude of natural origin", "longitude_of_origin") ?? 0;
	const latO = P("latitude_of_origin", "latitude_of_center", "Latitude of false origin", "Latitude of natural origin"), latF = latO ?? 0;
	const fe = (P("false_easting", "Easting at false origin", "False easting") ?? 0) * toM, fn = (P("false_northing", "Northing at false origin", "False northing") ?? 0) * toM;
	const sp1 = P("standard_parallel_1", "Latitude of 1st standard parallel"), sp2 = P("standard_parallel_2", "Latitude of 2nd standard parallel");
	// 標準緯線も原点緯度も無い円錐＝円錐の定数が 0（赤道で潰れる）＝読めない物として other（パラメタの抜けた WKT を黙って誤配置しない）
	if (/lambert_?conformal_?conic|albers/i.test(m) && sp1 == null && !latO) return { kind: "other", label: `${label} (${method}: no standard parallel)`, name };
	if (/lambert_?conformal_?conic/i.test(m)) {
		const k0 = P("scale_factor", "Scale factor at natural origin") ?? 1;
		const one = /1sp/i.test(m) || sp1 == null;
		const inv = lccInverse({ a, f, lat1: one ? latF : sp1, lat2: one ? null : (sp2 ?? sp1), latF, lonF, k0: one ? k0 : 1, fe, fn });
		return wrap(([x, y]) => inv(x * toM, y * toM));
	}
	if (/albers/i.test(m)) {
		const inv = albersInverse({ a, f, lat1: sp1 ?? latF, lat2: sp2 ?? sp1 ?? latF, latF, lonF, fe, fn });
		return wrap(([x, y]) => inv(x * toM, y * toM));
	}
	return { kind: "other", label: `${label} (${method || "projection ?"})`, name };
}

// ── 円錐図法（EPSG Guidance Note 7-2 の式）──
const eOf = f => Math.sqrt(2 * f - f * f);
const mOf = (e, phi) => Math.cos(phi) / Math.sqrt(1 - e * e * Math.sin(phi) ** 2);
const tOf = (e, phi) => Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
function lccConsts({ a, f, lat1, lat2, latF, k0 = 1 }) {
	const e = eOf(f), p1 = lat1 / D, pF = latF / D;
	let n, F;
	if (lat2 == null) { n = Math.sin(p1); F = mOf(e, p1) / (n * tOf(e, p1) ** n); }   // 1SP＝原点緯度が標準緯線（lat1＝latF）・縮尺係数 k0
	else {
		const p2 = lat2 / D, m1 = mOf(e, p1), m2 = mOf(e, p2), t1 = tOf(e, p1), t2 = tOf(e, p2);
		n = Math.abs(p1 - p2) < 1e-12 ? Math.sin(p1) : (Math.log(m1) - Math.log(m2)) / (Math.log(t1) - Math.log(t2));
		F = m1 / (n * t1 ** n);
	}
	return { e, n, F, rF: a * F * tOf(e, pF) ** n * k0, aFk: a * F * k0 };
}
/** ランベルト正角円錐の逆変換（lat2 を省く＝1SP）。x=東距 y=北距（m）→ [lon, lat]（度） */
export function lccInverse(o) {
	const { e, n, rF, aFk } = lccConsts(o), lonF = o.lonF / D, fe = o.fe ?? 0, fn = o.fn ?? 0, sg = Math.sign(n);
	return (x, y) => {
		const dx = x - fe, dy = rF - (y - fn), r = sg * Math.hypot(dx, dy), t = (r / aFk) ** (1 / n), th = Math.atan2(sg * dx, sg * dy);
		let phi = Math.PI / 2 - 2 * Math.atan(t);
		for (let i = 0; i < 8; i++) phi = Math.PI / 2 - 2 * Math.atan(t * ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2));
		return [(th / n + lonF) * D, phi * D];
	};
}
/** ランベルト正角円錐の順変換（検定用）。[lon, lat]（度）→ [x, y]（m） */
export function lccForward(o) {
	const { e, n, rF, aFk } = lccConsts(o), lonF = o.lonF / D, fe = o.fe ?? 0, fn = o.fn ?? 0;
	return (lon, lat) => { const r = aFk * tOf(e, lat / D) ** n, th = n * (lon / D - lonF); return [fe + r * Math.sin(th), fn + rF - r * Math.cos(th)]; };
}
const qOf = (e, phi) => { const s = Math.sin(phi); return (1 - e * e) * (s / (1 - e * e * s * s) - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s))); };
function albersConsts({ a, f, lat1, lat2, latF }) {
	const e = eOf(f), p1 = lat1 / D, p2 = lat2 / D, m1 = mOf(e, p1), m2 = mOf(e, p2), q1 = qOf(e, p1), q2 = qOf(e, p2);
	const n = Math.abs(p1 - p2) < 1e-12 ? Math.sin(p1) : (m1 * m1 - m2 * m2) / (q2 - q1), C = m1 * m1 + n * q1;
	return { e, n, C, rho0: a * Math.sqrt(C - n * qOf(e, latF / D)) / n };
}
/** アルベルス正積円錐の逆変換。x=東距 y=北距（m）→ [lon, lat]（度） */
export function albersInverse(o) {
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
export function albersForward(o) {
	const { a } = o, { e, n, C, rho0 } = albersConsts(o), lonF = o.lonF / D, fe = o.fe ?? 0, fn = o.fn ?? 0;
	return (lon, lat) => { const rho = a * Math.sqrt(C - n * qOf(e, lat / D)) / n, th = n * (lon / D - lonF); return [fe + rho * Math.sin(th), fn + rho0 - rho * Math.cos(th)]; };
}

/** 楕円体のメルカトル（EPSG 9804 variant A／9805 variant B）の逆変換。x=東距 y=北距（m）→ [lon, lat]（度）。
 *  variant B（2SP）は標準緯線 phi1（度）から縮尺係数を出す。緯度は共形緯度からの級数（EPSG Guidance Note 7-2 と同じ）。 */
export function mercInverse({ a, f, k0 = 1, phi1, lon0 = 0, fe = 0, fn = 0 }) {
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

/** 横メルカトル（Krüger 級数・GSI「平面直角座標→緯度経度」と同じ式）の逆変換。x=東距 y=北距（m）→ [lon, lat]（度）。 */
export function tmInverse({ a, f, k0, lat0, lon0, fe, fn }) {
	const n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
	const A = a / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
	// 原点緯度までの子午線弧長（測地緯度の級数＝GSI の A_j。共形緯度用の α とは別物）
	const A0 = 1 + n2 / 4 + n4 / 64, Aj = [-1.5 * (n - n3 / 8 - n5 / 64), 15 / 16 * (n2 - n4 / 4), -35 / 48 * (n3 - 5 * n5 / 16), 315 / 512 * n4, -693 / 1280 * n5];
	const beta = [n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512, n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105, 17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480, 4397 * n4 / 161280 - 11 * n5 / 504, 4583 * n5 / 161280];
	const delta = [2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45 + 26 * n5 / 45 - 2854 * n6 / 675, 7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45 + 2704 * n5 / 315 + 2323 * n6 / 945, 56 * n3 / 15 - 136 * n4 / 35 - 1262 * n5 / 105 + 73814 * n6 / 2835, 4279 * n4 / 630 - 332 * n5 / 35 - 399572 * n6 / 14175, 4174 * n5 / 315 - 144838 * n6 / 6237, 601676 * n6 / 22275];
	const phi0 = lat0 / D, lam0 = lon0 / D;
	let S0 = A0 * phi0; for (let j = 1; j <= 5; j++) S0 += Aj[j - 1] * Math.sin(2 * j * phi0);
	S0 *= a / (1 + n);             // 原点緯度までの子午線弧長 S(φ0)
	const Ab = k0 * A;
	return (x, y) => {
		const xi = (y - fn + k0 * S0) / Ab, eta = (x - fe) / Ab;
		let xi2 = xi, eta2 = eta;
		for (let j = 1; j <= 5; j++) { xi2 -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); eta2 -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
		const chi = Math.asin(Math.sin(xi2) / Math.cosh(eta2));
		let phi = chi; for (let j = 1; j <= 6; j++) phi += delta[j - 1] * Math.sin(2 * j * chi);
		const lam = lam0 + Math.atan2(Math.sinh(eta2), Math.cos(xi2));
		return [lam * D, phi * D];
	};
}

/** 横メルカトルの順変換（検定・往復確認用）。[lon, lat]（度）→ [x=東距, y=北距]（m）。 */
export function tmForward({ a, f, k0, lat0, lon0, fe, fn }) {
	const n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
	const A = a / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
	const A0 = 1 + n2 / 4 + n4 / 64, Aj = [-1.5 * (n - n3 / 8 - n5 / 64), 15 / 16 * (n2 - n4 / 4), -35 / 48 * (n3 - 5 * n5 / 16), 315 / 512 * n4, -693 / 1280 * n5];
	const alpha = [n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288, 13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630, 61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880, 49561 * n4 / 161280 - 179 * n5 / 168, 34729 * n5 / 80640];
	const phi0 = lat0 / D; let S0 = A0 * phi0; for (let j = 1; j <= 5; j++) S0 += Aj[j - 1] * Math.sin(2 * j * phi0); S0 *= a / (1 + n);
	const Ab = k0 * A, sn = 2 * Math.sqrt(n) / (1 + n);
	return ([lon, lat]) => {
		const phi = lat / D, dl = (lon - lon0) / D;
		const t = Math.sinh(Math.atanh(Math.sin(phi)) - sn * Math.atanh(sn * Math.sin(phi))), tb = Math.sqrt(1 + t * t);
		const xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / tb);
		let X = xi, Y = eta; for (let j = 1; j <= 5; j++) { X += alpha[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); Y += alpha[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
		return [Ab * Y + fe, Ab * X - k0 * S0 + fn];
	};
}
