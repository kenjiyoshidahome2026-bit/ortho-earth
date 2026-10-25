// scene.imageryLayers → the globe's raster layers (MapLibre raster sources: {z}/{x}/{y}, {quadkey}, {bbox-epsg-3857}, {TileMatrix}).
// A layer goes on the globe when its provider is ready and is a Web Mercator tile service the globe can fetch directly:
// UrlTemplate (OpenStreetMap, TileMapService), Bing (also behind ion), ArcGIS MapServer tiles, WMTS (REST), WMS, SingleTile.
// Geographic-tiled services (EPSG:4326) are reported, not drawn. Order, show and alpha follow the collection.
import { unsupported } from "./report.ts";

type Any = any;
const ID = "__cs-imagery-";
const raw = (res: Any): string => decodeURI(String(res?._url ?? res?.url ?? "")).replace(/%7B/gi, "{").replace(/%7D/gi, "}");
const withQuery = (url: string, q: Any) => {
	if (!q || !Object.keys(q).length) return url;
	const u = new URL(url.replace(/\{/g, "%7B").replace(/\}/g, "%7D"));
	for (const [k, v] of Object.entries(q)) if (!u.searchParams.has(k)) u.searchParams.set(k, String(v));
	return u.href.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
};
const isGeographic = (p: Any) => p?.tilingScheme?.constructor?.name === "GeographicTilingScheme";

/** a provider → a MapLibre raster source (or null) */
export function rasterSourceOf(p: Any): Any | null {
	if (!p) return null;
	const name = p.constructor?.name;
	if (name === "IonImageryProvider") return rasterSourceOf(p._imageryProvider);
	if (isGeographic(p)) { unsupported(`${name} with a geographic tiling scheme (the globe's raster tiles are Web Mercator)`); return null; }
	const range = { minzoom: p.minimumLevel ?? 0, maxzoom: Math.min(22, p.maximumLevel ?? 19), tileSize: p.tileWidth ?? 256 };
	if (name === "BingMapsImageryProvider") {
		const tpl: string = p._imageUrlTemplate;
		if (!tpl) return null;
		const subs: string[] = p._imageUrlSubdomains?.length ? p._imageUrlSubdomains : [""];
		return { type: "raster", tiles: subs.map(s => tpl.replace("{subdomain}", s).replace("{culture}", p._culture || "").replace(/^http:/, "https:")), ...range, tileSize: 256, attribution: "© Microsoft" };
	}
	if (name === "ArcGisMapServerImageryProvider") {
		const base = raw(p._resource).replace(/\/$/, "");
		return { type: "raster", tiles: [withQuery(`${base}/tile/{z}/{y}/{x}`, p._resource?.queryParameters)], ...range, attribution: "Esri" };
	}
	if (name === "WebMapTileServiceImageryProvider") {
		let t = raw(p._resource);
		if (!/\{TileMatrix\}/.test(t)) { unsupported("WebMapTileServiceImageryProvider in KVP encoding"); return null; }
		t = t.replace("{TileMatrixSet}", p._tileMatrixSetID ?? "").replace("{Style}", p._style ?? "default").replace("{style}", p._style ?? "default").replace("{Layer}", p._layer ?? "");
		return { type: "raster", tiles: [t], ...range };
	}
	if (name === "WebMapServiceImageryProvider") return rasterSourceOf(p._tileProvider);
	if (name === "SingleTileImageryProvider") {
		const r = p.rectangle, d = 180 / Math.PI;
		return { type: "image", url: raw(p._resource), coordinates: [[r.west * d, r.north * d], [r.east * d, r.north * d], [r.east * d, r.south * d], [r.west * d, r.south * d]] };
	}
	const res = p._resource ?? p._tileProvider?._resource;
	if (res) {   // UrlTemplate (and its subclasses: OpenStreetMap, TileMapService…)
		let t = raw(res);
		if (/\{(westDegrees|southDegrees|eastDegrees|northDegrees|westProjected|width|height)\}/.test(t)) {
			if (!/\{westProjected\}/.test(t)) { unsupported(`${name} template with degree bounds`); return null; }
			t = t.replace("{westProjected},{southProjected},{eastProjected},{northProjected}", "{bbox-epsg-3857}");
		}
		t = withQuery(t.replace(/\{reverseY\}/g, "{-y}"), res.queryParameters);
		const subs: string[] | undefined = p._subdomains;
		const tiles = /\{s\}/.test(t) && subs?.length ? subs.map(s => t.replace("{s}", s)) : [t];
		return { type: "raster", tiles, ...range };
	}
	unsupported(`imagery provider ${name}`);
	return null;
}

/** keep the globe's raster layers equal to scene.imageryLayers */
export function syncImagery(scene: Any, map: Any): void {
	const coll = scene.imageryLayers;
	if (!coll) return;
	let placed: string[] = [];
	const ids = new WeakMap<object, string>(); let n = 0;
	const sync = () => {
		const want: Array<{ id: string; src: Any; layer: Any }> = [];
		for (let i = 0; i < coll.length; i++) {
			const L = coll.get(i);
			if (!L.ready) { if (!L.__csWait) { L.__csWait = true; L.readyEvent?.addEventListener?.(() => sync()); } continue; }
			const src = rasterSourceOf(L.imageryProvider);
			if (!src) continue;
			let id = ids.get(L); if (!id) { id = `${ID}${n++}`; ids.set(L, id); }
			want.push({ id, src, layer: L });
		}
		const keep = new Set(want.map(w => w.id));
		for (const id of placed) if (!keep.has(id)) { if (map.getLayer?.(id)) map.removeLayer(id); if (map.getSource?.(id)) map.removeSource(id); }
		const before = () => map.getStyle?.()?.layers?.find((l: Any) => /^__cs-(fill|line|ext)/.test(l.id))?.id;
		for (const w of want) {
			const paint = { "raster-opacity": w.layer.alpha ?? 1, ...(w.layer.brightness !== 1 && { "raster-brightness-max": Math.min(1, w.layer.brightness ?? 1) }), ...(w.layer.saturation !== 1 && { "raster-saturation": Math.max(-1, Math.min(1, (w.layer.saturation ?? 1) - 1)) }), ...(w.layer.hue && { "raster-hue-rotate": w.layer.hue * 180 / Math.PI }), ...(w.layer.contrast !== 1 && { "raster-contrast": Math.max(-1, Math.min(1, (w.layer.contrast ?? 1) - 1)) }) };
			if (!map.getSource?.(w.id)) { map.addSource(w.id, w.src); map.addLayer({ id: w.id, type: "raster", source: w.id, paint, layout: { visibility: w.layer.show ? "visible" : "none" } }, before()); }
			else { for (const [k, v] of Object.entries(paint)) map.setPaintProperty(w.id, k, v); map.setLayoutProperty(w.id, "visibility", w.layer.show ? "visible" : "none"); }
		}
		for (const w of want) map.moveLayer?.(w.id, before());   // collection order = bottom to top
		placed = want.map(w => w.id);
	};
	for (const ev of ["layerAdded", "layerRemoved", "layerMoved", "layerShownOrHidden"]) coll[ev]?.addEventListener?.(() => sync());
	// alpha / brightness are plain fields: look again now and then
	let last = "";
	scene.postRender.addEventListener(() => {
		let k = "";
		for (let i = 0; i < coll.length; i++) { const L = coll.get(i); k += `${L.alpha},${L.show},${L.brightness},${L.saturation},${L.contrast},${L.hue},${L.ready};`; }
		if (k !== last) { last = k; sync(); }
	});
	sync();
}
