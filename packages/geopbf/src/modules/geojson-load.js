// geopbf → GeoJSON の共通ローダ（maplibre / leaflet 統合の共用部）。
// fetch → 全体gzip透過 → noeval デコード → properties サニタイズ → FeatureCollection + ヘッダメタ。
import { GeoPBF } from "../pbf-base.js";
import { isGzip, gunzip } from "./gzip.js";

const SCHEME = "geopbf://";

// "geopbf://https://host/path" → 内側URLの素通し（pmtiles方式）。内側は絶対URL推奨:
// MapLibre は data URL を new URL() で正規化するため、"geopbf://../x" の形は ../ が
// authority に食われて壊れる。"geopbf://https://…" も ":" が落ちて "https//…" になるので復元する。
// http(s) で始まらないものは相対URLとして location 基準で解決（Node等では絶対URL必須）。
export function resolveInnerUrl(url) {
	let inner = url.startsWith(SCHEME) ? url.slice(SCHEME.length) : url;
	inner = inner.replace(/^(https?)\/\//, "$1://"); // MapLibre の URL 正規化で潰れた "https//host" を復元
	if (/^https?:\/\//.test(inner)) return inner;
	const base = globalThis.location?.href;
	if (!base) throw new Error(`geopbf protocol: relative URL requires a browser location (use an absolute URL): ${url}`);
	return new URL(inner, base).href;
}

// 消費側（MapLibre worker 等）の JSON 経由転送に耐える写像。
// 写像: primitive/COLOR(rgb文字列)/JSON=素通し、Date→ISO文字列、BBOX(Float64Array)→Array、
//       FUNC→noeval により関数ソース文字列のまま、BLOB(File/Blob)/IMAGE(ImageData)→キー削除。
export function sanitizeProperties(properties) {
	const q = {};
	for (const key in properties) {
		const v = sanitizeValue(properties[key], 0);
		if (v !== undefined) q[key] = v;
	}
	return q;
	function sanitizeValue(v, depth) {
		if (v == null) return v;
		const type = typeof v;
		if (type === "number" || type === "string" || type === "boolean") return v;
		if (type === "function") return undefined;                                   // 保険（noevalで本来来ない）
		if (v instanceof Date) return v.toISOString();
		if (typeof Blob !== "undefined" && v instanceof Blob) return undefined;      // BLOB/File
		if (typeof ImageData !== "undefined" && v instanceof ImageData) return undefined;
		if (ArrayBuffer.isView(v)) return Array.from(v);                             // BBOX
		if (Array.isArray(v)) return v;                                              // JSON由来＝JSON-safe
		if (depth === 0) {                                                           // ドットキー1段ネスト（値に任意型が来る）
			const o = {};
			for (const k in v) { const u = sanitizeValue(v[k], 1); if (u !== undefined) o[k] = u; }
			return o;
		}
		return v;                                                                    // 深い object は JSON.parse 由来＝そのまま
	}
}

// ArrayBuffer/Blob → { geojson, meta }。gzip はマジックバイトで透過（loaders.gl 等バッファ渡しの入口）。
export async function decodeToGeojson(data, { sanitize = true } = {}) {
	let blob = data instanceof Blob ? data : new Blob([data]);
	if (await isGzip(blob)) blob = await gunzip(blob);                               // ファイル全体gzipの透過（マジック1f 8b判定）
	const pbf = await new GeoPBF({ noeval: true }).set(await blob.arrayBuffer());
	const geojson = pbf.geojson;
	if (sanitize) geojson.features.forEach(f => f.properties = sanitizeProperties(f.properties));
	const meta = {
		name: pbf.name(), description: pbf.description(), license: pbf.license(),
		attribution: pbf.attribution(), minZoom: pbf.minZoom(), maxZoom: pbf.maxZoom(),
	};
	pbf.destroy();
	return { geojson, meta };
}

export async function fetchAndDecode(innerUrl, { signal, fetch: fetchImpl, sanitize = true } = {}) {
	const doFetch = fetchImpl || ((u, init) => fetch(u, { cache: "default", ...init }));
	const res = await doFetch(innerUrl, { signal });
	if (!res.ok) throw new Error(`geopbf protocol: fetch failed (${res.status}) ${innerUrl}`);
	return decodeToGeojson(await res.blob(), { sanitize });
}

// 最短経路（プロトコル/プラグイン登録不要）。attribution / zoom 範囲を自分で配りたい人向け。
// 返り値: { geojson, name, description, license, attribution, minZoom, maxZoom }
export async function loadGeopbf(url, options = {}) {
	const innerUrl = resolveInnerUrl(url);
	const { geojson, meta } = await fetchAndDecode(innerUrl, {
		signal: options.signal, fetch: options.fetch, sanitize: options.sanitize !== false,
	});
	return { geojson, ...meta };
}
