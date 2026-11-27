// タイルの格子＝「番地の計算」を 1 つの口に寄せる（docs/design/healpix.md §6・2026-11-27）。
// 組み立て（build・labels・buildings）とタイル選び（tilecover・tilemanager）がメルカトルの式を直に書いている所を、この口越しに替えるための物。
// 実装は 2 つ：mercatorGrid＝tile.ts と同じ式（値が 1 ビットも変わらない事を検定で縛る）・healpixGrid＝healpix.ts／healpixvt.ts の関数を並べたもの。
// ⚠ まだどこにも配線していない（段取りの 1 段目＝足すだけ）。
import { lonLatToTile, tileBoundsInto, type TileXYZ } from "./tile.ts";
import type { DecodedTile } from "./tileformat.ts";
import { cellOf, lonLatToNest, nestToLonLat, hpxBoundary, hpxChildren, hpxParent, xyfToLonLat, type HpxTile } from "./healpix.ts";

/** タイルの中の点 (px, py ∈ 0..extent) → 経緯度（原点からの差）を out[oi], out[oi+1] へ書く */
export type ToLonLat = (px: number, py: number, out: { [i: number]: number }, oi: number) => void;

export interface TileGrid<T> {
	readonly name: "mercator" | "healpix";
	/** キャッシュの鍵（格子が違えば重ならない） */
	key(t: T): string;
	/** 四分木の段（メルカトル z／HEALPix Norder） */
	level(t: T): number;
	/** style を評価する zoom */
	styleZoom(t: T): number;
	/** 頂点の差の基準 [lon, lat]（タイルの中か縁の 1 点） */
	origin(t: T): [number, number];
	/** タイルの中の点 → 経緯度の写し手（タイルごとに 1 回作る）。ox, oy＝引く原点（既定 0＝経緯度そのもの）。経度の差は ±180 に畳む */
	toLonLat(t: T, extent: number, ox?: number, oy?: number): ToLonLat;
	/** [w, s, e, n]（度）。日付変更線をまたぐタイルは e > 180 で返す（w ≤ e） */
	bounds(t: T): number[];
	center(t: T): [number, number];
	/** その点を含む段 level のタイル */
	at(lon: number, lat: number, level: number): T;
	children(t: T): T[];
	parent(t: T): T;
	/** t が b の子孫か（同じタイルは false） */
	under(t: T, b: T): boolean;
}

const R2D = 180 / Math.PI, HALF_PI = Math.PI / 2;
const wrap180 = (d: number): number => d > 180 ? d - 360 : d < -180 ? d + 360 : d;

/** Web メルカトル（今の経路と同じ式） */
export const mercatorGrid: TileGrid<TileXYZ> = {
	name: "mercator",
	key: t => `${t.z}/${t.x}/${t.y}`,
	level: t => t.z,
	styleZoom: t => t.z,
	origin: t => { const b = tileBoundsInto(t.x, t.y, t.z, [0, 0, 0, 0]); return [b[0], b[3]]; },   // 北西の隅（tilepayload と同じ）
	toLonLat({ z, x, y }, extent, ox = 0, oy = 0) {
		const n = 1 << z;
		return (px, py, out, oi) => {   // build.ts の llInto／tile.ts の tileLocalToLonLat と同じ式（経度は畳まない＝今の振る舞いのまま）
			out[oi] = (x + px / extent) / n * 360 - 180 - ox;
			out[oi + 1] = R2D * (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * ((y + py / extent) / n)))) - HALF_PI) - oy;
		};
	},
	bounds: t => tileBoundsInto(t.x, t.y, t.z, [0, 0, 0, 0]),
	center: ({ z, x, y }) => { const n = 1 << z; return [(x + 0.5) / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * R2D]; },   // tilemanager の distOf と同じ（メルカトルの上での中心）
	at(lon, lat, level) { const n = 1 << level, [x0, y0] = lonLatToTile(lon, lat, level); return { z: level, x: ((x0 % n) + n) % n, y: Math.max(0, Math.min(n - 1, y0)) }; },
	children: ({ z, x, y }) => [{ z: z + 1, x: 2 * x, y: 2 * y }, { z: z + 1, x: 2 * x + 1, y: 2 * y }, { z: z + 1, x: 2 * x, y: 2 * y + 1 }, { z: z + 1, x: 2 * x + 1, y: 2 * y + 1 }],
	parent: ({ z, x, y }) => ({ z: z - 1, x: x >> 1, y: y >> 1 }),
	under: (t, b) => t.z > b.z && (t.x >> (t.z - b.z)) === b.x && (t.y >> (t.z - b.z)) === b.y,
};

/** 段 k の 1 枚の辺は赤道でメルカトル z = k + log2(40075 / 6522) ≒ k + 2.62 と同じ長さ＝zoom k + 3 として style を評価する（案・§6「決める事」） */
export const HPX_STYLE_ZOOM_OFFSET = 3;

/** HEALPix（NESTED・タイルの中は面の (x, y)・y は上向き） */
export const healpixGrid: TileGrid<HpxTile> = {
	name: "healpix",
	key: t => `h${t.order}/${t.npix}`,
	level: t => t.order,
	styleZoom: t => t.order + HPX_STYLE_ZOOM_OFFSET,
	origin: t => { const ll = nestToLonLat(t.order, t.npix); return [ll[0], ll[1]]; },   // 中心（タイルは菱形＝隅より中心が差を小さく保つ）
	toLonLat({ order, npix }, extent, ox = 0, oy = 0) {
		const c = cellOf(order, npix), face = c.face, ix = c.ix, iy = c.iy, n = 2 ** order, tmp = [0, 0];
		return (px, py, out, oi) => {   // hpxTilePointLonLat と同じ計算（cellOf をタイルごとに 1 回にしただけ）
			xyfToLonLat(face, Math.min(1, (ix + px / extent) / n), Math.min(1, (iy + py / extent) / n), tmp);
			out[oi] = ox === 0 && oy === 0 ? tmp[0] : wrap180(tmp[0] - ox); out[oi + 1] = tmp[1] - oy;
		};
	},
	bounds(t) {
		const cl = nestToLonLat(t.order, t.npix)[0]; let w = Infinity, e = -Infinity, s = 90, n = -90, pole = false;
		for (const [lon, lat] of hpxBoundary(t.order, t.npix, 8)) {
			if (lat < s) s = lat; if (lat > n) n = lat;
			if (Math.abs(lat) > 90 - 1e-9) { pole = true; continue; }   // 極の点の経度は意味が無い
			const d = wrap180(lon - cl); if (d < w) w = d; if (d > e) e = d;
		}
		if (pole && t.order === 0) return [-180, s, 180, n];
		const W = cl + w; return W < -180 ? [W + 360, s, cl + e + 360, n] : [W, s, cl + e, n];
	},
	center: t => { const ll = nestToLonLat(t.order, t.npix); return [ll[0], ll[1]]; },
	at: (lon, lat, level) => ({ order: level, npix: lonLatToNest(lon, lat, level) }),
	children: t => hpxChildren(t.npix).map(npix => ({ order: t.order + 1, npix })),
	parent: t => ({ order: t.order - 1, npix: hpxParent(t.npix) }),
	under: (t, b) => t.order > b.order && Math.floor(t.npix / 4 ** (t.order - b.order)) === b.npix,
};

// ── 組み立て（build・labels・buildings）へ渡す形 ──────────────────────────────────────────────
/** メルカトルでないタイルの「番地の計算」＝組み立てが要る分だけ（省けばメルカトル＝今のまま）。座標は MVT の枠（x 右・y 下）で受ける */
export interface TileProj {
	/** キャッシュ・注記の群の鍵に使う名前（タイルごとに違う） */
	key: string;
	/** タイルの中の点 (px, py ∈ 0..extent・y は下向き) → 経緯度（原点 ox, oy からの差）の写し手 */
	toLonLat(extent: number, ox: number, oy: number): ToLonLat;
	/** タイルの辺の長さ（m） */
	sideM: number;
	/** 同じ辺の長さになるメルカトルの z（赤道・小数）＝タイル単位 → 画素の物差し（破線など） */
	zEq: number;
}
const HPX_SIDE0_M = 6371008.8 * Math.sqrt(Math.PI / 3);   // 面 1 枚（全球の 1/12）と同じ面積の正方形の辺
const HPX_ZEQ0 = Math.log2(40075016.686 / HPX_SIDE0_M);   // ≒ 2.62

/** HEALPix のタイルを組み立てへ渡す TileProj。組み立ては MVT の枠（y 下向き）で動く＝hpxToTileFrame で枠を合わせたタイルと組で使う */
export function hpxTileProj(t: HpxTile): TileProj {
	return {
		key: healpixGrid.key(t), sideM: HPX_SIDE0_M / 2 ** t.order, zEq: t.order + HPX_ZEQ0,
		toLonLat(extent, ox, oy) { const f = healpixGrid.toLonLat(t, extent, ox, oy); return (px, py, out, oi) => f(px, extent - py, out, oi); },
	};
}
/** 焼いた HEALPix のタイル（y 上向き・外周は反時計回り）を MVT の枠（y 下向き）へ合わせる＝y を裏返し、多角形の輪は点の順も逆にする。
 *  こうすると (1) 輪の符号（外周が正）が MVT と同じまま (2) タイル → 経緯度が「向きを裏返す」写像になる＝メルカトルと同じ＝三角形の巻き・建物の壁の表裏が今の経路と揃う。
 *  その場で書き換える（解読した直後に 1 回だけ）。線と点は y だけ（線の向きは変えない） */
export function hpxToTileFrame<T extends DecodedTile>(tile: T): T {
	for (const name in tile) {
		const L = tile[name], E = L.extent;
		for (const f of L.features) {
			const g = f.geom; if (!g) continue;
			const c = g.coords;
			for (let i = 1; i < c.length; i += 2) c[i] = E - c[i];
			if (f.type !== "Polygon") continue;
			let s = 0;
			for (const e of g.ends) {   // 輪ごとに点の順を逆に（閉じた輪＝最初と最後が同じ点でも、そのまま逆でよい）
				for (let a = s, b = e - 2; a < b; a += 2, b -= 2) { const x = c[a], y = c[a + 1]; c[a] = c[b]; c[a + 1] = c[b + 1]; c[b] = x; c[b + 1] = y; }
				s = e;
			}
		}
	}
	return tile;
}
