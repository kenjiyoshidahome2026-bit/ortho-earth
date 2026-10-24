// 静岡県の点群の頁（pointcloud.ts）の図郭と座標＝依存なしの純関数（node で検定＝tests/t-pointcloud.mjs）。
// 平面直角座標系 VIII 系（EPSG:6676・JGD2011・原点 北緯 36°・東経 138°30′・縮尺係数 0.9999）の換算は河瀬（2011）の式＝国土地理院の計算の式（Krüger の 3 次まで・mm 以下）。
//   geopbf/proj（crsFromWKT）はエンジンにも入っている＝頁の束に焼くと二重焼きの門番に掛かる。頁が要るのは VIII 系だけ＝ここに持つ。
// 図郭＝国土基本図の図郭（地図情報レベル 50000＝行 A〜T（30 km）・列 A〜H（40 km）→ 5000＝10×10（3 km × 4 km）→ 500＝10×10（300 m × 400 m））。
//   系の原点から北へ +300 km・西へ −160 km が A・A の左上。"MC4919"＝M 行 C 列・5000 の 4 行 9 列・500 の 1 行 9 列。座標は [E（東・LAS の X）, N（北・LAS の Y）] の m。

const a = 6378137, f = 1 / 298.257222101, n = f / (2 - f), k0 = 0.9999;
const phi0 = 36 * Math.PI / 180, lam0 = 138.5 * Math.PI / 180;
const A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64);
const al = [n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, 13 * n * n / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240];
const be = [n / 2 - 2 * n * n / 3 + 37 * n ** 3 / 96, n * n / 48 + n ** 3 / 15, 17 * n ** 3 / 480];
const de = [2 * n - 2 * n * n / 3 - 2 * n ** 3, 7 * n * n / 3 - 8 * n ** 3 / 5, 56 * n ** 3 / 15];
const c = 2 * Math.sqrt(n) / (1 + n);
// 赤道からの北の距離・東の距離（原点の緯度を引く前）
function raw(phi: number, lam: number): [number, number] {
	const s = Math.sin(phi), t = Math.sinh(Math.atanh(s) - c * Math.atanh(c * s)), dl = lam - lam0;
	const xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
	let x = xi, y = eta;
	for (let j = 1; j <= 3; j++) { x += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); y += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
	return [k0 * A * x, k0 * A * y];
}
const X0 = raw(phi0, lam0)[0];
/** 経緯度（度）→ VIII 系の [E, N]（m） */
export function toPlane(lon: number, lat: number): [number, number] {
	const [x, y] = raw(lat * Math.PI / 180, lon * Math.PI / 180);
	return [y, x - X0];
}
/** VIII 系の [E, N]（m）→ [経度, 緯度]（度） */
export function toLonLat(e: number, nn: number): [number, number] {
	const xi = (nn + X0) / (k0 * A), eta = e / (k0 * A);
	let xp = xi, ep = eta;
	for (let j = 1; j <= 3; j++) { xp -= be[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); ep -= be[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
	const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
	let phi = chi; for (let j = 1; j <= 3; j++) phi += de[j - 1] * Math.sin(2 * j * chi);
	return [(lam0 + Math.atan2(Math.sinh(ep), Math.cos(xp))) * 180 / Math.PI, phi * 180 / Math.PI];
}

const ROWS = "ABCDEFGHIJKLMNOPQRST", COLS = "ABCDEFGH";
/** 図郭の番号（"MC"・"MC49"・"MC4919"・小文字も）→ [西 E, 南 N, 東 E, 北 N]。読めなければ null */
export function sheetBox(code: string): [number, number, number, number] | null {
	const m = /^([A-T])([A-H])(?:(\d)(\d)(?:(\d)(\d))?)?$/i.exec(code); if (!m) return null;
	let nn = 300000 - 30000 * ROWS.indexOf(m[1].toUpperCase()), e = -160000 + 40000 * COLS.indexOf(m[2].toUpperCase()), h = 30000, w = 40000;
	if (m[3] != null) { nn -= 3000 * +m[3]; e += 4000 * +m[4]; h = 3000; w = 4000; }
	if (m[5] != null) { nn -= 300 * +m[5]; e += 400 * +m[6]; h = 300; w = 400; }
	return [e, nn - h, e + w, nn];
}
/** 平面の位置 → 図郭の番号（level＝"5000" か "500"）。系の範囲の外は null */
export function sheetAt(e: number, nn: number, level: "5000" | "500"): string | null {
	const r = Math.floor((300000 - nn) / 30000), cc = Math.floor((e + 160000) / 40000);
	if (r < 0 || r >= ROWS.length || cc < 0 || cc >= COLS.length) return null;
	const n0 = 300000 - 30000 * r, e0 = -160000 + 40000 * cc, r5 = Math.floor((n0 - nn) / 3000), c5 = Math.floor((e - e0) / 4000);
	const code = ROWS[r] + COLS[cc] + r5 + c5;
	if (level === "5000") return code;
	return code + Math.floor((n0 - 3000 * r5 - nn) / 300) + Math.floor((e - e0 - 4000 * c5) / 400);
}
/** 図郭の外周（経緯度の閉じた環） */
export const sheetRing = (b: readonly number[]): Array<[number, number]> => [toLonLat(b[0], b[1]), toLonLat(b[2], b[1]), toLonLat(b[2], b[3]), toLonLat(b[0], b[3]), toLonLat(b[0], b[1])];
