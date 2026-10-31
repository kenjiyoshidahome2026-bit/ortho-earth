// Terrain providers the globe cannot read by URL (CustomHeightmapTerrainProvider, ArcGISTiledElevationTerrainProvider's LERC tiles,
// VRTheWorld, Google Earth Enterprise …) → the globe's raster-dem. A "cs-terrain://" protocol on the globe answers each Web Mercator
// tile by asking the provider's own requestTileGeometry for the tiles that cover it (its tiling scheme, its levels, its availability)
// and sampling their heights (TerrainData.interpolateHeight on each tile's own grid, LERC decoded here) at every pixel, handed over as
// terrarium pixels. Heights stay Cesium's (taken as they are).
import Lerc from "lerc";

type Any = any;
const SCHEME = "cs-terrain", N = 256, D2R = Math.PI / 180;
const providers = new Map<string, Any>();
let installed = false, seq = 0;

/** the tile's TerrainData at (x, y, level), or its nearest ancestor the provider has (null = none) */
async function dataAt(p: Any, x: number, y: number, level: number): Promise<{ data: Any; x: number; y: number; level: number } | null> {
	const memo: Map<string, Promise<Any>> = (p.__csTerrMemo ||= new Map());
	for (; level >= 0; level--, x >>= 1, y >>= 1) {
		if (p.getTileDataAvailable?.(x, y, level) === false) continue;
		const k = `${level}/${x}/${y}`;
		let pr = memo.get(k);
		if (!pr) {
			const [tx, ty, tl] = [x, y, level];
			pr = Promise.resolve().then(() => p.requestTileGeometry(tx, ty, tl)).then((d: Any) => d ?? null, () => null);
			memo.set(k, pr);
			if (memo.size > 512) memo.delete(memo.keys().next().value!);
		}
		const data = await pr;
		if (data) return { data, x, y, level };
	}
	return null;
}

/** a provider tile's heights on a regular lon/lat grid (its own sample spacing): interpolateHeight once per sample, not per pixel */
interface Grid { w: number; h: number; west: number; south: number; dx: number; dy: number; v: Float32Array }
function gridFor(ts: Any, d: { data: Any; x: number; y: number; level: number }): Grid | null {
	if (d.data.__csGrid !== undefined) return d.data.__csGrid as Grid | null;
	const rc = ts.tileXYToRectangle(d.x, d.y, d.level);
	if (d.data._encoding === 1 && !d.data._mesh) return (d.data.__csGrid = lercGrid(ts, d, rc));
	const w = Math.max(2, Math.min(257, d.data._width ?? 65)), h = Math.max(2, Math.min(257, d.data._height ?? 65));
	const dx = (rc.east - rc.west) / (w - 1), dy = (rc.north - rc.south) / (h - 1), v = new Float32Array(w * h);
	for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
		// a hair inside the edges: interpolateHeight answers undefined exactly on them for some data
		const lo = rc.west + Math.min(w - 1 - 1e-6, Math.max(1e-6, i)) * dx, la = rc.south + Math.min(h - 1 - 1e-6, Math.max(1e-6, j)) * dy;
		const hv = d.data.interpolateHeight(rc, lo, la);
		v[j * w + i] = Number.isFinite(hv) ? hv : NaN;
	}
	return (d.data.__csGrid = { w, h, west: rc.west, south: rc.south, dx, dy, v });
}
/** a LERC heightmap (ArcGIS elevation) decoded here: interpolateHeight answers only from the mesh Cesium's worker would build, and that
 *  worker cannot start on a cross-origin-isolated page without CORP headers on Cesium's Workers. Rows are north to south, on the tiling
 *  scheme's own rows (Web Mercator for ArcGIS): each output row takes the source row at its latitude */
function lercGrid(ts: Any, d: { data: Any; x: number; y: number; level: number }, rc: Any): Grid | null {
	let r: Any;
	const b = d.data._buffer;
	try { r = Lerc.decode(b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { return null; }
	const src = r?.pixels?.[0], sw = r?.width, sh = r?.height;
	if (!src || !(sw > 1) || !(sh > 1) || r.statistics?.[0]?.minValue === Number.MAX_VALUE) return null;
	const nat = ts.tileXYToNativeRectangle(d.x, d.y, d.level), proj = ts.projection;
	const w = sw, h = sh, v = new Float32Array(w * h), dy = (rc.north - rc.south) / (h - 1), c = { longitude: 0, latitude: 0, height: 0 };
	for (let j = 0; j < h; j++) {   // j = 0 at the south edge (the grid's order)
		c.latitude = rc.south + j * dy;
		const ny = proj ? proj.project(c).y : c.latitude;
		const fr = Math.max(0, Math.min(sh - 1, (nat.north - ny) / (nat.north - nat.south) * (sh - 1))), r0 = Math.min(sh - 2, Math.floor(fr)), a = fr - r0;
		for (let i = 0; i < w; i++) v[j * w + i] = src[r0 * sw + i] * (1 - a) + src[(r0 + 1) * sw + i] * a;
	}
	return { w, h, west: rc.west, south: rc.south, dx: (rc.east - rc.west) / (w - 1), dy, v };
}
function sampleGrid(g: Grid, lon: number, lat: number): number {
	const fx = Math.max(0, Math.min(g.w - 1, (lon - g.west) / g.dx)), fy = Math.max(0, Math.min(g.h - 1, (lat - g.south) / g.dy));
	const x0 = Math.min(g.w - 2, Math.floor(fx)), y0 = Math.min(g.h - 2, Math.floor(fy)), ax = fx - x0, ay = fy - y0, v = g.v, w = g.w;
	const a = v[y0 * w + x0], b = v[y0 * w + x0 + 1], c = v[(y0 + 1) * w + x0], e = v[(y0 + 1) * w + x0 + 1];
	return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + e * ax) * ay;
}

/** one Web Mercator tile's heights (N×N, NaN = no data) */
async function heightsOf(p: Any, z: number, x: number, y: number): Promise<Float32Array | null> {
	const ts = p.tilingScheme, n = 2 ** z;
	// the provider's level whose tiles are about as wide as this tile (geographic: 2 tiles at level 0, Web Mercator: 1)
	const level = Math.max(0, z - Math.round(Math.log2(ts.getNumberOfXTilesAtLevel(0))));
	const lon = new Float64Array(N), lat = new Float64Array(N);
	for (let i = 0; i < N; i++) {
		lon[i] = ((x + (i + 0.5) / N) / n * 360 - 180) * D2R;
		lat[i] = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + (i + 0.5) / N) / n)));
	}
	// the provider's tiles under the pixels (a few per Mercator tile): tile edges follow meridians and parallels in both of Cesium's
	// tiling schemes, so a column's x and a row's y are found once
	const scratch = { longitude: lon[0], latitude: lat[0], height: 0 }, tx = new Int32Array(N), ty = new Int32Array(N);
	for (let c = 0; c < N; c++) { scratch.longitude = lon[c]; tx[c] = ts.positionToTileXY(scratch, level)?.x ?? -1; }
	scratch.longitude = lon[0];
	for (let r = 0; r < N; r++) { scratch.latitude = lat[r]; ty[r] = ts.positionToTileXY(scratch, level)?.y ?? -1; }
	const asks = new Map<string, Promise<Grid | null>>();
	const gridOf = (x0: number, y0: number): Promise<Grid | null> => {
		const k = `${x0}/${y0}`;
		let g = asks.get(k);
		if (!g) asks.set(k, g = x0 < 0 || y0 < 0 ? Promise.resolve(null) : dataAt(p, x0, y0, level).then(d => d && gridFor(ts, d)));
		return g;
	};
	const cols = [...new Set(tx)], rows = [...new Set(ty)], grids = new Map<string, Grid | null>();
	await Promise.all(rows.flatMap(y0 => cols.map(x0 => gridOf(x0, y0).then(g => { grids.set(`${x0}/${y0}`, g); }))));
	if (![...grids.values()].some(Boolean)) return null;
	const out = new Float32Array(N * N);
	for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
		const g = grids.get(`${tx[c]}/${ty[r]}`);
		out[r * N + c] = g ? sampleGrid(g, lon[c], lat[r]) : NaN;
	}
	return out;
}

/** heights → terrarium pixels (alpha 0 = no data), handed to the globe as they are (no canvas: a PNG round trip per tile stalled the page) */
function terrarium(h: Float32Array): ImageData {
	const px = new Uint8ClampedArray(N * N * 4);
	for (let i = 0; i < h.length; i++) {
		const v = h[i], j = i * 4;
		if (v !== v) continue;
		const e = Math.max(0, Math.min(65535.996, v + 32768)), w = Math.floor(e);
		px[j] = w >> 8; px[j + 1] = w & 255; px[j + 2] = Math.floor((e - w) * 256); px[j + 3] = 255;
	}
	return new ImageData(px, N, N);
}

async function loader({ url }: { url: string }): Promise<{ data: ImageData | null }> {
	const m = /^cs-terrain:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(url), p = m && providers.get(m[1]);
	if (!p) throw new Error(`${SCHEME}: no provider for ${url}`);
	const h = await heightsOf(p, +m![2], +m![3], +m![4]);
	return { data: h ? terrarium(h) : null };
}

/** a terrain provider with its own requestTileGeometry → a raster-dem source the globe reads through the protocol (null = not one) */
// The globe's terrain source for a Cesium terrain provider (scene.ts onTerrain picks which kind it is).
// negative: the sea surface of these ellipsoid heights is at the geoid height N (about −29 m in San Francisco Bay); the globe's default would lift it to 0.
// dtm + world bounds: Cesium clamps models (HeightReference CLAMP_TO_GROUND / RELATIVE_TO_GROUND) onto whatever terrain the provider gives, so the
// globe may lift them onto it everywhere. Without it the globe lifts only inside a declared bare-earth region (none outside Japan), and the truck of
// physically-based-materials stayed at 0 m, 1.7 km under the Mexican hills (2026-10-31)
export function terrainSourceOf(o: { bridged?: Any | null; cwt?: boolean; bathy?: boolean; ionId?: number; url?: string | null; headers?: Any; token?: string }): Any | null {
	const ground = { dtm: true, bounds: [-180, -90, 180, 90] };
	if (o.bridged) return { ...ground, ...o.bridged, dtm: true };
	if (o.cwt) return { type: "quantized-mesh", ion: { assetId: 1, accessToken: o.token }, heights: "orthometric", negative: true, ...ground };
	if (o.bathy) return { type: "quantized-mesh", ion: { assetId: 2426648, accessToken: o.token }, heights: "orthometric", seafloor: true, ...ground };
	if (o.ionId! > 0) return { type: "quantized-mesh", ion: { assetId: o.ionId, accessToken: o.token }, heights: "orthometric", negative: true, ...ground };
	if (o.url) return { type: "quantized-mesh", url: o.url, headers: o.headers, heights: "orthometric", negative: true, ...ground };
	return null;
}

export function bridgedTerrainSource(map: Any, p: Any): Any | null {
	if (typeof p?.requestTileGeometry !== "function" || !p.tilingScheme || typeof map.addProtocol !== "function") return null;
	if (!installed) { map.addProtocol(SCHEME, loader); installed = true; }   // the protocol is global on the globe: once
	const id = (p.__csTerrId ||= `t${seq++}`);
	providers.set(id, p);
	// the deepest level: ArcGIS says how many it has; a callback provider answers any level (Cesium refines it as deep as the view needs)
	const x0 = Math.round(Math.log2(p.tilingScheme.getNumberOfXTilesAtLevel(0)));
	const maxzoom = Math.min(16, Number.isFinite(p._lodCount) ? p._lodCount - 1 + x0 : 16);
	return { type: "raster-dem", tiles: [`${SCHEME}://${id}/{z}/{x}/{y}`], encoding: "terrarium", tileSize: N, minzoom: 0, maxzoom };
}
