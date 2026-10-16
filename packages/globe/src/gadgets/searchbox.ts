// ガジェット：地名・住所検索。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.search() で搭載する（v1 ortho-map の gadget 作法＝this が map）。DOM＋挙動配線をここで完結。
// input→button の順＝虫めがねが input の上に描かれる（DOM順の裁き・z-index不使用）。
// 検索の窓（履歴・IME）は search.js の createSearch・問い合わせ先は並べた順に（#175）：
//   opts.provider（地域宣言の供給元＝日本は地理院・1 つか配列）→ opts.world（世界の既定＝国・州・都市・地形・26 言語・true か { url, lang }）
//   → opts.localGeocoder → opts.geocoderApi（maplibre-gl-geocoder と同じ形＝利用者が自分の geocoder を差す）
// 世界と外の geocoder の中身は初めて問い合わせた時に import()＝搭載だけなら初期バンドルも索引も読まない。
// ヒット→ opts.onResult(hit)・onGo(lon, lat, zoom, tilt)（既定＝球面フライト）。範囲（bbox）の候補は地図の cameraForBounds で倍率を出す。
import { createSearch } from "../search.ts";
import { gadgetStack } from "./stack.ts";
import { keyBusy } from "./keys.ts";
import { tr } from "../i18n.ts";
import type { LonLat, SearchOptions } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";
import type { SearchSource } from "../search.ts";
const t = tr();
/** 世界の既定の設定（true の代わりに渡す）＝索引の置き場・名前の言語・候補の数 */
type WorldOpts = { url?: string; lang?: string; limit?: number };
/** 窓のオプション＝公式の SearchOptions に、地域の申告の供給元（provider）と destroy の合図（signal）を足した物 */
export type SearchboxOpts = Omit<SearchOptions, "provider" | "world"> & { provider?: SearchSource | SearchSource[] | null; world?: boolean | WorldOpts | SearchSource; signal?: AbortSignal };
// 中身を初めて使う時に import する供給元（窓の搭載は同期のまま）
const lazy = (load: () => Promise<SearchSource>, histKey?: string): SearchSource => { let p: Promise<SearchSource> | null = null; return { histKey, query: (q: string, s?: AbortSignal) => (p ||= load().catch(e => { p = null; throw e; })).then(x => x.query(q, s)) }; };
function searchProviders(opts: SearchboxOpts = {}): SearchSource[] {
	const list = ([] as SearchSource[]).concat(opts.provider || []).filter(Boolean);
	if (opts.world) { const o = opts.world === true ? {} : opts.world; list.push(typeof (o as SearchSource).query === "function" ? o as SearchSource : lazy(() => import("../worldsearch.ts").then(m => m.createWorldSearch(o as WorldOpts)), "ortho.searches")); }
	const g = { limit: opts.limit, language: opts.language, countries: opts.countries, bbox: opts.bbox, types: opts.types, proximity: opts.proximity, minLength: opts.minLength, zoom: opts.zoom === undefined || Array.isArray(opts.zoom) ? undefined : opts.zoom, filter: opts.filter };   // zoom＝公式の点の着地（数）・配列はガジェットの表示宣言（ズーム域）
	if (opts.localGeocoder) list.push(lazy(() => import("../geocoder.ts").then(m => m.localGeocoderProvider(opts.localGeocoder!, g))));
	if (opts.geocoderApi && !opts.localGeocoderOnly) list.push(lazy(() => import("../geocoder.ts").then(m => m.geocoderProvider(opts.geocoderApi!, g))));
	return list;
}
/** 地名・住所の検索の窓。問い合わせ先が無い・二重搭載は undefined */
export function search(this: GlobeMap, opts: SearchboxOpts = {}): HTMLDivElement | undefined {
	const mapEl = this.mapEl, map = this;
	if (mapEl.querySelector("#search")) return;   // 二重搭載は無害（搭載済みのまま）
	const providers = searchProviders(opts);
	if (!providers.length) return;   // 問い合わせ先が 1 つも無い（地域の宣言も world も geocoderApi も無い）＝窓を出さない（何も引けない窓は置かない）
	const addr = !!(opts.provider || opts.geocoderApi);   // 住所まで引ける供給元がある＝「地名・住所」・世界だけ＝「地名」
	const ph = opts.placeholder || t(addr ? "Search places and addresses" : "Search places");
	const esc = (s: unknown) => String(s).replace(/[&<>"]/g, c => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }) as Record<string, string>)[c]);
	const box = document.createElement("div");
	box.id = "search";
	box.innerHTML = `
		<input id="search-in" type="search" placeholder="${esc(ph)}" aria-label="${esc(ph)}" autocomplete="off" spellcheck="false">
		<button id="search-btn" data-tip="${esc(opts.placeholder ? ph + " (/)" : t(addr ? "Search places and addresses (/)" : "Search places (/)"))}" aria-label="${esc(ph)}">
			<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.2" fill="none" stroke="#3f4757" stroke-width="2.2"/><line x1="15.2" y1="15.2" x2="20.5" y2="20.5" stroke="#3f4757" stroke-width="2.2" stroke-linecap="round"/></svg>
		</button>`;
	gadgetStack(mapEl).append(box);   // 置き場所はスタック（搭載順＝縦の並び）
	// 候補リストは箱の外＝#map 直下の動的要素（後置＝スタック下段のガジェットより上に描く。z-index不使用の掟）。
	// 位置と幅は search.js が検索箱に追随させる。
	const list = document.createElement("div");
	list.id = "search-list";
	list.setAttribute("role", "listbox"); list.setAttribute("aria-label", t("Search suggestions"));
	mapEl.append(list);
	// 範囲に寄る倍率＝地図の cameraForBounds（無い地図＝equal 等は opts.fit を渡す）。余白 40px・寄りすぎない（maxZoom）
	const fit = opts.fit || (map.cameraForBounds && ((bbox: [number, number, number, number]) => { const c = map.cameraForBounds(bbox, { padding: 40, maxZoom: opts.maxZoom ?? 12 }); return c && { lon: (c.center as LonLat)[0], lat: (c.center as LonLat)[1], zoom: c.zoom }; }));
	createSearch({ provider: providers, onGo: opts.onGo || ((lon, lat, zoom, tilt) => map.flyTo(lon, lat, zoom, tilt)), onResult: opts.onResult, fit, histKey: opts.histKey, signal: opts.signal, root: mapEl });   // 飛び方は本体の領分（opts.onGoで差し替え可）。signal＝destroy時のリスナー解除
	// /＝検索窓へフォーカス（GitHub/YouTube と同じ所作）。入力欄フォーカス中は素通し＝/ をそのまま打てる・
	// Firefox のクイック検索も preventDefault で抑止。既存文字は選択して即上書きできる状態に。
	window.addEventListener("keydown", e => {
		if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
		if (keyBusy(mapEl)) return;
		e.preventDefault();
		box.classList.add("open");   // 虫めがねだけの畳んだ状態なら input を展開してから（ボタンクリックと同じ所作）
		const inp = box.querySelector<HTMLInputElement>("#search-in")!; inp.focus(); inp.select?.();
	}, { signal: opts.signal });
	return box;
}
