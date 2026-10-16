// Leaflet integration — L.GeoJSON を拡張した geopbf レイヤープラグイン。
// leaflet はここでは import しない（ESM でも CDN の global L でも使えるよう、明示登録方式）:
//
//   import L from "leaflet";                        // CDN なら window.L
//   import { extendLeaflet } from "geopbf/leaflet";
//   extendLeaflet(L);
//   L.geoPBF("geopbf://https://host/path.geopbf", { pointToLayer: (f, ll) => L.circleMarker(ll) })
//     .on("load", e => console.log(e.meta))
//     .addTo(map);
//
// MapLibre 版（addProtocol）と違い、レイヤーが attribution を持てるので
// ファイルヘッダの ATTRIBUTION を自動配線する（options.attribution 明示指定が優先）。
// fetch/gzip透過/デコード/サニタイズの実体は modules/geojson-load.ts（maplibre 統合と共用）。
import { loadGeopbf, sanitizeProperties, type LoadOptions } from "./modules/geojson-load.ts";
import type { FeatureCollection, HeaderMeta } from "../types/geopbf.js";

export { loadGeopbf, sanitizeProperties };

// L に L.GeoPBF クラスと L.geoPBF(url, options) ファクトリを登録して L を返す（冪等）。
// options は L.GeoJSON のもの（style / pointToLayer / onEachFeature …）に加えて
// { fetch, sanitize, signal }（ローダ注入）を受ける。読込完了で "load"、失敗で "error" を fire。
/** Leaflet の L のうち、ここが使う所（leaflet は import しない＝型も自前の最小形） */
interface LeafletLike {
	GeoJSON: { extend(props: object): unknown; prototype: { initialize(this: unknown, data: null, options?: object): void } };
	GeoPBF?: unknown;
	geoPBF?: (url: string, options?: object) => unknown;
	[key: string]: unknown;
}
/** L.GeoPBF の this（L.GeoJSON を拡張したレイヤー） */
interface GeoPBFLayer {
	options: LoadOptions & { attribution?: string };
	_loaded: Promise<GeoPBFLayer>;
	_meta?: HeaderMeta;
	_map?: { attributionControl?: { addAttribution(text: string): void } };
	_load(url: string): Promise<GeoPBFLayer>;
	addData(geojson: FeatureCollection): void;
	fire(type: string, data?: object): void;
}
export function extendLeaflet<T extends LeafletLike>(L: T): T {
	if (!L?.GeoJSON?.extend) throw new Error("geopbf/leaflet: extendLeaflet(L) needs Leaflet's L (L.GeoJSON.extend not found)");
	if (L.GeoPBF) return L;
	L.GeoPBF = L.GeoJSON.extend({
		initialize(this: GeoPBFLayer, url: string, options?: object) {
			L.GeoJSON.prototype.initialize.call(this, null, options);
			this._loaded = this._load(url); // Promise でも待てるように保持
		},
		async _load(this: GeoPBFLayer, url: string) {
			try {
				const { geojson, ...meta } = await loadGeopbf(url, this.options);
				this._meta = meta;
				if (meta.attribution && !this.options.attribution) {
					this.options.attribution = meta.attribution;
					// 既に地図へ追加済みなら attribution control に後追いで反映
					this._map?.attributionControl?.addAttribution(meta.attribution);
				}
				this.addData(geojson);
				this.fire("load", { meta, geojson });
			} catch (error) {
				this.fire("error", { error });
			}
			return this;
		},
		whenReady(this: GeoPBFLayer) { return this._loaded; },     // await layer.whenReady() で読込完了を待てる
		getMeta(this: GeoPBFLayer) { return this._meta; },          // { name, description, license, attribution, minZoom, maxZoom }
	});
	L.geoPBF = (url: string, options?: object) => new (L.GeoPBF as new (url: string, options?: object) => unknown)(url, options);
	return L;
}
