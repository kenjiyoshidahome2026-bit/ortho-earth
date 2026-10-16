// Leaflet integration — COG を L.GridLayer として表示する。leaflet はここでは import しない
// （leaflet.js と同じ流儀＝L は引数で受ける）:
//
//   import { cogGridLayer } from "geopbf/leaflet-cog";
//   const layer = await cogGridLayer(L, "https://host/path.tif", { opacity: 0.8 });
//   layer.addTo(map);  map.fitBounds(layer.options.bounds);
//
// openCog はレイヤ生成時に1回（ヘッダ一発読み）。createTile は renderXYZ の ImageBitmap を
// canvas へ描く。bounds は bboxLL から自動設定＝圏外タイルは Leaflet 側が要求しない。
import { openCog } from "./cog/index.ts";
import type { BrowserCog, BrowserCogOptions } from "./cog/index.ts";

// leaflet の型に依らない最小形（L は引数で受ける＝ここで使う口だけ）
interface GridLayerThis { getTileSize(): { x: number; y: number } }
type TileDone = (err: unknown, tile: HTMLCanvasElement) => void;
export interface LeafletLike {
	GridLayer: {
		extend(props: { createTile(this: GridLayerThis, coords: { x: number; y: number; z: number }, done: TileDone): HTMLCanvasElement; onRemove(this: unknown, map: unknown): void }): new (options: Record<string, unknown>) => object;
		prototype: { onRemove(map: unknown): unknown };
	};
	latLngBounds(southWest: [number, number], northEast: [number, number]): unknown;
}
/** cogGridLayer の戻り＝L.GridLayer（cog＝metrics()/close() への窓） */
export type CogGridLayer = object & { cog: BrowserCog };

export async function cogGridLayer(L: LeafletLike, url: string, options: BrowserCogOptions & Record<string, unknown> = {}): Promise<CogGridLayer> {
	const cog = await openCog(url, options);
	const [w, s, e, n] = cog.bboxLL;
	const Layer = L.GridLayer.extend({
		createTile(coords, done) {
			const size = this.getTileSize();
			const tile = document.createElement("canvas");
			tile.width = size.x; tile.height = size.y;
			cog.renderXYZ(coords.z, coords.x, coords.y, { size: size.x })
				.then(bm => { if (bm) { tile.getContext("2d")!.drawImage(bm as ImageBitmap, 0, 0); (bm as ImageBitmap).close(); } done(null, tile); })   // 既定の format＝ImageBitmap
				.catch(err => done(err, tile));
			return tile;
		},
		onRemove(map) { L.GridLayer.prototype.onRemove.call(this, map); },
	});
	const layer = new Layer({ bounds: L.latLngBounds([s, w], [n, e]), attribution: cog.citation || undefined, ...options });
	(layer as CogGridLayer).cog = cog;   // metrics()/close() への窓
	return layer as CogGridLayer;
}
