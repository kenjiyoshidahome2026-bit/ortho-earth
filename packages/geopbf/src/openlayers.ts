// OpenLayers integration — VectorSource 用の loader ファクトリ。
// ol はここでは import しない（モジュラーな ol の format インスタンスを利用者から受け取る）:
//
//   import VectorSource from "ol/source/Vector.js";
//   import GeoJSON from "ol/format/GeoJSON.js";
//   import { makeGeopbfLoader } from "geopbf/openlayers";
//
//   const source = new VectorSource({
//     loader: makeGeopbfLoader("geopbf://https://host/path.geopbf", new GeoJSON()),
//   });
//
// loader は VectorSource から this=source で呼ばれる契約（ol 公式）。featureProjection には
// loader に渡ってくる view の投影を使うので、EPSG:3857 等への変換は ol 側で自動。
// ファイルヘッダの ATTRIBUTION は source.setAttributions() へ自動配線する（source 側の明示指定が優先）。
// fetch/gzip透過/デコード/サニタイズの実体は modules/geojson-load.ts（maplibre/leaflet 統合と共用）。
import { loadGeopbf, sanitizeProperties, type LoadOptions } from "./modules/geojson-load.ts";
import type { FeatureCollection, HeaderMeta } from "../types/geopbf.js";

export { loadGeopbf, sanitizeProperties };

// options: { fetch, sanitize, signal }（ローダ注入）＋ { onMeta(meta), onError(error) }
/** ol の format（readFeatures があれば足りる・ol は import しない） */
interface FormatLike { readFeatures(source: FeatureCollection, options?: { featureProjection?: unknown }): unknown[] }
/** VectorSource のうち、ここが使う所 */
interface SourceLike { getAttributions?(): unknown; setAttributions(a: string): void; addFeatures?(features: unknown[]): void; removeLoadedExtent?(extent: unknown): void }
export type GeopbfLoaderOptions = LoadOptions & { onMeta?: (meta: HeaderMeta) => void; onError?: (error: unknown) => void };
export function makeGeopbfLoader(url: string, format: FormatLike, options: GeopbfLoaderOptions = {}) {
	if (!format?.readFeatures) throw new Error("geopbf/openlayers: makeGeopbfLoader(url, format) needs an ol format instance (e.g. new GeoJSON())");
	return function (this: SourceLike | undefined, extent: unknown, resolution: number, projection: unknown, success?: (features: unknown[]) => void, failure?: () => void) {
		const source = this; // VectorSource（ol が bind する。未 bind の裸呼びも許容）
		loadGeopbf(url, options).then(({ geojson, ...meta }) => {
			const features = format.readFeatures(geojson, { featureProjection: projection });
			if (meta.attribution && source?.getAttributions && !source.getAttributions()) source.setAttributions(meta.attribution);
			source?.addFeatures?.(features);
			options.onMeta?.(meta);
			success?.(features);
		}).catch(error => {
			source?.removeLoadedExtent?.(extent);
			failure?.();
			options.onError?.(error);
		});
	};
}
