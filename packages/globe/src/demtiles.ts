// raster-dem のタイルの在庫（#114 段 3・2026-09-29）＝同じ source を読む hillshade と color-relief が 1 つを共有する（層ごとに取らない・HTTP キャッシュ頼みにしない）。
// tile(z,x,y) → Promise<{ h: Float32Array（標高 m・行は北から）, n }|null>。直近 cap 枚を持つ（同時に来た要求は同じ Promise を返す＝取得は 1 回）。
import { decodeDEM, normalizeDemSpec } from "@ortho-earth/core";
import type { DemSpec, DemSpecInput } from "@ortho-earth/core";

/** DEM の 1 タイル（標高 m・行は北から・n×n） */
export interface DemTile { h: Float32Array; n: number }
/** 取得の答え（fetch の Response か、独自の読み口が画像で返した物＝bitmap()） */
export type DemResponse = Pick<Response, "ok"> & { bitmap?: () => Promise<ImageBitmap>; blob(): Promise<Blob> };
export type DemFetch = (url: string, init: RequestInit) => Promise<DemResponse>;
/** DEM の在庫（createDemTiles の戻り） */
export interface DemTiles { spec: DemSpec; tile(z: number, x: number, y: number): Promise<DemTile | null>; size(): number }

export function createDemTiles(dem: DemSpecInput | null | undefined, { fetchFn = (u, init) => fetch(u, init), cap = 128 }: { fetchFn?: DemFetch; cap?: number } = {}): DemTiles {
	const spec = normalizeDemSpec(dem);
	const tpls = spec.tiles.map(u => u.replace(/%7B/gi, "{").replace(/%7D/gi, "}"));   // new URL(...).href で括弧が %7B に化けた型紙も読む
	const url = (z: number, x: number, y: number) => tpls[(x + y) % tpls.length].replace("{z}", z as unknown as string).replace("{x}", x as unknown as string).replace("{y}", y as unknown as string);
	const tiles = new Map<string, Promise<DemTile | null>>();
	let dctx: OffscreenCanvasRenderingContext2D | null = null;
	const tile = (z: number, x: number, y: number): Promise<DemTile | null> => {
		const m = 1 << z; x = ((x % m) + m) % m;
		if (y < 0 || y >= m) return Promise.resolve(null);
		const k = `${z}/${x}/${y}`;
		if (tiles.has(k)) { const v = tiles.get(k)!; tiles.delete(k); tiles.set(k, v); return v; }
		const pr = (async () => {
			const r = await fetchFn(url(z, x, y), { credentials: spec.credentials, ...(spec.headers ? { headers: spec.headers } : {}) });
			if (!r.ok) return null;
			const bmp = r.bitmap ? await r.bitmap() : await createImageBitmap(await r.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });   // bitmap＝独自の読み口が画像で返した物（globe の demFetch）
			const n = bmp.width;
			dctx ??= new OffscreenCanvas(n, n).getContext("2d", { willReadFrequently: true })!;
			if (dctx.canvas.width !== n) { dctx.canvas.width = n; dctx.canvas.height = n; }
			dctx.clearRect(0, 0, n, n); dctx.drawImage(bmp, 0, 0); bmp.close?.();
			return { h: decodeDEM(dctx.getImageData(0, 0, n, n).data, spec.encoding, spec), n };
		})().catch(() => null);
		tiles.set(k, pr);
		if (tiles.size > cap) tiles.delete(tiles.keys().next().value!);
		return pr;
	};
	return { spec, tile, size: () => tiles.size };
}
