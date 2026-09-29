// 外の geocoder を検索窓に差す口（#175・maplibre-gl-geocoder と同じ形）。既定では何も繋がない（本人裁定 2026-09-30＝サーバー無しの方針・利用規約）。
// 利用者が自分の geocoder を持ち込む：map.gadget.search({ geocoderApi, localGeocoder, … })
//   geocoderApi.forwardGeocode(config, abortController) → Promise<{ features: CarmenFeature[] }>（公式と同じ引数・返り）
//   geocoderApi.getSuggestions(config) → Promise<{ suggestions: [{ text, placeId }] }> ＋ searchByPlaceId(config) → Promise<{ place: CarmenFeature }>（forwardGeocode が無い時）
//   localGeocoder(query) → CarmenFeature[]（同期でも Promise でもよい）＝手元の地物を先に出す
// Carmen GeoJSON（text・place_name・center・bbox・place_type・id）→ 検索窓の候補（search.js の hit）へ詰め替えるだけ＝窓・履歴・着地は共通。
import { getLang } from "./i18n.js";

/** Carmen GeoJSON の地物 → 検索窓の候補。pointZoom＝範囲の無い点の着地（公式 options.zoom・既定 16） */
export function carmenToHit(f, pointZoom = 16) {
	if (!f) return null;
	const g = f.geometry, bbox = Array.isArray(f.bbox) && f.bbox.length >= 4 && f.bbox.every(Number.isFinite) ? f.bbox.slice(0, 4) : null;
	const c = Array.isArray(f.center) ? f.center : g?.type === "Point" ? g.coordinates : bbox ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] : null;
	if (!c || !Number.isFinite(+c[0]) || !Number.isFinite(+c[1])) return null;
	const name = String(f.place_name ?? f.properties?.display_name ?? ""), title = String(f.text ?? f.properties?.name ?? name.split(",")[0] ?? "").trim() || name;
	const note = name && name !== title ? name.replace(new RegExp("^" + title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ",?\\s*"), "") : "";
	const hit = { title, note, lon: +c[0], lat: +c[1], kind: f.place_type?.[0] ?? f.properties?.type };
	if (bbox) hit.bbox = bbox; else hit.zoom = pointZoom;
	if (f.id != null) hit.id = String(f.id);
	return hit;
}

// 公式の config（query・limit・language・countries・bbox・types・proximity）＝利用者の options から
const configOf = (q, o) => {
	const c = { query: q, limit: o.limit ?? 5, language: o.language ?? getLang() };
	for (const k of ["countries", "bbox", "types", "proximity", "autocomplete", "fuzzyMatch"]) if (o[k] != null) c[k] = o[k];
	return c;
};
const keep = (o, f) => !o.filter || o.filter(f);

/** geocoderApi → 検索窓の供給元 */
export function geocoderProvider(api, o = {}) {
	return {
		async query(q, signal) {
			if (q.length < (o.minLength ?? 2)) return [];
			const config = configOf(q, o);
			if (typeof api.forwardGeocode === "function") {
				const ac = new AbortController(); signal?.addEventListener("abort", () => ac.abort(), { once: true });
				const r = await api.forwardGeocode(config, ac);
				return (r?.features || []).filter(f => keep(o, f)).map(f => carmenToHit(f, o.zoom)).filter(Boolean);
			}
			if (typeof api.getSuggestions === "function" && typeof api.searchByPlaceId === "function") {   // 候補だけ先に・座標は選んだ時に引く
				const r = await api.getSuggestions(config);
				return (r?.suggestions || []).map(s => ({
					title: s.text, note: s.place_name && s.place_name !== s.text ? s.place_name : "", lon: NaN, lat: NaN, id: s.placeId,
					resolve: async () => carmenToHit((await api.searchByPlaceId({ ...config, query: s.placeId }))?.place, o.zoom),
				}));
			}
			return [];
		},
	};
}

/** localGeocoder（query → Carmen 地物の配列）→ 検索窓の供給元 */
export function localGeocoderProvider(fn, o = {}) {
	return {
		async query(q) {
			if (q.length < (o.minLength ?? 2)) return [];
			const fs = await fn(q);
			return (fs || []).filter(f => keep(o, f)).slice(0, o.limit ?? 5).map(f => carmenToHit(f, o.zoom)).filter(Boolean);
		},
	};
}
