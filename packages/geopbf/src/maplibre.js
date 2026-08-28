// MapLibre GL JS integration — データ供給のみ（gint描画エンジンのmaplibre互換ではない）
// maplibre-gl はここでは import しない。addProtocol への登録は利用者側の責務で、
// 本モジュールはハンドラ関数（MapLibre v4+ の AddProtocolAction 形）だけを提供する:
//
//   import maplibregl from "maplibre-gl";
//   import { geopbfProtocol } from "geopbf/maplibre";
//   maplibregl.addProtocol("geopbf", geopbfProtocol);
//   map.addSource("x", { type: "geojson", data: "geopbf://https://host/path.geopbf" });
//
// geopbf は「1データセット=1ファイル」なので出口は geojson ソース。タイル化・簡略化は
// MapLibre 内蔵の geojson-vt に任せる。feature-state を使う場合はソースの promoteId を指定のこと。
// fetch/gzip透過/デコード/サニタイズの実体は modules/geojson-load.js（leaflet 統合と共用）。
import { resolveInnerUrl, fetchAndDecode, sanitizeProperties, loadGeopbf } from "./modules/geojson-load.js";

export { sanitizeProperties, loadGeopbf };

// options: { fetch(url,{signal})→Response, sanitize=true, onMeta(innerUrl, meta) }
// addProtocol はソースの attribution / レイヤーの minzoom を設定できないので、必要なら onMeta か loadGeopbf を使う。
export function makeGeopbfProtocol(options = {}) {
	return async (params, abortController) => {
		const innerUrl = resolveInnerUrl(params.url);
		const { geojson, meta } = await fetchAndDecode(innerUrl, {
			signal: abortController?.signal, fetch: options.fetch, sanitize: options.sanitize !== false,
		});
		options.onMeta?.(innerUrl, meta);
		return { data: geojson };
	};
}

export const geopbfProtocol = makeGeopbfProtocol();
