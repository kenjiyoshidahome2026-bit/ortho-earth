// geocoder.js（JS のまま）の型。gadgets/searchbox.ts が読む分だけ（TS 化 段 4・batch 2）＝geocoder.js が TS になれば消える。
import type { CarmenFeature, GeocoderApi, SearchHit } from "../globe.d.ts";

/** 供給元への受け渡し（公式の geocoder の設定と同じ名前）。zoom＝範囲の無い点の着地 */
export interface GeocoderProviderOptions {
	limit?: number; language?: string; countries?: string; bbox?: [number, number, number, number]; types?: string;
	proximity?: { longitude: number; latitude: number }; minLength?: number; zoom?: number; filter?: (feature: CarmenFeature) => boolean;
}
/** geocoderApi → 検索窓の供給元 */
export function geocoderProvider(api: GeocoderApi, o?: GeocoderProviderOptions): { query(q: string, signal?: AbortSignal): Promise<SearchHit[]> };
/** localGeocoder（query → Carmen 地物の配列）→ 検索窓の供給元 */
export function localGeocoderProvider(fn: (query: string) => CarmenFeature[] | Promise<CarmenFeature[]>, o?: GeocoderProviderOptions): { query(q: string): Promise<SearchHit[]> };
