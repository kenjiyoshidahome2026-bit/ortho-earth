// 公開のフィーチャーサービスを URL で直に読む（#176・esri-gl／mapbox-gl-arcgis-featureserver／mapbox-gl-ogc-feature-collection に当たる）。
// 方言は 2 つ：
//   ArcGIS REST  … …/FeatureServer/N（…/MapServer/N・末尾の /query も可）＝メタ（?f=json）・件数（returnCountOnly）・
//                  ページング（resultOffset＋exceededTransferLimit／ページング不可の版は objectIds の束）・f=geojson（無い版は f=json＝Esri JSON を詰め替え）
//   OGC API – Features … …/collections/{id}（…/items も可）＝メタ（collection）・件数（numberMatched）・ページング（links の rel="next" をたどる）
// 取得は呼び手の fetch を使う（既定＝globalThis.fetch）＝鍵（ArcGIS の token 等）は呼び手が付ける（MapLibre の transformRequest と同じ考え）。
// どこかの proxy を経由しない。URL に付いていた問い合わせ（?token=…）は全ての要求へ引き継ぐ。依存なし（Esri の環だけ convert/esri-rings）。
import { assemblePolygons } from "../convert/esri-rings.js";

const ARCGIS = /^(.*\/(?:FeatureServer|MapServer)\/\d+)(?:\/query)?\/?$/i;
const OGC = /^(.*\/collections\/[^/]+)(?:\/items)?\/?$/;
const ARCGIS_KEYS = new Set(["f", "where", "outfields", "outsr", "resultoffset", "resultrecordcount", "geometry", "geometrytype", "insr", "spatialrel", "returncountonly", "returnidsonly", "returngeometry", "objectids"]);
const OGC_KEYS = new Set(["f", "limit", "offset", "bbox", "bbox-crs"]);

/** URL がフィーチャーサービスの形か＝{ kind: "arcgis" | "ogc", base, params }（params＝引き継ぐ問い合わせ）か null */
export function parseServiceUrl(url) {
	let u; try { u = new URL(url); } catch { return null; }
	if (!/^https?:$/.test(u.protocol)) return null;
	const path = u.pathname.replace(/\/+$/, "");
	const m = ARCGIS.exec(path) || null, o = m ? null : OGC.exec(path);
	if (!m && !o) return null;
	const kind = m ? "arcgis" : "ogc", drop = m ? ARCGIS_KEYS : OGC_KEYS;
	const params = new URLSearchParams();
	for (const [k, v] of u.searchParams) if (!drop.has(k.toLowerCase())) params.append(k, v);
	return { kind, base: u.origin + (m ? m[1] : o[1]), params };
}
export const isServiceUrl = url => !!parseServiceUrl(url);

// ── Esri JSON → GeoJSON（f=json の古い版・MapServer）──
const esriGeom = (g, type) => {
	if (!g) return null;
	if (g.x != null && g.y != null) return Number.isFinite(g.x) && Number.isFinite(g.y) ? { type: "Point", coordinates: [g.x, g.y] } : null;
	if (g.points) return { type: "MultiPoint", coordinates: g.points.map(p => [p[0], p[1]]) };
	if (g.paths) { const ls = g.paths.filter(p => p.length >= 2).map(p => p.map(q => [q[0], q[1]])); return !ls.length ? null : ls.length === 1 ? { type: "LineString", coordinates: ls[0] } : { type: "MultiLineString", coordinates: ls }; }
	if (g.rings) return assemblePolygons(g.rings.filter(r => r.length >= 4).map(r => r.map(q => [q[0], q[1]])));
	return null;
};
/** Esri の FeatureSet（{ features: [{ attributes, geometry }], objectIdFieldName }）→ FeatureCollection */
export function esriToGeoJSON(json) {
	const oid = json?.objectIdFieldName;
	return { type: "FeatureCollection", features: (json?.features || []).map(f => { const p = f.attributes || {}; const out = { type: "Feature", properties: p, geometry: esriGeom(f.geometry, json.geometryType) }; if (oid && p[oid] != null) out.id = p[oid]; return out; }) };
}

// 範囲を経緯度へ（ArcGIS の extent は層の座標系＝4326 系と Web メルカトルだけ解く・他は null）
const R = 6378137;
function extentToLonLat(e) {
	if (!e || ![e.xmin, e.ymin, e.xmax, e.ymax].every(Number.isFinite)) return null;
	const wkid = e.spatialReference?.latestWkid ?? e.spatialReference?.wkid;
	if (wkid === 4326 || wkid === 4269 || wkid === 4258 || wkid === 6668 || wkid === 4612) return [e.xmin, e.ymin, e.xmax, e.ymax];
	if (wkid === 3857 || wkid === 102100 || wkid === 102113 || wkid === 900913) {
		const lon = x => x / R * 180 / Math.PI, lat = y => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
		return [lon(e.xmin), lat(e.ymin), lon(e.xmax), lat(e.ymax)];
	}
	return null;
}
const bboxOk = b => Array.isArray(b) && b.length >= 4 && b.slice(0, 4).every(Number.isFinite);
// 日付変更線を跨ぐ範囲（w>e）＝2 つに割る（ArcGIS の envelope も OGC の bbox も跨ぎを受けない実装が多い）
const splitBbox = b => b[0] <= b[2] ? [b] : [[b[0], b[1], 180, b[3]], [-180, b[1], b[2], b[3]]];

// 取得：429／503 は待って 3 回まで（Retry-After を尊重・最大 8 秒）。サービスの誤り（ArcGIS の 200＋{error}）は投げる
const sleep = (ms, signal) => new Promise((ok, ng) => { const t = setTimeout(ok, ms); signal?.addEventListener("abort", () => { clearTimeout(t); ng(new DOMException("aborted", "AbortError")); }, { once: true }); });
async function getJSON(fetchFn, url, { signal, accept } = {}) {
	for (let attempt = 0; ; attempt++) {
		const r = await fetchFn(url, { signal, headers: { Accept: accept || "application/json" } });
		if ((r.status === 429 || r.status === 503) && attempt < 3) { const ra = +(r.headers?.get?.("retry-after")) || 0; await sleep(Math.min(8000, ra > 0 ? ra * 1000 : 500 * 2 ** attempt), signal); continue; }
		if (!r.ok) throw new Error(`feature service: HTTP ${r.status} ${url}`);
		const j = await r.json();
		if (j?.error) throw new Error(`feature service: ${j.error.message || j.error.code || "error"} ${url}`);
		return j;
	}
}
// 控えの鍵（#176・一度読んだ地物を IDB で使い回す）＝サービスの住所＋引き継ぐ問い合わせ（鍵の類は落とす＝秘密を鍵名に残さない）＋版＋部分（"all" か枡）
const SECRET = /^(token|key|apikey|api_key|access_token|accesstoken|sig|signature|auth|password)$/i;
const cacheKeyOf = (svc, params, part) => { const q = new URLSearchParams([...params].filter(([k]) => !SECRET.test(k)).sort(([a], [b]) => a < b ? -1 : 1)).toString(); return `FS1::${svc.url}${q ? "?" + q : ""}::${svc.version ?? "-"}::${part}`; };
const withParams = (base, params, extra) => { const q = new URLSearchParams(params); for (const [k, v] of Object.entries(extra)) if (v != null) q.set(k, String(v)); const s = q.toString(); return s ? `${base}${base.includes("?") ? "&" : "?"}${s}` : base; };

// ── ArcGIS ──
async function openArcGIS(p, { fetch: fetchFn, signal }) {
	const meta = await getJSON(fetchFn, withParams(p.base, p.params, { f: "json" }), { signal });
	const formats = String(meta.supportedQueryFormats || "").toLowerCase();
	const geojson = formats.includes("geojson");
	const paging = !!meta.advancedQueryCapabilities?.supportsPagination;
	const maxRecordCount = +meta.maxRecordCount > 0 ? +meta.maxRecordCount : 1000;
	const idField = meta.objectIdField || meta.fields?.find(f => f.type === "esriFieldTypeOID")?.name || null;
	const where = (bbox, extra) => {
		const q = { where: "1=1", ...extra };
		if (bbox) Object.assign(q, { geometry: bbox.join(","), geometryType: "esriGeometryEnvelope", inSR: 4326, spatialRel: "esriSpatialRelIntersects" });
		return q;
	};
	const query = (bbox, extra, s) => getJSON(fetchFn, withParams(p.base + "/query", p.params, where(bbox, extra)), { signal: s });
	const svc = {
		kind: "arcgis", url: p.base, name: meta.name || null, description: meta.description || null,
		bbox: extentToLonLat(meta.extent), maxRecordCount, idField, geometryType: meta.geometryType || null,
		fields: (meta.fields || []).map(f => ({ name: f.name, type: f.type, alias: f.alias })),
		attribution: meta.copyrightText ? String(meta.copyrightText) : null,
		version: meta.editingInfo?.dataLastEditDate ?? meta.editingInfo?.lastEditDate ?? null,   // 中身が替わった印（無い版・MapServer は null＝控えは期限で捨てる）
		count: null,
		async countIn(bbox, { signal: s } = {}) {
			let n = 0;
			for (const b of bbox ? splitBbox(bbox) : [null]) n += +(await query(b, { returnCountOnly: true, f: "json" }, s)).count || 0;
			return n;
		},
		async *pages({ bbox = null, pageSize = maxRecordCount, signal: s } = {}) {
			const size = Math.max(1, Math.min(pageSize, maxRecordCount));
			const f = geojson ? "geojson" : "json";
			const conv = j => geojson ? j : esriToGeoJSON(j);
			for (const b of bbox ? splitBbox(bbox) : [null]) {
				if (paging) {
					for (let offset = 0; ; offset += size) {
						const j = await query(b, { outFields: "*", outSR: 4326, returnGeometry: true, f, resultOffset: offset, resultRecordCount: size }, s);
						const fc = conv(j);
						if (fc.features?.length) yield fc;
						const more = j.exceededTransferLimit ?? j.properties?.exceededTransferLimit;
						if (!fc.features?.length || !more) break;
					}
				} else {   // ページング不可の版＝まず id の一覧、それを maxRecordCount ずつ
					const ids = (await query(b, { returnIdsOnly: true, f: "json" }, s)).objectIds || [];
					ids.sort((x, y) => x - y);
					for (let i = 0; i < ids.length; i += size) {
						const j = await getJSON(fetchFn, withParams(p.base + "/query", p.params, { objectIds: ids.slice(i, i + size).join(","), outFields: "*", outSR: 4326, returnGeometry: true, f }), { signal: s });
						const fc = conv(j); if (fc.features?.length) yield fc;
					}
				}
			}
		},
	};
	svc.count = await svc.countIn(null, { signal }).catch(() => null);
	return svc;
}

// ── OGC API – Features ──
const GEOJSON_ACCEPT = "application/geo+json, application/json;q=0.9";
async function openOGC(p, { fetch: fetchFn, signal }) {
	const meta = await getJSON(fetchFn, withParams(p.base, p.params, {}), { signal });
	const bb = meta.extent?.spatial?.bbox?.[0];
	const lic = (meta.links || []).find(l => l.rel === "license");
	const items = (bbox, extra) => withParams(p.base + "/items", p.params, { ...(bbox ? { bbox: bbox.join(",") } : {}), ...extra });
	const svc = {
		kind: "ogc", url: p.base, name: meta.title || meta.id || null, description: meta.description || null,
		bbox: bboxOk(bb) ? bb.slice(0, 4) : null, maxRecordCount: null, idField: null, geometryType: meta.itemType || null, fields: null,
		attribution: meta.attribution ? String(meta.attribution) : lic ? String(lic.title || lic.href) : null,
		version: null,   // OGC API – Features に版の印は無い＝控えは期限で捨てる
		count: null,
		async countIn(bbox, { signal: s } = {}) {
			let n = 0;
			for (const b of bbox ? splitBbox(bbox) : [null]) { const j = await getJSON(fetchFn, items(b, { limit: 1 }), { signal: s, accept: GEOJSON_ACCEPT }); if (!Number.isFinite(+j.numberMatched)) return null; n += +j.numberMatched; }
			return n;
		},
		async *pages({ bbox = null, pageSize = 1000, signal: s } = {}) {
			for (const b of bbox ? splitBbox(bbox) : [null]) {
				let url = items(b, { limit: pageSize }), guard = 0;
				while (url && guard++ < 100000) {
					const j = await getJSON(fetchFn, url, { signal: s, accept: GEOJSON_ACCEPT });
					if (j.features?.length) yield { type: "FeatureCollection", features: j.features };
					const next = (j.links || []).find(l => l.rel === "next")?.href;
					url = next && j.features?.length ? new URL(next, url).href : null;
				}
			}
		},
	};
	svc.count = await svc.countIn(null, { signal }).catch(() => null);
	return svc;
}

/**
 * フィーチャーサービスを開く（メタと件数を読む・地物はまだ読まない）。
 * @param {string} url  …/FeatureServer/N・…/MapServer/N・…/collections/{id}（…/query・…/items も可）
 * @param {{ fetch?: (url: string, init?: object) => Promise<Response>, signal?: AbortSignal }} [opts]  fetch＝鍵の付け手（既定＝globalThis.fetch）
 * @returns {Promise<{ kind, url, name, bbox, count, maxRecordCount, idField, fields, attribution, countIn(bbox), pages({ bbox, pageSize }), readAll({ bbox, max }) }>}
 */
export async function openFeatureService(url, { fetch: fetchFn = globalThis.fetch?.bind(globalThis), signal } = {}) {
	const p = parseServiceUrl(url);
	if (!p) throw new Error(`feature service: not a FeatureServer/MapServer layer or OGC API collection URL: ${url}`);
	const svc = await (p.kind === "arcgis" ? openArcGIS : openOGC)(p, { fetch: fetchFn, signal });
	/** 控えの鍵（part＝"all" か枡の "z/x/y"）。版を含む＝サービスの中身が替われば鍵も替わる */
	svc.cacheKey = (part = "all") => cacheKeyOf(svc, p.params, part);
	// 全部（か範囲の分）を 1 つの FeatureCollection に＝id で重複を落とす（範囲を割った時の跨ぎ・ページの境の重なり）。max＝件数の上限（超えたら打ち切り＝truncated）
	svc.readAll = async ({ bbox = null, max = Infinity, pageSize, signal: s = signal } = {}) => {
		const out = [], seen = new Set();
		let truncated = false;
		outer: for await (const fc of svc.pages({ bbox, pageSize, signal: s })) {
			for (const f of fc.features) {
				const id = featureId(svc, f);
				if (id != null) { if (seen.has(id)) continue; seen.add(id); }
				if (out.length >= max) { truncated = true; break outer; }
				out.push(f);
			}
		}
		return { type: "FeatureCollection", features: out, truncated };
	};
	return svc;
}
/** 地物の id（重複落とし・視野追従の差し替えの鍵）＝Feature.id → objectIdField の属性 → null */
export const featureId = (svc, f) => f?.id ?? (svc?.idField ? f?.properties?.[svc.idField] : null) ?? null;

/**
 * MapLibre の addProtocol へ渡す読み口（層を丸ごと 1 つの geojson に）：
 *   maplibregl.addProtocol("featureservice", makeFeatureServiceProtocol());
 *   map.addSource("x", { type: "geojson", data: "featureservice://https://…/FeatureServer/0" });
 * fetch＝鍵を付ける取得（既定＝globalThis.fetch）・max＝件数の上限（既定 50,000）
 */
export function makeFeatureServiceProtocol({ fetch: fetchFn, max = 50000 } = {}) {
	return async (params, abortController) => {
		const url = params.url.replace(/^featureservice:\/\//, "");
		const svc = await openFeatureService(url, { fetch: fetchFn, signal: abortController?.signal });
		const fc = await svc.readAll({ max, signal: abortController?.signal });
		return { data: { type: "FeatureCollection", features: fc.features } };
	};
}
