// HEALPix（NESTED）の番地 ⇄ 経緯度。メルカトルの tile.ts と並ぶ「もう 1 つのタイル行列」の純関数（2026-11-26・規約＝docs/design/healpix.md）。
// 依存なし・DOM に触れない＝ worker と Node の検定からそのまま使える。式は healpix_base（C++）の loc2pix／xyf2loc／neighbors の移植で、
// 検定（tests/healpix.mjs）が healpy 1.20 の値と突き合わせる。
//
// 規約：
//   ・φ＝東経（ラジアン）・z＝sin(緯度)。緯度は測地緯度をそのまま使う（等積緯度へは直さない＝表示用。面積を数える用途は呼び手が直す）。
//   ・面（face 0..11）は単位正方形。面内の座標 (x, y) ∈ [0,1)＝ x は HEALPix の ix の軸（北東へ増える）・y は iy の軸（北西へ増える）。
//     セルの隅＝南 (0,0)・東 (1,0)・西 (0,1)・北 (1,1)。
//   ・タイル（order k・番号 npix）＝ face·4^k ＋ interleave(ix, iy)（ix のビットが偶数位・iy が奇数位）。
//   ・タイルの中の画素（幅 W＝2 の冪・列 col・行 row・行優先）＝ x = (ix + (col+0.5)/W) / 2^k・y = (iy + (row+0.5)/W) / 2^k。
//     ＝画素 (col,row) はちょうど order k+log2(W) の NESTED セル face·4^(k+w) ＋ interleave(ix·W+col, iy·W+row)。
//     子 i（0..3）は列 (i&1)·W/2・行 (i>>1)·W/2 から始まる。
const D2R = Math.PI / 180, R2D = 180 / Math.PI, TWO_PI = 2 * Math.PI;
const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];

/** 扱える最大の order（face·4^k が 2^53 未満＝番号が整数で持てる） */
export const HPX_MAX_ORDER = 24;

/** 面と面内の座標（x, y ∈ [0,1)） */
export interface HpxXYF { face: number; x: number; y: number }
/** タイル（またはセル）の番地：面と面内の整数座標（0..2^order−1） */
export interface HpxCell { face: number; ix: number; iy: number }
/** タイルの番地 */
export interface HpxTile { order: number; npix: number }

// 13 bit を 1 つおきに広げる（→ 26 bit）。番号は 32 bit を超える＝下 13 bit と上の桁を別々に広げて掛け算で繋ぐ（ビット演算は 32 bit まで）
const spread13 = (v: number): number => {
	v = (v | (v << 8)) & 0x00ff00ff; v = (v | (v << 4)) & 0x0f0f0f0f; v = (v | (v << 2)) & 0x33333333; return (v | (v << 1)) & 0x55555555;
};
const squash26 = (v: number): number => {
	v &= 0x55555555; v = (v | (v >> 1)) & 0x33333333; v = (v | (v >> 2)) & 0x0f0f0f0f; v = (v | (v >> 4)) & 0x00ff00ff; return (v | (v >> 8)) & 0x1fff;
};
const P26 = 0x4000000;   // 2^26

/** (ix, iy) → 面内の NESTED 番号（ix が偶数位・iy が奇数位）。ix, iy < 2^24 */
export function interleave(ix: number, iy: number): number {
	const lo = spread13(ix & 0x1fff) | (spread13(iy & 0x1fff) << 1), hi = spread13(ix >>> 13) | (spread13(iy >>> 13) << 1);
	return hi * P26 + lo;
}
/** 面内の NESTED 番号 → [ix, iy] */
export function deinterleave(n: number, out: { [i: number]: number } = [0, 0]): { [i: number]: number } {
	const lo = n % P26, hi = Math.floor(n / P26);
	out[0] = squash26(lo) | (squash26(hi) << 13); out[1] = squash26(lo >>> 1) | (squash26(hi >>> 1) << 13);
	return out;
}

/** (z＝sin 緯度, φ＝東経 rad) → 面と面内の座標。healpix_base loc2pix の連続版 */
export function locToXYF(z: number, phi: number, out: HpxXYF = { face: 0, x: 0, y: 0 }): HpxXYF {
	const za = Math.abs(z);
	let tt = (phi * 2 / Math.PI) % 4; if (tt < 0) tt += 4; if (tt >= 4) tt = 0;
	if (za <= 2 / 3) {   // 赤道帯
		const jp = 0.5 + tt - 0.75 * z, jm = 0.5 + tt + 0.75 * z, ifp = Math.floor(jp), ifm = Math.floor(jm);
		out.face = ifp === ifm ? (ifp | 4) : ifp < ifm ? ifp : ifm + 8;
		out.x = jm - ifm; out.y = 1 - (jp - ifp);
	} else {   // 極の冠
		const ntt = Math.min(3, Math.floor(tt)), tp = tt - ntt, tmp = Math.sqrt(3 * (1 - za));
		const jp = tp * tmp, jm = (1 - tp) * tmp;
		if (z > 0) { out.face = ntt; out.x = 1 - jm; out.y = 1 - jp; } else { out.face = ntt + 8; out.x = jp; out.y = jm; }
	}
	// 面の縁ちょうど（丸めで 1 や負になる）を面の内側へ
	out.x = out.x < 0 ? 0 : out.x >= 1 ? 1 - 2 ** -53 : out.x; out.y = out.y < 0 ? 0 : out.y >= 1 ? 1 - 2 ** -53 : out.y;
	return out;
}
/** 面と面内の座標 → [z, φ]（φ ∈ [0, 2π)）。healpix_base xyf2loc */
export function xyfToLoc(face: number, x: number, y: number, out: { [i: number]: number } = [0, 0]): { [i: number]: number } {
	const jr = JRLL[face] - x - y;
	let nr: number, z: number;
	if (jr < 1) { nr = jr; z = 1 - nr * nr / 3; } else if (jr > 3) { nr = 4 - jr; z = nr * nr / 3 - 1; } else { nr = 1; z = (2 - jr) * 2 / 3; }
	let tmp = JPLL[face] * nr + x - y;
	if (tmp < 0) tmp += 8; if (tmp >= 8) tmp -= 8;
	out[0] = z; out[1] = nr < 1e-15 ? 0 : (Math.PI / 4) * tmp / nr;
	return out;
}

/** 経緯度（度） → 面と面内の座標 */
export function lonLatToXYF(lon: number, lat: number, out?: HpxXYF): HpxXYF {
	let phi = (lon * D2R) % TWO_PI; if (phi < 0) phi += TWO_PI;
	return locToXYF(Math.sin(Math.max(-90, Math.min(90, lat)) * D2R), phi, out);
}
/** 面と面内の座標 → [経度, 緯度]（度・経度 ∈ [−180, 180)） */
export function xyfToLonLat(face: number, x: number, y: number, out: { [i: number]: number } = [0, 0]): { [i: number]: number } {
	xyfToLoc(face, x, y, out);
	const z = out[0], lon = out[1] * R2D;
	out[0] = lon >= 180 ? lon - 360 : lon; out[1] = Math.asin(Math.max(-1, Math.min(1, z))) * R2D;
	return out;
}

/** 面と整数座標 → NESTED 番号 */
export const nestOf = (order: number, face: number, ix: number, iy: number): number => face * 4 ** order + interleave(ix, iy);
/** NESTED 番号 → 面と整数座標 */
export function cellOf(order: number, npix: number, out: HpxCell = { face: 0, ix: 0, iy: 0 }): HpxCell {
	const per = 4 ** order, face = Math.floor(npix / per), xy = deinterleave(npix - face * per);
	out.face = face; out.ix = xy[0]; out.iy = xy[1];
	return out;
}
/** 経緯度（度） → その点を含む order のタイル（セル）の NESTED 番号。healpy.ang2pix(nest=True, lonlat=True) と同じ */
export function lonLatToNest(lon: number, lat: number, order: number): number {
	const f = lonLatToXYF(lon, lat), n = 2 ** order;
	return nestOf(order, f.face, Math.min(n - 1, Math.floor(f.x * n)), Math.min(n - 1, Math.floor(f.y * n)));
}
/** タイル（セル）の中心 → [経度, 緯度]（度） */
export function nestToLonLat(order: number, npix: number, out?: { [i: number]: number }): { [i: number]: number } {
	const c = cellOf(order, npix), n = 2 ** order;
	return xyfToLonLat(c.face, (c.ix + 0.5) / n, (c.iy + 0.5) / n, out);
}
/** order のタイル（セル）の総数＝12·4^order */
export const hpxCount = (order: number): number => 12 * 4 ** order;
/** 親（order−1）の番号 */
export const hpxParent = (npix: number): number => Math.floor(npix / 4);
/** 子（order+1）の番号 4 つ（子 i は列 (i&1)・行 (i>>1) の象限） */
export const hpxChildren = (npix: number): [number, number, number, number] => [npix * 4, npix * 4 + 1, npix * 4 + 2, npix * 4 + 3];

/** タイルの隅の経緯度＝[南, 東, 北, 西] の順に [lon, lat]（反時計回り＝東経が右の地図で）。極を隅に持つタイルの極は経度 0 */
export function hpxCorners(order: number, npix: number): [number, number][] {
	const c = cellOf(order, npix), n = 2 ** order, x0 = c.ix / n, y0 = c.iy / n, d = 1 / n;
	return [[x0, y0], [x0 + d, y0], [x0 + d, y0 + d], [x0, y0 + d]].map(([x, y]) => { const ll = xyfToLonLat(c.face, x, y); return [ll[0], ll[1]] as [number, number]; });
}
/** タイルの縁を 1 辺 step 分割でなぞる（南 → 東 → 北 → 西 → 南の手前まで・4·step 点）。縁は大円でも緯線でもない曲線＝被覆の判定とメッシュ用 */
export function hpxBoundary(order: number, npix: number, step = 1): [number, number][] {
	const c = cellOf(order, npix), n = 2 ** order, x0 = c.ix / n, y0 = c.iy / n, d = 1 / n, out: [number, number][] = [];
	const put = (x: number, y: number): void => { const ll = xyfToLonLat(c.face, x, y); out.push([ll[0], ll[1]]); };
	for (let i = 0; i < step; i++) put(x0 + d * i / step, y0);
	for (let i = 0; i < step; i++) put(x0 + d, y0 + d * i / step);
	for (let i = 0; i < step; i++) put(x0 + d - d * i / step, y0 + d);
	for (let i = 0; i < step; i++) put(x0, y0 + d - d * i / step);
	return out;
}

// 面をまたぐ隣（healpix_base neighbors の表）。行＝ずれの向き（3·(y のずれ+1) + (x のずれ+1)）・列＝面
const NB_FACE = [
	[8, 9, 10, 11, -1, -1, -1, -1, 10, 11, 8, 9],     // 南
	[5, 6, 7, 4, 8, 9, 10, 11, 9, 10, 11, 8],         // 南東
	[-1, -1, -1, -1, 5, 6, 7, 4, -1, -1, -1, -1],     // 東
	[4, 5, 6, 7, 11, 8, 9, 10, 11, 8, 9, 10],         // 南西
	[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],           // 同じ面
	[1, 2, 3, 0, 0, 1, 2, 3, 5, 6, 7, 4],             // 北東
	[-1, -1, -1, -1, 7, 4, 5, 6, -1, -1, -1, -1],     // 西
	[3, 0, 1, 2, 3, 0, 1, 2, 4, 5, 6, 7],             // 北西
	[2, 3, 0, 1, -1, -1, -1, -1, 0, 1, 2, 3],         // 北
];
const NB_SWAP = [[0, 0, 3], [0, 0, 6], [0, 0, 0], [0, 0, 5], [0, 0, 0], [5, 0, 0], [0, 0, 0], [6, 0, 0], [3, 0, 0]];
/** 面の外へ 1 面ぶんまではみ出た整数座標（−n ≤ ix, iy < 2n・n＝2^order）を、隣の面の座標へ畳む。隣が無い（冠の面の東西の角の先・赤道の面の南北の角の先＝そこは 3 面しか集まらない）＝null。
 *  タイルの縁取り（隣のタイルの 1 画素を借りる）と neighbors の共通の部品 */
export function hpxWrap(order: number, face: number, ix: number, iy: number, out: HpxCell = { face: 0, ix: 0, iy: 0 }): HpxCell | null {
	const n = 2 ** order;
	let nb = 4;
	if (ix < 0) { ix += n; nb -= 1; } else if (ix >= n) { ix -= n; nb += 1; }
	if (iy < 0) { iy += n; nb -= 3; } else if (iy >= n) { iy -= n; nb += 3; }
	const f = NB_FACE[nb][face];
	if (f < 0) return null;
	const bits = NB_SWAP[nb][face >> 2];
	if (bits & 1) ix = n - ix - 1;
	if (bits & 2) iy = n - iy - 1;
	if (bits & 4) { const t = ix; ix = iy; iy = t; }
	out.face = f; out.ix = ix; out.iy = iy;
	return out;
}
const NB_DX = [-1, -1, 0, 1, 1, 1, 0, -1], NB_DY = [0, 1, 1, 1, 0, -1, -1, -1];
/** 8 近傍の番号＝[南西, 西, 北西, 北, 北東, 東, 南東, 南]（healpy.get_all_neighbours(nest=True) と同じ順）。隣が無い向きは −1 */
export function hpxNeighbors(order: number, npix: number): number[] {
	const c = cellOf(order, npix), w: HpxCell = { face: 0, ix: 0, iy: 0 }, out: number[] = [];
	for (let i = 0; i < 8; i++) out.push(hpxWrap(order, c.face, c.ix + NB_DX[i], c.iy + NB_DY[i], w) ? nestOf(order, w.face, w.ix, w.iy) : -1);
	return out;
}

/** タイルの番号鍵＝HEALPix の UNIQ（4·4^order + npix）。order を跨いで一意＝ Set/Map の鍵（メルカトルの tileId に当たる） */
export const hpxId = (order: number, npix: number): number => 4 * 4 ** order + npix;
/** UNIQ → タイルの番地 */
export function hpxOfId(id: number): HpxTile {
	let order = 0, base = 4;
	while (base * 4 <= id) { base *= 4; order++; }
	return { order, npix: id - base };
}
/** HiPS の置き場の相対パス＝Norder{k}/Dir{⌊npix/10000⌋·10000}/Npix{npix}.{ext} */
export const hpxPath = (order: number, npix: number, ext: string): string => `Norder${order}/Dir${Math.floor(npix / 10000) * 10000}/Npix${npix}.${ext}`;

/** タイル（幅 W）の画素 (col, row) の中心 → [経度, 緯度]（度）。ss 倍の副標本なら col, row に小数を渡す */
export function hpxPixelLonLat(order: number, cell: HpxCell, W: number, col: number, row: number, out?: { [i: number]: number }): { [i: number]: number } {
	const n = 2 ** order;
	return xyfToLonLat(cell.face, (cell.ix + (col + 0.5) / W) / n, (cell.iy + (row + 0.5) / W) / n, out);
}
