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
// fetch/gzip透過/デコード/サニタイズの実体は modules/geojson-load.js（maplibre 統合と共用）。
import { loadGeopbf, sanitizeProperties } from "./modules/geojson-load.js";

export { loadGeopbf, sanitizeProperties };

// L に L.GeoPBF クラスと L.geoPBF(url, options) ファクトリを登録して L を返す（冪等）。
// options は L.GeoJSON のもの（style / pointToLayer / onEachFeature …）に加えて
// { fetch, sanitize, signal }（ローダ注入）を受ける。読込完了で "load"、失敗で "error" を fire。
export function extendLeaflet(L) {
	if (!L?.GeoJSON?.extend) throw new Error("geopbf/leaflet: extendLeaflet(L) needs Leaflet's L (L.GeoJSON.extend not found)");
	if (L.GeoPBF) return L;
	L.GeoPBF = L.GeoJSON.extend({
		initialize(url, options) {
			L.GeoJSON.prototype.initialize.call(this, null, options);
			this._loaded = this._load(url); // Promise でも待てるように保持
		},
		async _load(url) {
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
		whenReady() { return this._loaded; },     // await layer.whenReady() で読込完了を待てる
		getMeta() { return this._meta; },          // { name, description, license, attribution, minZoom, maxZoom }
	});
	L.geoPBF = (url, options) => new L.GeoPBF(url, options);
	return L;
}
