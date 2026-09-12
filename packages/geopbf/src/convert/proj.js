// convert/proj.js ── CRS の WKT（OGC / Esri）を読んで「経緯度へ戻せるか」を判定し、戻せるなら逆変換関数を返す（依存ゼロ）。
// GeoPBF は経緯度だけを持つので、入口（FileGDB / GeoPackage）で PROJCS を経緯度に戻す。対応は
//   ・GEOGCS: WGS84 / JGD2011 / ITRF / ETRS89 / NAD83 / GDA 系＝そのまま経緯度（測地系差は m 未満〜1m 級）
//   ・PROJCS Transverse_Mercator（平面直角座標系 I〜XIX・UTM・Gauss-Krüger）＝Krüger 級数の逆変換（GSI の式・mm 級）
//   ・PROJCS Mercator_Auxiliary_Sphere / Popular Visualisation Pseudo Mercator（Web メルカトル）＝球の逆変換
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
	if (/mercator_auxiliary_sphere|pseudo_?mercator|popular_visualisation|mercator_1sp/i.test(method) && Math.abs(P("central_meridian", "Longitude of natural origin") ?? 0) < 1e-9) {
		return wrap(([x, y]) => [x * toM / R * D, (2 * Math.atan(Math.exp(y * toM / R)) - Math.PI / 2) * D]);
	}
	return { kind: "other", label: `${label} (${method || "projection ?"})`, name };
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
