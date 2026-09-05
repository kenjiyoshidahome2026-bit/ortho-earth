// MapLibre GL JS integration — COG を raster タイルとして供給する addProtocol ハンドラ。
// maplibre-gl はここでは import しない（maplibre.js と同じ流儀＝登録は利用者側の責務）:
//
//   import maplibregl from "maplibre-gl";
//   import { cogProtocol } from "geopbf/maplibre-cog";
//   maplibregl.addProtocol("cog", cogProtocol);
//   map.addSource("x", { type: "raster", tiles: ["cog://https://host/path.tif/{z}/{x}/{y}"],
//                        tileSize: 256, minzoom: 0, maxzoom: 22 });
//
// URL ごとに openCog を memoize（ヘッダ一発読みは最初の1タイルだけ）。タイルは worker pool で
// デコード＋3857 warp され PNG bytes で返る。ソースの bounds は onOpen(bboxLL) で貰って
// map.getSource().bounds に足すと圏外リクエストが消える。
import { openCog } from "./cog/index.js";

// options: { fetch, cache, stretch, onOpen(url, cog), ...openCog opts }
export function makeCogProtocol(options = {}) {
	const cogs = new Map();   // innerUrl → Promise<Cog>
	return async (params, abortController) => {
		const m = /^cog:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url);
		if (!m) throw new Error(`cog protocol: bad url ${params.url}`);
		const [, innerUrl, z, x, y] = m;
		let p = cogs.get(innerUrl);
		if (!p) { p = openCog(innerUrl, options).then(c => (options.onOpen?.(innerUrl, c), c)); cogs.set(innerUrl, p); }
		const cog = await p;
		const png = await cog.renderXYZ(+z, +x, +y, { format: "png", signal: abortController?.signal });
		if (!png) return { data: EMPTY_PNG.slice() };   // 圏外＝透明1px
		return { data: png };
	};
}

export const cogProtocol = makeCogProtocol();

// 透明 1×1 PNG（圏外タイル用・67 bytes）
const EMPTY_PNG = Uint8Array.from(atob(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
), c => c.charCodeAt(0));
