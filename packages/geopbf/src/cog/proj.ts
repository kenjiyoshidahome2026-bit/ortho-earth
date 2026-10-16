// COG の源 CRS ⇄ WGS84 経緯度。2026-10-12（改良点 15）: 独自の Krüger＋UTM 専用の式をやめ、convert/epsg.js（EPSG → WKT）＋
// convert/proj.js（crsFromWKT＝一本化した Krüger 6 次・nm 級）に乗る＝経緯度（4326/4258/4269/4612/6668/4019）・3857・
// UTM（WGS84 326xx/327xx・JGD2011 6688–6691・JGD2000 3097–3101）・平面直角座標系 I〜XIX（JGD2011 6669–6687・JGD2000 2443–2461）が読める。
// 旧日本測地系（Tokyo: 4301・30161–30179）は測地系変換の順方向（経緯度→Tokyo）が無く warp に使えないので null（呼び手が明示エラー）。
// 依存ゼロ・DOM 無し（Node でそのまま動く＝CLI/テスト共用）。
import { epsgToWKT } from "../convert/epsg.ts";
import { crsFromWKT } from "../convert/proj.ts";

/** 源 CRS ⇄ 経緯度 */
export interface Projection {
	/** [lon, lat] → [X, Y]（源 CRS） */
	forward(p: readonly number[]): [number, number];
	/** [X, Y] → [lon, lat] */
	inverse(p: readonly number[]): [number, number];
	label: string;
}

// EPSG → {forward([lon,lat])→[x,y], inverse([x,y])→[lon,lat], label}。非対応は null（呼び出し側が明示エラー）。
export function projFor(epsg: number): Projection | null {
	const wkt = epsgToWKT(epsg);
	if (!wkt) return null;
	const c = crsFromWKT(wkt);
	if (c.kind === "lonlat") return { forward: ([lon, lat]) => [lon, lat], inverse: ([x, y]) => [x, y], label: c.label };
	if (c.kind !== "projected" || !c.toLonLat || !c.fromLonLat) return null;
	return { forward: c.fromLonLat, inverse: c.toLonLat, label: c.label };
}
/** 対応する EPSG の説明（エラー文用） */
export const SUPPORTED_EPSG = "lon/lat 4326/4258/4269/4612/6668, 3857, UTM 326xx/327xx (JGD 6688-6691, 3097-3101), JPR I-XIX 6669-6687 / 2443-2461";
