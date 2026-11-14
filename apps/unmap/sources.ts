// UNMAP オフライン版のデータ源（M0・2026-11-14 確認）。M1 はどちらもオンラインで Range 直読み。
// 置き場は URL で差し替えられる（?osm=<pmtiles の URL>・?gel=<pmtiles の URL>）＝UN の認証の後ろへ写した時も、UNMAP に替えた時もコードは同じ。
//
// OSM planet：Protomaps basemaps v4（OSM＋Natural Earth・z0–15・ODbL の Produced Work・約 126 GB）。
//   Source Cooperative の写し（protomaps/openstreetmap/v4.pmtiles）。配る側は「他オリジンからの直リンクは避けて自分の置き場へ写せ」と言っている
//   ＝試作の間だけここを読む。職員に配る前に UN の置き場へ写す（M5）。日次ビルド（build.protomaps.com）は 1 週間で消える＝固定の URL に使わない。
// GEL：Smart Maps Global Elevation Tiles（UN Smart Maps・CC0・約 183 GB）。WebP・mapbox の画素詰め（−10000＋(R×65536＋G×256＋B)×0.1）。
//   z2–5＝Global Map（ISCGM・85°N–85°S）／z6–12＝NASADEM（約 30 m・60°N–56°S）。
export interface Sources { osm: string; gel: string }

export const DEFAULT_OSM = "https://data.source.coop/protomaps/openstreetmap/v4.pmtiles";
export const DEFAULT_GEL = "https://data.source.coop/smartmaps/gel/gel.pmtiles";
export const OSM_ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap</a> · <a href="https://protomaps.com" target="_blank">Protomaps</a>';
export const GEL_ATTRIBUTION = '<a href="https://source.coop/smartmaps/gel" target="_blank">Smart Maps GEL (NASADEM, Global Map) CC0</a>';

/** URL の門：https だけ（localhost と同じオリジンの http は可）。ダメなら null＝既定へ */
export function safeUrl(q: string | null, base: string): string | null {
	if (!q) return null;
	try {
		const u = new URL(q, base);
		const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
		if (u.protocol === "https:" || (u.protocol === "http:" && (local || u.origin === new URL(base).origin))) return u.href;
	} catch { /* 下で null */ }
	return null;
}

/** 頁の URL（?osm=・?gel=）から読む源を決める */
export function sourcesFrom(href: string): Sources {
	const q = new URL(href).searchParams;
	return { osm: safeUrl(q.get("osm"), href) ?? DEFAULT_OSM, gel: safeUrl(q.get("gel"), href) ?? DEFAULT_GEL };
}

/** GEL の地形（MapLibre の raster-dem と同じ形・tiles は pmtiles:// のアーカイブ 1 つ＝core の dem-src が索引で引く） */
export const gelTerrain = (gel: string) => ({
	source: { type: "raster-dem" as const, tiles: ["pmtiles://" + gel], encoding: "mapbox" as const, tileSize: 512, minzoom: 2, maxzoom: 12, attribution: GEL_ATTRIBUTION },
});
