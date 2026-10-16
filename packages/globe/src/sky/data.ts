// 星空・太陽系のデータの置き場＝GitHub Pages（リポ ortho-data の globe/sky/・2026-10-13〜）。置くのは git push だけ（bucket の鍵が要らない・
// packages/world/scripts/publish-pages.mjs）。旧＝bucket の GIS/pbf（stars.6 などの名前読み）と GIS/space（名前の表）。
//   stars.6・constellation_lines・messier・moon_nomenclature（.geopbf）／names/<lang>.json（星座・メシエ・天体の名前）／moon_nomenclature.i18n/<lang>.json
// 写しは HTTP キャッシュ任せ（Pages＝10 分・以後は ETag の照合で 304）＝IDB には置かない（geopbf(URL) の写しは版を見ない＝置き直した物が届かない）。
// 回線が無い時は古くても HTTP キャッシュの物で出す（force-cache）。ortho-solar は同じ URL を自前の数行で読む（コードを共有しない＝データで繋ぐ）
import { WORLD_DATA } from "@ortho-earth/core/worldcontent";
import { gunzip, isGzip } from "geopbf/gzip";
import type { GeoPBF, GeopbfFn } from "geopbf";

export const SKY_DATA: string = WORLD_DATA + "sky/";
const get = (url: string): Promise<Response> => fetch(url).catch(() => fetch(url, { cache: "force-cache" }));
/** sky/<name>.geopbf → GeoPBF（gint なし＝描く側が geojson を引くだけ） */
export async function skyPbf(geopbf: GeopbfFn, name: string): Promise<GeoPBF> {
	const r = await get(`${SKY_DATA}${name}.geopbf`); if (!r.ok) throw new Error(`sky/${name}: HTTP ${r.status}`);
	const b = await r.blob();
	return geopbf(await (await isGzip(b) ? await gunzip(b) : b).arrayBuffer(), { name, gint: false });
}
/** sky/<path>（JSON）。取れなければ null＝呼び手が英語・略号で出す */
export const skyJson = (path: string): Promise<unknown> => get(SKY_DATA + path).then(r => r.ok ? r.json() : null).catch(() => null);
