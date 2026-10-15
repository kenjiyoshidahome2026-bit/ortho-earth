// 点群（LAS/LAZ/COPC）の座標系を決める（点群計画 段 3-2・2026-10-15）。copc-worker.js から切り出し、普通の LAS/LAZ の読み手と共用する。
//   水平：opts.crs（"EPSG:6676" か WKT）＞ ファイルの WKT（VLR 2112）＞ GeoTIFF キー（VLR 34735 の EPSG 番号 → geopbf の表で WKT に）。どれも無ければ止める
//         （日本の配布物は座標系を書いていない物が多い＝opts.crs で平面直角の系を渡す）
//   鉛直：WKT に鉛直の CRS（VERT_CS・VERTCRS）がある＝標高（ジオイド系）・"ellipsoid" を含めば楕円体高。GeoTIFF キーの VerticalCSType がある＝標高。
//         どれも無い時は opts.vertical（"orthometric" | "ellipsoidal"）＞ 既定＝投影座標（TM・LCC・Albers＝国や州の平面の系）なら標高、
//         経緯度・メルカトルなら楕円体高（従来どおり）。平面の系で測った航空レーザの高さは測量の作法で標高が普通（座標系を書かない配布物の多くがこれ）
import { crsFromWKT, parseWKTTree } from "geopbf/proj";
import { epsgToWKT } from "geopbf/epsg";

const find = (n, re) => { if (!n || typeof n !== "object") return null; if (re.test(n.name)) return n; for (const a of n.args || []) { const r = find(a, re); if (r) return r; } return null; };
const unitOf = n => { const u = (n?.args || []).filter(a => a && typeof a === "object" && /^(UNIT|LENGTHUNIT)$/.test(a.name)).pop(); return u && typeof u.args[1] === "number" ? u.args[1] : null; };
const MERCATOR = /PROJECTION\["?(Mercator|Popular_Visualisation)|Pseudo-Mercator/i;   // TM（Transverse_Mercator）は含まない

/** WKT の鉛直の側 → { has, orthometric, unit, name } */
export function verticalOf(wkt) {
	const t = parseWKTTree(wkt);
	const v = find(t, /^(VERT_CS|VERTCRS|VERTICALCRS)$/), horiz = find(t, /^(PROJCS|PROJCRS)$/);
	const ellipsoidalV = v && /ellipsoid/i.test(JSON.stringify(v));
	return { has: !!v, orthometric: !!v && !ellipsoidalV, unit: (v && unitOf(v)) || (horiz && unitOf(horiz)) || 1, name: v && typeof v.args[0] === "string" ? v.args[0] : null };
}

/**
 * @param {{ wkt?: string|null, geoKeys?: { horizontal: number|null, vertical: number|null }|null, crs?: string, vertical?: "orthometric"|"ellipsoidal" }} o
 * @returns {{ crs, ll, label: string, vUnit: number, orthometric: boolean, verticalName: string, lonlat: boolean, from: "opts"|"wkt"|"geokeys" }}
 */
export function resolveCrs({ wkt = null, geoKeys = null, crs: optCrs, vertical: optV } = {}) {
	let src = null, from = null;
	if (optCrs) {
		const m = /^EPSG:(\d+)$/i.exec(String(optCrs).trim());
		src = m ? epsgToWKT(+m[1]) : String(optCrs); from = "opts";
		if (!src) throw new Error(`pointcloud: ${optCrs} is not in the built-in EPSG table — pass the WKT instead`);
	} else if (wkt) { src = wkt; from = "wkt"; }
	else if (geoKeys?.horizontal) {
		src = epsgToWKT(geoKeys.horizontal); from = "geokeys";
		if (!src) throw new Error(`pointcloud: EPSG:${geoKeys.horizontal} (GeoTIFF keys) is not in the built-in EPSG table — pass { crs: <WKT> }`);
	}
	if (!src) throw new Error('pointcloud: no coordinate system in the file — pass it, e.g. { crs: "EPSG:6676" } (a plane rectangular CS)');
	const crs = crsFromWKT(src);
	if (crs.kind === "other") throw new Error(`pointcloud: coordinate system not supported (${crs.label}) — TM/UTM, Mercator, Lambert conformal conic, Albers and lon/lat are`);
	const v = verticalOf(src);
	let orthometric, name;
	if (v.has) { orthometric = v.orthometric; name = v.name; }
	else if (from === "geokeys" && geoKeys.vertical) { orthometric = true; name = `EPSG:${geoKeys.vertical}`; }
	else if (optV) { orthometric = optV === "orthometric"; name = optV; }
	else { orthometric = crs.kind === "projected" && !MERCATOR.test(src); name = orthometric ? "orthometric (assumed: projected CRS without a vertical CRS)" : null; }
	return {
		crs, ll: crs.toLonLat || (p => p), label: crs.label, vUnit: v.unit, orthometric, verticalName: orthometric ? (name || "orthometric") : "ellipsoidal",
		lonlat: crs.kind === "lonlat" || (crs.kind === "datum" && !/PROJ/i.test(src.slice(0, 20))), from,
	};
}
