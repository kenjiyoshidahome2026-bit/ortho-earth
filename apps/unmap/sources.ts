// UNMAP オフライン版のデータ源（M0・2026-11-14 確認）。M1＝オンラインで Range 直読み・M2＝端末（OPFS）に置いた物を先に読む。
// 置き場は URL で差し替えられる（?osm=<pmtiles の URL>・?gel=<pmtiles の URL>）＝UN の認証の後ろへ写した時も、UNMAP に替えた時もコードは同じ。
//
// OSM planet：Protomaps basemaps v4（OSM＋Natural Earth・z0–15・ODbL の Produced Work・約 126 GB）。
//   Source Cooperative の写し（protomaps/openstreetmap/v4.pmtiles）。配る側は「他オリジンからの直リンクは避けて自分の置き場へ写せ」と言っている
//   ＝試作の間だけここを読む。職員に配る前に UN の置き場へ写す（M5）。日次ビルド（build.protomaps.com）は 1 週間で消える＝固定の URL に使わない。
// GEL：Smart Maps Global Elevation Tiles（UN Smart Maps・CC0・約 183 GB）。WebP・mapbox の画素詰め（−10000＋(R×65536＋G×256＋B)×0.1）。
//   z2–5＝Global Map（ISCGM・85°N–85°S）／z6–12＝NASADEM（約 30 m・60°N–56°S）。
export interface Sources { osm: string; gel: string; online: boolean }
// 端末に置いた PMTiles（M2）：OPFS の unmap/map/（ベクタ）と unmap/terrain/（標高のラスタ）。読む時は端末の物を先に、オンラインの planet を最後に束ねる（複合）。
export const LOCAL_DIRS = { map: "unmap/map", terrain: "unmap/terrain" } as const;
export type LocalKind = keyof typeof LOCAL_DIRS;
/** ヘッダの tileType（1 mvt・6 mlt＝地図／2 png・3 jpeg・4 webp・5 avif＝地形）→ 置き場。どちらでもなければ null */
export const kindOfTileType = (t: number): LocalKind | null => t === 1 || t === 6 ? "map" : t >= 2 && t <= 5 ? "terrain" : null;
const pm = (u: string): string => u.startsWith("pmtiles://") ? u : "pmtiles://" + u;
/** 読むアーカイブ＝端末の物（OPFS の道）を先に・オンラインを最後に。1 本なら複合にしない。何も無ければ null */
export function archiveUrl(localPaths: string[], online: string | null, composite: (urls: string[]) => string): string | null {
	const urls = [...localPaths.map(p => "pmtiles://opfs:" + p.replace(/^\/+/, "")), ...(online ? [pm(online)] : [])];
	return urls.length === 0 ? null : urls.length === 1 ? urls[0] : composite(urls);
}

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
	return { osm: safeUrl(q.get("osm"), href) ?? DEFAULT_OSM, gel: safeUrl(q.get("gel"), href) ?? DEFAULT_GEL, online: q.get("online") !== "0" };   // ?online=0＝オンラインの planet を読まない（端末の物だけ＝回線なしの試験）
}

/** GEL の地形（MapLibre の raster-dem と同じ形・tiles は pmtiles:// のアーカイブ 1 つ（複合も可）＝core の dem-src が索引で引く） */
export const gelTerrain = (gel: string) => ({
	source: { type: "raster-dem" as const, tiles: [pm(gel)], encoding: "mapbox" as const, tileSize: 512, minzoom: 2, maxzoom: 12, attribution: GEL_ATTRIBUTION },
});
