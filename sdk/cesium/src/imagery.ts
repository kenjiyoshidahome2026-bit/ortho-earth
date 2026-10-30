// scene.imageryLayers → the globe's raster layers (MapLibre raster sources: {z}/{x}/{y}, {quadkey}, {bbox-epsg-3857}, {TileMatrix}).
// A layer goes on the globe when its provider is ready and is a Web Mercator tile service the globe can fetch directly:
// UrlTemplate (OpenStreetMap, TileMapService), Bing (also behind ion), ArcGIS MapServer tiles, WMTS (REST), WMS, SingleTile.
// Geographic-tiled services (EPSG:4326: ion's Natural Earth II, Blue Marble, Earth at Night, TMS archives) are re-tiled to Web
// Mercator here (geoTile): a "cs-geo://" protocol on the globe answers each Mercator tile by drawing, row by row at the row's
// latitude, the geographic tiles that cover it, fetched through the provider's own requestImage (ion tokens, TMS row flips and
// the provider's levels stay Cesium's). Order, show and alpha follow the collection.
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
/** the request headers an IonResource adds to each tile (IonResource._makeRequest): the asset's Bearer token — without it ion's tile servers answer 401 */
const ionHeaders = (res: Any): { headers: Record<string, string> } | null => res?._ionEndpoint?.accessToken && !res._isExternal ? { headers: { Authorization: `Bearer ${res._ionEndpoint.accessToken}` } } : null;

/** a provider → a MapLibre raster source (or null) */
export function rasterSourceOf(p: Any): Any | null {
	if (!p) return null;
	const name = p.constructor?.name;
	if (name === "IonImageryProvider") return rasterSourceOf(p._imageryProvider);
	if (isGeographic(p)) return typeof p.requestImage === "function" ? geoSource(p) : (unsupported(`${name} with a geographic tiling scheme and no requestImage`), null);
	const range = { minzoom: p.minimumLevel ?? 0, maxzoom: Math.min(22, p.maximumLevel ?? 19), tileSize: p.tileWidth ?? 256 };
	if (name === "BingMapsImageryProvider") {
		const tpl: string = p._imageUrlTemplate;
		if (!tpl) return null;
		const subs: string[] = p._imageUrlSubdomains?.length ? p._imageUrlSubdomains : [""];
		// n=z (as Cesium asks): where Bing has no tile at that level it sends an empty body instead of its "no imagery" camera picture, which
		// the globe would otherwise draw (material-with-custom-glsl at z20: a white floor of camera icons); the globe takes the parent tile there
		const nz = (u: string) => /[?&]n=z\b/.test(u) ? u : u + (u.includes("?") ? "&" : "?") + "n=z";
		return { type: "raster", tiles: subs.map(s => nz(tpl.replace("{subdomain}", s).replace("{culture}", p._culture || "").replace(/^http:/, "https:"))), ...range, tileSize: 256, attribution: "© Microsoft" };
	}
	if (name === "ArcGisMapServerImageryProvider") {
		const base = raw(p._resource).replace(/\/$/, "");
		return { type: "raster", tiles: [withQuery(`${base}/tile/{z}/{y}/{x}`, p._resource?.queryParameters)], ...range, attribution: "Esri" };
	}
	if (name === "WebMapTileServiceImageryProvider") {
		// Cesium keeps the provider's values on its resource: KVP as query parameters (tilematrix={TileMatrix}…), REST as template values
		// ({layer}, {style}, {format}…); both come out as one template whose {TileMatrix}/{TileRow}/{TileCol} the globe fills (tileMatrixLabels → matrixIds)
		const res = p._resource, tv: Record<string, Any> = { ...(res?._templateValues ?? {}), TileMatrixSet: p._tilematrixset, tilematrixset: p._tilematrixset, format: p._format };
		let t = p._useKvp ? withQuery(raw(res), res?.queryParameters) : raw(res);
		t = t.replace(/\{(\w+)\}/g, (m, k) => /^(TileMatrix|tilematrix|TileRow|tilerow|TileCol|tilecol)$/.test(k) ? `{${k === "tilematrix" ? "TileMatrix" : k === "tilerow" ? "TileRow" : k === "tilecol" ? "TileCol" : k}}` : tv[k] != null ? encodeURIComponent(String(tv[k])) : m);
		if (!/\{TileMatrix\}/.test(t)) { unsupported("WebMapTileServiceImageryProvider without {TileMatrix}"); return null; }
		const ids = Array.isArray(p._tileMatrixLabels) ? p._tileMatrixLabels.map(String) : undefined;
		return { type: "raster", tiles: [t], ...range, ...(ids ? { matrixIds: ids } : {}) };
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
		return { type: "raster", tiles, ...range, ...ionHeaders(res) };
	}
	unsupported(`imagery provider ${name}`);
	return null;
}

// ── geographic tiles → Web Mercator tiles ──
const GEO_SCHEME = "cs-geo";
const geoProviders = new Map<string, Any>(), geoKeys = new WeakMap<object, string>();
let geoN = 0, geoInstalled = false;
/** the raster source of a geographic provider: Mercator tiles served by the cs-geo protocol (geoTile) */
function geoSource(p: Any): Any {
	let key = geoKeys.get(p);
	if (!key) { key = `g${geoN++}`; geoKeys.set(p, key); geoProviders.set(key, p); }
	const r = p.rectangle, d = 180 / Math.PI;
	const bounds = r ? [Math.max(-180, r.west * d), Math.max(-85.0511, r.south * d), Math.min(180, r.east * d), Math.min(85.0511, r.north * d)] : undefined;
	// geographic level z−1 has a Mercator level-z tile's longitude resolution, so Mercator maximumLevel+1 is still native
	return { type: "raster", tiles: [`${GEO_SCHEME}://${key}/{z}/{x}/{y}`], minzoom: 0, maxzoom: Math.min(22, (p.maximumLevel ?? 18) + 1), tileSize: 256, ...(bounds && { bounds }) };
}
/** the geographic-tile row (in tiles from the north, ny tiles over 180°) of each of the N+1 row edges of Mercator tile row y at level z */
export function mercatorRows(z: number, y: number, ny: number, N = 256): Float64Array {
	const out = new Float64Array(N + 1), n = 2 ** z;
	for (let i = 0; i <= N; i++) {
		const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + i / N) / n))) * 180 / Math.PI;
		out[i] = (90 - lat) / 180 * ny;
	}
	return out;
}
/** Mercator tile z/x/y (256²) drawn from the provider's geographic tiles: level z of the geographic scheme (one finer than the
 *  longitude match, so the stretch toward the poles stays sharp), each output row sampled at its own latitude. null = nothing there */
export async function geoTile(p: Any, z: number, x: number, y: number): Promise<ImageBitmap | null> {
	const N = 256, ts = p.tilingScheme, level = Math.max(p.minimumLevel ?? 0, Math.min(p.maximumLevel ?? 18, z));
	const nx: number = ts?.getNumberOfXTilesAtLevel ? ts.getNumberOfXTilesAtLevel(level) : 2 << level, ny: number = ts?.getNumberOfYTilesAtLevel ? ts.getNumberOfYTilesAtLevel(level) : 1 << level;
	const tw = p.tileWidth || 256, th = p.tileHeight || 256;
	const n = 2 ** z, lon0 = x / n * 360 - 180, lon1 = (x + 1) / n * 360 - 180;
	const rows = mercatorRows(z, y, ny, N);
	const gx0 = Math.max(0, Math.floor((lon0 + 180) / 360 * nx)), gx1 = Math.min(nx - 1, Math.ceil((lon1 + 180) / 360 * nx) - 1);
	const gy0 = Math.max(0, Math.floor(rows[0])), gy1 = Math.min(ny - 1, Math.ceil(rows[N]) - 1);
	if (gx1 < gx0 || gy1 < gy0) return null;
	const asks: Array<[number, number]> = [];
	for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) asks.push([gx, gy]);
	// a tile outside the provider's rectangle or missing on the server (404) is simply not drawn, as Cesium leaves it
	const imgs = await Promise.all(asks.map(([gx, gy]) => Promise.resolve().then(() => p.requestImage(gx, gy, level)).then((im: Any) => im ?? null, () => null)));
	if (!imgs.some(Boolean)) return null;
	const strip = new OffscreenCanvas((gx1 - gx0 + 1) * tw, (gy1 - gy0 + 1) * th), sc = strip.getContext("2d")!;
	// ImageryProvider.loadImage fetches ImageBitmaps with flipY (ready for the WebGL upload): an ImageBitmap tile is upside down → draw it mirrored; an Image element (no createImageBitmap) is not
	asks.forEach(([gx, gy], i) => {
		const im = imgs[i]; if (!im) return;
		const dx = (gx - gx0) * tw, dy = (gy - gy0) * th;
		if (typeof ImageBitmap !== "undefined" && im instanceof ImageBitmap) { sc.save(); sc.translate(dx, dy + th); sc.scale(1, -1); sc.drawImage(im, 0, 0, tw, th); sc.restore(); }
		else sc.drawImage(im, dx, dy, tw, th);
	});
	const out = new OffscreenCanvas(N, N), oc = out.getContext("2d")!;
	const sx = ((lon0 + 180) / 360 * nx - gx0) * tw, sw = (lon1 - lon0) / 360 * nx * tw;
	for (let r = 0; r < N; r++) {
		const sy = (rows[r] - gy0) * th, sh = Math.max(1e-3, (rows[r + 1] - rows[r]) * th);
		oc.drawImage(strip, sx, sy, sw, sh, 0, r, N, 1);
	}
	return out.transferToImageBitmap();
}
async function geoLoader({ url }: { url: string }): Promise<{ data: ImageBitmap | null }> {
	const m = /^cs-geo:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(url), p = m && geoProviders.get(m[1]);
	if (!p) throw new Error(`cs-geo: no provider for ${url}`);
	return { data: await geoTile(p, +m![2], +m![3], +m![4]) };
}

/** ImageryLayer.brightness / contrast / saturation / hue (GlobeFS: color·b, mix(0.5, color, c), mix(gray, color, s), hue in radians) as the
 *  globe's MapLibre raster paint, whose factors are 1/(1−v) (contrast) and 1−1/(1.001−v) (saturation) — inverted here so the same picture comes out.
 *  colorToAlpha (+threshold) and cutoutRectangle go as this map's raster-color-to-alpha / raster-cutout (baked into the tiles at decode).
 *  Not expressible: brightness above 1 (the paint's max is 1) and gamma (none in the paint) */
export function adjustPaint(L: Any): Record<string, number | number[]> {
	const out: Record<string, number | number[]> = {};
	const b = +L.brightness, c = +L.contrast, s = +L.saturation, h = +L.hue;
	if (Number.isFinite(b) && b !== 1) out["raster-brightness-max"] = Math.max(0, Math.min(1, b));
	if (Number.isFinite(c) && c !== 1) out["raster-contrast"] = Math.max(-1, Math.min(0.999, c > 1 ? 1 - 1 / c : c - 1));
	if (Number.isFinite(s) && s !== 1) out["raster-saturation"] = Math.max(-1, Math.min(0.999, s > 1 ? 1.001 - 1 / s : s - 1));
	if (Number.isFinite(h) && h) out["raster-hue-rotate"] = h * 180 / Math.PI;
	const c2a = L.colorToAlpha, th = +(L.colorToAlphaThreshold ?? 0.004);   // GlobeFS APPLY_COLOR_TO_ALPHA: max |rgb − c| < threshold → alpha 0
	if (c2a && th > 0) out["raster-color-to-alpha"] = [+c2a.red || 0, +c2a.green || 0, +c2a.blue || 0, th];
	const cut = L.cutoutRectangle, d = 180 / Math.PI;   // the layer is not drawn inside the rectangle
	if (cut && Number.isFinite(cut.west)) out["raster-cutout"] = [cut.west * d, cut.south * d, cut.east * d, cut.north * d];
	return out;
}
/** keep the globe's raster layers equal to scene.imageryLayers */
export function syncImagery(scene: Any, map: Any): void {
	const coll = scene.imageryLayers;
	if (!coll) return;
	if (!geoInstalled && typeof map.addProtocol === "function") { map.addProtocol(GEO_SCHEME, geoLoader); geoInstalled = true; }   // the protocol is global on the globe: once
	let placed: string[] = [];
	const ids = new WeakMap<object, string>(), adjSigs = new Map<string, string>(); let n = 0;
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
			const adj = adjustPaint(w.layer), paint = { "raster-opacity": w.layer.alpha ?? 1, ...adj }, adjSig = JSON.stringify(adj);
			if (map.getSource?.(w.id) && adjSigs.get(w.id) !== adjSig) { map.removeLayer(w.id); map.removeSource(w.id); }   // the globe bakes the colour adjustment into the tiles at decode: a change re-mounts the layer
			if (!map.getSource?.(w.id)) { map.addSource(w.id, w.src); map.addLayer({ id: w.id, type: "raster", source: w.id, paint, layout: { visibility: w.layer.show ? "visible" : "none" } }, before()); adjSigs.set(w.id, adjSig); }
			else { map.setPaintProperty(w.id, "raster-opacity", paint["raster-opacity"]); map.setLayoutProperty(w.id, "visibility", w.layer.show ? "visible" : "none"); }
		}
		for (const w of want) map.moveLayer?.(w.id, before());   // collection order = bottom to top
		placed = want.map(w => w.id);
	};
	for (const ev of ["layerAdded", "layerRemoved", "layerMoved", "layerShownOrHidden"]) coll[ev]?.addEventListener?.(() => sync());
	// alpha / brightness are plain fields: look again now and then
	let last = "";
	scene.postRender.addEventListener(() => {
		let k = "";
		for (let i = 0; i < coll.length; i++) { const L = coll.get(i), c = L.colorToAlpha, r = L.cutoutRectangle; k += `${L.alpha},${L.show},${L.brightness},${L.saturation},${L.contrast},${L.hue},${L.ready},${c ? `${c.red},${c.green},${c.blue},${L.colorToAlphaThreshold}` : ""},${r ? `${r.west},${r.south},${r.east},${r.north}` : ""};`; }
		if (k !== last) { last = k; sync(); }
	});
	sync();
}
