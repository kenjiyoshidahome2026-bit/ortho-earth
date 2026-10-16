// MapLibre GL JS integration — データ供給のみ（gint描画エンジンのmaplibre互換ではない）
// maplibre-gl はここでは import しない。addProtocol への登録は利用者側の責務で、
// 本モジュールはハンドラ関数（MapLibre v4+ の AddProtocolAction 形）だけを提供する:
//
//   import maplibregl from "maplibre-gl";
//   import { geopbfProtocol } from "geopbf/maplibre";
//   maplibregl.addProtocol("geopbf", geopbfProtocol);
//   map.addSource("x", { type: "geojson", data: "geopbf://https://host/path.geopbf" });                      // ① GeoJSON ソース（丸ごと）
//   map.addSource("y", { type: "vector", tiles: ["geopbf://https://host/path.geopbf/{z}/{x}/{y}"], maxzoom: 14 });   // ② ベクタタイル（2026-10-12・改良点 ⑥）
//
// ① は geopbf 1 ファイルを geojson ソースに流し、タイル化・簡略化は MapLibre 内蔵の geojson-vt に任せる（feature-state は promoteId）。
// ② は geopbf の Gint（共有境界の arc＋VW rank）から要求された z/x/y だけを MVT に組む（convert/tilesource.js＝toPMTiles と同じ本体）。
//    geojson-vt を通らない＝隣接ポリゴンの境界が全ズームで継ぎ目無し・feature.id＝fid（promoteId 無しで feature-state が効く）・
//    大きい GeoPBF でも最初の一枚が早い。source-layer はファイルのヘッダ name（options.tiler.layer で上書き）。
//    1 つのハンドラで両方を捌く＝URL の末尾が /z/x/y（.pbf/.mvt 可）で、MapLibre が arrayBuffer を求める要求がタイル。
// fetch/gzip透過/デコード/サニタイズの実体は modules/geojson-load.js（leaflet 統合と共用）。
import { resolveInnerUrl, fetchAndDecode, sanitizeProperties, loadGeopbf } from "./modules/geojson-load.js";
import { fetchGeopbfTiles } from "./modules/tile-load.js";
import { createTileSource } from "./convert/tilesource.ts";

export { sanitizeProperties, loadGeopbf, createTileSource };

// "geopbf://https://host/a.geopbf/3/7/3" → { inner: "https://host/a.geopbf", z, x, y }。タイル形でなければ null
export function parseTileUrl(url) {
	const m = /^(.*?)\/(\d{1,2})\/(\d{1,10})\/(\d{1,10})(?:\.(?:pbf|mvt))?(?:\?.*)?$/.exec(url);
	return m ? { inner: m[1], z: +m[2], x: +m[3], y: +m[4] } : null;
}

// options: { fetch(url,{signal})→Response, tiler（createTileSource の options・既定 {}）, tilerOf(innerUrl)→options（URL ごと）,
//            bake(pbf)→Promise（Gint を焼く手・既定 pbf.gint()）, onSource(innerUrl, src) }
// 1 内側 URL に 1 つの tile source（最初の要求で取得・焼き・準備、以後はキャッシュ）。sources.delete(innerUrl) / dispose(innerUrl) で手放す
export function makeGeopbfTileProtocol(options = {}) {
	const sources = new Map();   // innerUrl → Promise<tileSource>
	const sourceOf = (inner, signal) => {
		let p = sources.get(inner);
		if (!p) {
			p = fetchGeopbfTiles(inner, { signal, fetch: options.fetch, bake: options.bake }).then(async pbf => {
				const src = await createTileSource(pbf, { ...(options.tiler || {}), ...(options.tilerOf?.(inner) || {}) });
				options.onSource?.(inner, src);
				return src;
			});
			p.catch(() => sources.delete(inner));   // 失敗は次の要求で取り直す（中断を含む）
			sources.set(inner, p);
		}
		return p;
	};
	const handler = async (params, abortController) => {
		const t = parseTileUrl(params.url);
		if (!t) throw new Error(`geopbf tile protocol: URL must end with /{z}/{x}/{y}: ${params.url}`);
		const inner = resolveInnerUrl(t.inner);
		const src = await sourceOf(inner, abortController?.signal);
		const bytes = await src.tile(t.z, t.x, t.y);
		return { data: bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : new ArrayBuffer(0) };   // 空＝feature 無しのタイル（MapLibre は空の MVT として扱う）
	};
	handler.sources = sources;
	handler.dispose = async (inner) => { const p = sources.get(inner); sources.delete(inner); if (p) (await p.catch(() => null))?.destroy(); };
	return handler;
}
export const geopbfTileProtocol = makeGeopbfTileProtocol();

// options: { fetch(url,{signal})→Response, sanitize=true, onMeta(innerUrl, meta) }
// addProtocol はソースの attribution / レイヤーの minzoom を設定できないので、必要なら onMeta か loadGeopbf を使う。
export function makeGeopbfProtocol(options = {}) {
	const tiles = makeGeopbfTileProtocol(options);
	const handler = async (params, abortController) => {
		// タイルの要求（末尾 /z/x/y・MapLibre は vector ソースで type:"arrayBuffer" を付ける）はタイル経路へ。type の無い呼び手は URL の形だけで決める
		if ((params.type === "arrayBuffer" || params.type == null) && parseTileUrl(params.url)) return tiles(params, abortController);
		const innerUrl = resolveInnerUrl(params.url);
		const { geojson, meta } = await fetchAndDecode(innerUrl, {
			signal: abortController?.signal, fetch: options.fetch, sanitize: options.sanitize !== false,
		});
		options.onMeta?.(innerUrl, meta);
		return { data: geojson };
	};
	handler.tiles = tiles;   // タイル側の sources / dispose
	return handler;
}

export const geopbfProtocol = makeGeopbfProtocol();
