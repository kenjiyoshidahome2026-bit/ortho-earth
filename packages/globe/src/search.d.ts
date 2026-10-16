// search.js（JS のまま）の型。gadgets/searchbox.ts が読む分だけ（TS 化 段 4・batch 2）＝search.js が TS になれば消える。
import type { SearchHit } from "../globe.d.ts";

/** 問い合わせ先の最小の形（地域の申告・公式の SearchProvider・世界・geocoder のどれも満たす） */
export interface SearchSource { query(q: string, signal?: AbortSignal): Promise<unknown>; histKey?: string }

/** 検索窓の配線（root の #search・#search-in・#search-btn・#search-list を掴む）。provider＝供給元（1 つか配列）・fit(bbox)→着地 */
export function createSearch(o: {
	provider: SearchSource | SearchSource[];
	onGo: (lon: number, lat: number, zoom: number, tilt?: number) => unknown;
	onResult?: (hit: SearchHit) => void;
	fit?: ((bbox: [number, number, number, number]) => { lon: number; lat: number; zoom: number } | null | undefined) | null;
	signal?: AbortSignal; root?: ParentNode; histKey?: string;
}): void;
