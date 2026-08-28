// loaders.gl loader — deck.gl / kepler.gl など loaders.gl 系から GeoPBF を読むための Loader オブジェクト。
// @loaders.gl/* はここでは import しない（Loader はただのオブジェクト契約）:
//
//   import { GeoJsonLayer } from "@deck.gl/layers";
//   import { GeoPBFLoader } from "geopbf/loaders";
//   new GeoJsonLayer({ data: "https://host/path.geopbf", loaders: [GeoPBFLoader] });
//
// parse は GeoJSON FeatureCollection を返す（gzip 透過・noeval・サニタイズは maplibre/leaflet と共用）。
// ヘッダメタ（name/description/license/attribution/minZoom/maxZoom）は返り値の `geopbfMeta` に添付する。
// worker: false＝メインスレッド解決（GeoPBF のデコードは軽く、worker バンドル配布を持たないため）。
import { decodeToGeojson, loadGeopbf, sanitizeProperties } from "./modules/geojson-load.js";

export { loadGeopbf, sanitizeProperties };

export const GeoPBFLoader = {
	dataType: null,
	batchType: null,
	name: "GeoPBF",
	id: "geopbf",
	module: "geopbf",
	version: "1.1.0", // package.json の version と揃える（publish 時に確認）
	worker: false,
	extensions: ["geopbf"],
	mimeTypes: ["application/octet-stream", "application/x-geopbf"],
	binary: true,
	category: "geometry",
	options: { geopbf: { sanitize: true } },
	parse: async (arrayBuffer, options) => {
		const { geojson, meta } = await decodeToGeojson(arrayBuffer, { sanitize: options?.geopbf?.sanitize !== false });
		geojson.geopbfMeta = meta;
		return geojson;
	},
};
