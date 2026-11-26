// 標高の HEALPix タイルを焼く（2026-11-26・規約＝docs/design/healpix.md）。
// 大元は altpbf の経緯度タイル（R90＝90° 2700²・R10＝10° 2400²＝本人裁定「大元は R90〜R10 をベースに」）。そこから HEALPix の最も細かい order を
// バイリニアで標本化し、粗い order は子 4 枚の 2×2 平均で作る（HiPS と同じ積み上げ）＝ order をまたいで同じ値の系列になる。
// 純関数＝Node の検定（tests/healpix-bake.mjs）。読み込み（bucket・ファイル）と書き出しは呼び手（scripts/bake-healpix-elev.mjs）。
// 値は大元のまま通す（海底の負値も・0 へ寄せない）＝丸めて捨てるのは消費側。大元に無いセルは 0。
import { cellOf, xyfToLonLat } from "../healpix.ts";
import type { ElevGrid } from "../elevation.ts";

/** 大元のタイルを引く口：(cx, cy)＝西から・南からのセル番号（R90＝4×2・R10＝36×18）。無い＝null（0 m として扱う） */
export type CellGetter = (cx: number, cy: number) => ElevGrid | null | undefined;
/** タイルの標本点（幅 W·ss の格子・行優先・度） */
export interface HpxPoints { lon: Float64Array; lat: Float64Array; n: number }

/** タイル（order・npix・幅 W）の標本点の経緯度。ss＞1＝画素を ss×ss に割った副標本（縮小になる時の折り返し除け） */
export function hpxTilePoints(order: number, npix: number, W: number, ss = 1): HpxPoints {
	const c = cellOf(order, npix), n = W * ss, k = 2 ** order, lon = new Float64Array(n * n), lat = new Float64Array(n * n), ll = [0, 0];
	for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) {
		xyfToLonLat(c.face, (c.ix + (q + 0.5) / n) / k, (c.iy + (r + 0.5) / n) / k, ll);
		lon[r * n + q] = ll[0]; lat[r * n + q] = ll[1];
	}
	return { lon, lat, n };
}

// 経緯度 → 全球の画素格子（range° のセルが w×h 画素）の小数座標。画素中心の規約＝ortho-core elevation.ts と同じ（gx = u·w − 0.5）・gy は南から
const gridX = (lon: number, range: number, w: number): number => (lon + 180) / range * w - 0.5;
const gridY = (lat: number, range: number, h: number): number => (lat + 90) / range * h - 0.5;

/** 緯度帯ごとのセルの幅（cy＝南からのセル番号 → 画素数）。高緯度で経度方向を間引いた大元（GEBCO の R10＝極の帯は 400×2400）のための口。
 *  間引いたセルの画素 i は、間引く前の格子（幅 w）の画素 i·(w/幅) の位置の値（uploader の create10 の標本の取り方＝左寄せ） */
export type WidthOf = (cy: number) => number;
/** GEBCO から作った R10（apps/uploader/src/terrain/gebco.ts の shrink）の幅：南端の緯度が ±80° 以遠＝400・±70°＝800・±60°＝1200・±50°＝1600・他＝2400 */
export const gebcoR10Width: WidthOf = cy => { const a = Math.min(cy, 17 - cy); return a === 0 ? 400 : a === 1 ? 800 : a === 2 ? 1200 : a === 3 ? 1600 : 2400; };

// 標本点 1 つのバイリニアが読む 2 行 × 2 列を回す共通の部品。行ごとに帯の幅が違い得る＝横の補間は行ごとに別の刻みで行う
function forTaps(lon: number, lat: number, range: number, w: number, h: number, wOf: WidthOf | null, tap: (cx: number, cy: number, lx: number, ly: number, wc: number, row: number, fx: number, right: number) => void): number {
	const GH = 180 / range * h, NX = 360 / range, gx = gridX(lon, range, w), gy = Math.min(GH - 1, Math.max(0, gridY(lat, range, h)));
	const y0 = Math.min(GH - 2, Math.floor(gy));
	for (let row = 0; row < 2; row++) {
		const Y = y0 + row, cy = Math.floor(Y / h), wc = wOf ? wOf(cy) : w, GWc = NX * wc, t = gx * wc / w, tf = Math.floor(t), fx = t - tf;
		const x0 = ((tf % GWc) + GWc) % GWc, x1 = (x0 + 1) % GWc;
		tap(Math.floor(x0 / wc), cy, x0 % wc, Y - cy * h, wc, row, fx, 0);
		tap(Math.floor(x1 / wc), cy, x1 % wc, Y - cy * h, wc, row, fx, 1);
	}
	return gy - y0;
}

/** 標本点のバイリニアが触る大元のセル（"cx,cy"）＝呼び手が先に読み込んでおく分。range＝セルの幅（度）・w, h＝セルの画素数（間引く前） */
export function cellsForPoints(pts: HpxPoints, range: number, w: number, h = w, wOf: WidthOf | null = null): Set<string> {
	const out = new Set<string>();
	let lastCx = -1, lastCy = -1;
	for (let i = 0; i < pts.lon.length; i++) forTaps(pts.lon[i], pts.lat[i], range, w, h, wOf, (cx, cy) => { if (cx !== lastCx || cy !== lastCy) { out.add(cx + "," + cy); lastCx = cx; lastCy = cy; } });
	return out;
}

/** 標本点を大元の格子からバイリニアで引く（m・Float64）。経度は 180° で巻き、緯度は極でクランプ＝セルの境と 180° 線をまたいでも継ぎ目が出ない */
export function sampleCells(pts: HpxPoints, get: CellGetter, range: number, w: number, h = w, wOf: WidthOf | null = null): Float64Array {
	const out = new Float64Array(pts.lon.length), v = [0, 0, 0, 0];
	let lastKey = -1, last: ElevGrid | null | undefined = null;
	const tap = (cx: number, cy: number, lx: number, ly: number, wc: number, row: number, _fx: number, right: number): void => {
		const key = cy * 4096 + cx;
		if (key !== lastKey) { lastKey = key; last = get(cx, cy); }
		if (!last) { v[row * 2 + right] = 0; return; }
		if (last.width !== wc || last.height !== h) throw new Error(`sampleCells: cell ${cx},${cy} is ${last.width}x${last.height}, expected ${wc}x${h}`);
		v[row * 2 + right] = last.data[(h - 1 - ly) * wc + lx];   // 格納は北上げ（altpbf）
	};
	let fx0 = 0, fx1 = 0;
	const tapFx = (cx: number, cy: number, lx: number, ly: number, wc: number, row: number, fx: number, right: number): void => { if (row) fx1 = fx; else fx0 = fx; tap(cx, cy, lx, ly, wc, row, fx, right); };
	for (let i = 0; i < out.length; i++) {
		const fy = forTaps(pts.lon[i], pts.lat[i], range, w, h, wOf, tapFx);
		const bot = v[0] + (v[1] - v[0]) * fx0, top = v[2] + (v[3] - v[2]) * fx1;
		out[i] = bot + (top - bot) * fy;
	}
	return out;
}

/** 最も細かい order のタイル 1 枚＝W×W の Int16（行優先・列＝ix の向き・行＝iy の向き）。ss＞1 は副標本の箱平均 */
export function bakeHpxTile(get: CellGetter, range: number, w: number, order: number, npix: number, W: number, ss = 1, h = w, wOf: WidthOf | null = null): Int16Array {
	const v = sampleCells(hpxTilePoints(order, npix, W, ss), get, range, w, h, wOf), out = new Int16Array(W * W), n = W * ss, inv = 1 / (ss * ss);
	for (let r = 0; r < W; r++) for (let q = 0; q < W; q++) {
		let s = 0;
		for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) s += v[(r * ss + j) * n + q * ss + i];
		out[r * W + q] = Math.round(s * inv);
	}
	return out;
}

/** 親のタイル＝子 4 枚（NESTED の順＝4·npix + i）の 2×2 平均。子 i は列 (i&1)·W/2・行 (i>>1)·W/2 の象限 */
export function hpxParentTile(children: readonly ArrayLike<number>[], W: number): Int16Array {
	if (children.length !== 4 || W % 2) throw new Error("hpxParentTile: 4 children and an even width");
	const out = new Int16Array(W * W), hw = W / 2;
	for (let i = 0; i < 4; i++) {
		const c = children[i], ox = (i & 1) * hw, oy = (i >> 1) * hw;
		if (c.length !== W * W) throw new Error(`hpxParentTile: child ${i} is not ${W}x${W}`);
		for (let r = 0; r < hw; r++) for (let q = 0; q < hw; q++) {
			const s = 2 * r * W + 2 * q;
			out[(oy + r) * W + ox + q] = Math.round((c[s] + c[s + 1] + c[s + W] + c[s + W + 1]) / 4);
		}
	}
	return out;
}

/** altpbf に載せる時の名前＝H{order 2 桁}P{npix}（例 H05P12287）。経緯度のタイル名（R01N035E139）と頭の字で分かれる */
export const hpxElevName = (order: number, npix: number): string => `H${String(order).padStart(2, "0")}P${npix}`;
/** 名前 → 番地（HEALPix の名前でなければ null） */
export function parseHpxElevName(name: string): { order: number; npix: number } | null {
	const m = /^H(\d{2})P(\d+)$/.exec(name);
	return m ? { order: +m[1], npix: +m[2] } : null;
}
