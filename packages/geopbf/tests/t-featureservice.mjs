// フィーチャーサービスの読み口（#176・src/service/featureservice.js）＝模擬の応答で ArcGIS（geojson＋ページング／Esri JSON＋id の束）と OGC API – Features を確かめる。
// 模擬のサーバー＝fetch の差し替え（ネットワークに出ない）。要求の URL を記録して、鍵の引き継ぎ・bbox・ページの大きさも見る。
import { parseServiceUrl, openFeatureService, esriToGeoJSON, makeFeatureServiceProtocol } from "../src/service/featureservice.js";

let fails = 0;
const ok = (name, cond, note = "") => { if (!cond) fails++; console.log(`${cond ? "ok" : "NG"} ${name}${note ? "  " + note : ""}`); };
const json = (obj, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => obj });

// ── 試料：10 地物の点（lon＝i・lat＝i/2）＝bbox で絞れる ──
const PTS = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, lon: i * 10 - 45, lat: i * 2 }));
const inBox = (p, b) => !b || (p.lon >= b[0] && p.lon <= b[2] && p.lat >= b[1] && p.lat <= b[3]);
const log = [];
let hit429 = 0;
function server(url, init) {
	log.push({ url, accept: init?.headers?.Accept });
	const u = new URL(url), q = u.searchParams, path = u.pathname;
	// ArcGIS（geojson・ページング可・maxRecordCount 4・範囲は Web メルカトル）
	if (path === "/arcgis/rest/services/Pts/FeatureServer/0") return json({ name: "Pts", maxRecordCount: 4, supportedQueryFormats: "JSON, geoJSON, PBF", advancedQueryCapabilities: { supportsPagination: true }, objectIdField: "OBJECTID", copyrightText: "Pts © Somebody", geometryType: "esriGeometryPoint",
		extent: { xmin: -5009377.085697311, ymin: 0, xmax: 5009377.085697311, ymax: 2273030.926987689, spatialReference: { wkid: 102100, latestWkid: 3857 } }, fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }, { name: "name", type: "esriFieldTypeString" }] });
	if (path === "/arcgis/rest/services/Pts/FeatureServer/0/query") {
		if (q.get("token") !== "SECRET") return json({ error: { code: 499, message: "Token Required" } });
		const b = q.get("geometry") ? q.get("geometry").split(",").map(Number) : null;
		const sel = PTS.filter(p => inBox(p, b));
		if (q.get("returnCountOnly") === "true") return json({ count: sel.length });
		if (q.get("resultOffset") === "4" && !hit429++) return json({}, 429, { "retry-after": "0" });   // 一度だけ混んでいる
		const off = +q.get("resultOffset") || 0, n = +q.get("resultRecordCount") || 4, page = sel.slice(off, off + n);
		return json({ type: "FeatureCollection", features: page.map(p => ({ type: "Feature", id: p.id, properties: { OBJECTID: p.id, name: "p" + p.id }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })), properties: { exceededTransferLimit: off + n < sel.length } });
	}
	// ArcGIS（古い版＝JSON だけ・ページング不可＝id の束）
	if (path === "/arcgis/rest/services/Old/MapServer/2") return json({ name: "Old", maxRecordCount: 2, supportedQueryFormats: "JSON, AMF", objectIdField: "FID", extent: { xmin: 0, ymin: 0, xmax: 10, ymax: 10, spatialReference: { wkid: 4326 } } });
	if (path === "/arcgis/rest/services/Old/MapServer/2/query") {
		if (q.get("returnCountOnly") === "true") return json({ count: 3 });
		if (q.get("returnIdsOnly") === "true") return json({ objectIdFieldName: "FID", objectIds: [3, 1, 2] });
		const ids = q.get("objectIds").split(",").map(Number);
		const G = {
			1: { x: 1, y: 2 },
			2: { paths: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] },
			3: { rings: [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]], [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]] },   // 外環＝時計回り・穴＝反時計回り
		};
		return json({ objectIdFieldName: "FID", geometryType: "esriGeometryPolygon", features: ids.map(id => ({ attributes: { FID: id, kind: "k" + id }, geometry: G[id] })) });
	}
	// OGC API – Features（next をたどる・numberMatched・相対の next）
	if (path === "/ogc/collections/pts") return json({ id: "pts", title: "Points (OGC)", extent: { spatial: { bbox: [[-45, 0, 45, 18]], crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" } }, links: [{ rel: "license", title: "CC BY 4.0", href: "https://creativecommons.org/licenses/by/4.0/" }] });
	if (path === "/ogc/collections/pts/items") {
		const b = q.get("bbox") ? q.get("bbox").split(",").map(Number) : null;
		const sel = PTS.filter(p => inBox(p, b)), lim = +q.get("limit") || 10, off = +q.get("offset") || 0, page = sel.slice(off, off + lim);
		const next = off + lim < sel.length ? `items?limit=${lim}&offset=${off + lim}${b ? "&bbox=" + b.join(",") : ""}` : null;
		return json({ type: "FeatureCollection", numberMatched: sel.length, numberReturned: page.length, features: page.map(p => ({ type: "Feature", id: "o" + p.id, properties: { n: p.id }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })), links: next ? [{ rel: "next", href: next, type: "application/geo+json" }] : [] });
	}
	return json({ error: { message: "not found " + path } }, 404);
}
const fetchMock = async (url, init) => server(url, init);

// ── URL の形 ──
const P = u => parseServiceUrl(u);
ok("parse", P("https://h/arcgis/rest/services/A/FeatureServer/0")?.kind === "arcgis" && P("https://h/x/MapServer/12/query?where=1%3D1&token=T")?.base === "https://h/x/MapServer/12" && P("https://h/x/MapServer/12/query?where=1%3D1&token=T").params.get("token") === "T" && !P("https://h/x/MapServer/12/query?where=1%3D1&token=T").params.has("where")
	&& P("https://h/ogc/collections/lakes/items?limit=5&key=K")?.kind === "ogc" && P("https://h/ogc/collections/lakes/items?limit=5&key=K").base === "https://h/ogc/collections/lakes" && P("https://h/ogc/collections/lakes/items?limit=5&key=K").params.get("key") === "K"
	&& P("https://h/data/lakes.geojson") === null && P("https://h/arcgis/rest/services/A/FeatureServer") === null && P("ftp://h/x/FeatureServer/0") === null);

// ── ArcGIS geojson＋ページング＋鍵の引き継ぎ＋429 ──
const a = await openFeatureService("https://gis.example/arcgis/rest/services/Pts/FeatureServer/0/query?token=SECRET", { fetch: fetchMock });
ok("cache-key", a.cacheKey("all") === "FS1::https://gis.example/arcgis/rest/services/Pts/FeatureServer/0::-::all" && !a.cacheKey("3/1/2").includes("SECRET") && a.cacheKey("3/1/2").endsWith("::3/1/2"), a.cacheKey("all"));
ok("arcgis-meta", a.kind === "arcgis" && a.name === "Pts" && a.count === 10 && a.maxRecordCount === 4 && a.idField === "OBJECTID" && a.attribution === "Pts © Somebody" && a.fields.length === 2
	&& a.bbox && Math.abs(a.bbox[0] + 45) < 1e-6 && Math.abs(a.bbox[2] - 45) < 1e-6 && Math.abs(a.bbox[3] - 20) < 1e-3, JSON.stringify(a.bbox));
log.length = 0;
const all = await a.readAll();
const qs = log.filter(l => /\/query/.test(l.url) && /f=geojson/.test(l.url));
ok("arcgis-paging", all.features.length === 10 && all.features.map(f => f.id).join() === "1,2,3,4,5,6,7,8,9,10" && qs.length === 4 && hit429 === 2 && qs.every(l => /token=SECRET/.test(l.url) && /outSR=4326/.test(l.url) && /resultRecordCount=4/.test(l.url)), `n=${all.features.length} req=${qs.length} ids=${all.features.map(f => f.id)} 429=${hit429} ${qs.map(l => l.url.replace(/^.*\?/, "")).join(" | ")}`);
const inb = await a.readAll({ bbox: [-20, 0, 20, 10] });
ok("arcgis-bbox", inb.features.map(f => f.properties.OBJECTID).join() === "4,5,6" && (await a.countIn([-20, 0, 20, 10])) === 3 && log.some(l => /geometryType=esriGeometryEnvelope/.test(l.url) && /inSR=4326/.test(l.url)), inb.features.map(f => f.properties.OBJECTID).join());
const cross = await a.readAll({ bbox: [30, 0, -30, 20] });   // 日付変更線を跨ぐ＝2 つに割って合わせる
ok("arcgis-antimeridian", cross.features.map(f => f.id).sort((x, y) => x - y).join() === "1,2,9,10", cross.features.map(f => f.id).join());
const cap = await a.readAll({ max: 5 });
ok("arcgis-max", cap.features.length === 5 && cap.truncated === true);
let err = null; try { await (await openFeatureService("https://gis.example/arcgis/rest/services/Pts/FeatureServer/0", { fetch: fetchMock })).readAll(); } catch (e) { err = e; }
ok("arcgis-error", err && /Token Required/.test(err.message), err?.message);

// ── ArcGIS 古い版（Esri JSON・id の束）──
const o = await openFeatureService("https://gis.example/arcgis/rest/services/Old/MapServer/2", { fetch: fetchMock });
log.length = 0;
const oa = await o.readAll();
const byId = Object.fromEntries(oa.features.map(f => [f.id, f.geometry]));
ok("esri-json", o.count === 3 && o.bbox.join() === "0,0,10,10" && oa.features.length === 3 && log.filter(l => /objectIds=/.test(l.url)).length === 2 && log.every(l => !/f=geojson/.test(l.url))
	&& byId[1].type === "Point" && byId[2].type === "MultiLineString" && byId[3].type === "Polygon" && byId[3].coordinates.length === 2, JSON.stringify(byId[3]));
const ring = byId[3].coordinates[0], signed = r => { let s = 0; for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return s / 2; };
ok("esri-rings", signed(ring) > 0 && signed(byId[3].coordinates[1]) < 0, `outer=${signed(ring)} hole=${signed(byId[3].coordinates[1])}`);   // GeoJSON 流＝外環は反時計回り
ok("esri-convert", esriToGeoJSON({ objectIdFieldName: "OID", features: [{ attributes: { OID: 7 }, geometry: { points: [[1, 2], [3, 4]] } }, { attributes: { OID: 8 }, geometry: null }] }).features.map(f => `${f.id}:${f.geometry?.type ?? null}`).join() === "7:MultiPoint,8:null");

// ── OGC API – Features ──
log.length = 0;
const g = await openFeatureService("https://ogc.example/ogc/collections/pts/items?apikey=K", { fetch: fetchMock });
ok("ogc-meta", g.kind === "ogc" && g.name === "Points (OGC)" && g.count === 10 && g.bbox.join() === "-45,0,45,18" && g.attribution === "CC BY 4.0" && log.every(l => /apikey=K/.test(l.url)) && log.some(l => /geo\+json/.test(l.accept || "")));
log.length = 0;
const ga = await g.readAll({ pageSize: 3 });
ok("ogc-next", ga.features.length === 10 && ga.features[9].id === "o10" && log.filter(l => /\/items/.test(l.url)).length === 4 && log.filter(l => /\/items/.test(l.url)).every(l => /apikey=K/.test(l.url) || /offset=/.test(l.url)), `n=${ga.features.length} req=${log.length}`);
const gb = await g.readAll({ bbox: [-20, 0, 20, 10], pageSize: 2 });
ok("ogc-bbox", gb.features.map(f => f.properties.n).join() === "4,5,6" && (await g.countIn([-20, 0, 20, 10])) === 3, gb.features.map(f => f.properties.n).join());

// ── MapLibre の addProtocol の口 ──
const proto = makeFeatureServiceProtocol({ fetch: fetchMock, max: 6 });
const r = await proto({ url: "featureservice://https://ogc.example/ogc/collections/pts" }, new AbortController());
ok("protocol", r.data.type === "FeatureCollection" && r.data.features.length === 6);

console.log(fails ? `\nFAIL ${fails}` : "\n全件通過");
process.exit(fails ? 1 : 0);
