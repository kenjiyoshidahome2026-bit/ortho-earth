// 描画結果への問い合わせ（MapLibre の queryRenderedFeatures 相当・2026-09-21）。
// 基図のベクタタイルは描画用にジオメトリへ焼かれ、属性は捨てられている（worker→GPU）。問い合わせの時だけ、
// その場所を「今描いている」タイル（tilemanager の order＝z/x/y）を取り直して（HTTP/IDB キャッシュに当たる）解読し、
// 今のスタイル（層の filter・ズーム域・チップで隠した層）で「描かれている地物」を選び、画面ピクセルで当たりを取る。
//   塗り（fill）＝点が面の中（偶奇則・穴つき）／線（line）＝線幅/2＋許容 px 以内／注記（symbol）＝点は許容 px＋8 以内・線上注記は線と同じ。
// 返す形は MapLibre と同じ（Feature＋layer{id,type,"source-layer"}＋sourceLayer＋source）。順は上に描かれた層から。
// 依存はエンジン内だけ（expr/decode/tile/pmtiles）＝DOM なし。
import { evalExpr, truthy, originOfLayer } from "./expr.js";
import { fetchMVT, polygons } from "./decode.js";
import { tileLocalToLonLat } from "./tile.js";
import { isPMTiles, fetchPMTiles } from "./pmtiles-src.js";

const D2R = Math.PI / 180;
const mercY = lat => { const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const WORLD_PX = 256;   // 256px 世界（ortho の z の定義）＝タイル z の 1 枚は画面で 256·2^(zoom−z) px

// area＝{ ll:[lon,lat] } か { bbox:[w,s,e,n] }。order＝描いているタイル [{ key:"z/x/y", z }]。
// hidden＝隠している style.layers の添字（Set）。tolPx＝許容（既定 3px）。layers＝層 id の絞り込み。filter＝追加の式。
export async function queryTiles({ style, hidden = null, order = [], tileUrl, zoom, area, tolPx = 3, layers = null, filter = null, filterOrigin = "ml", signal = null, cache = null, request = null }) {   // filterOrigin＝問い合わせの filter の出自（queryRenderedFeatures＝MapLibre の口）   // request＝pipeline と同じ手入れ（#37）
	const want = layers ? new Set(layers) : null;
	const [w, s, e, n] = area.bbox || [area.ll[0], area.ll[1], area.ll[0], area.ll[1]];
	// 領域に掛かるタイル（同じ場所は最も細かい z だけ＝下地の粗い段は重ねない）
	const tiles = [];
	for (const o of order) {
		const [z, x, y] = o.key.split("/").map(Number), N = 2 ** z;
		const tx0 = x / N, tx1 = (x + 1) / N, ty0 = y / N, ty1 = (y + 1) / N;
		const qx0 = (w + 180) / 360, qx1 = (e + 180) / 360, qy0 = mercY(n), qy1 = mercY(s);
		if (qx1 < tx0 || qx0 > tx1 || qy1 < ty0 || qy0 > ty1) continue;
		tiles.push({ z, x, y, key: o.key });
	}
	if (area.ll && tiles.length > 1) { tiles.sort((a, b) => b.z - a.z); tiles.length = 1; }   // 点＝その場所を覆う最細の 1 枚
	const need = new Set(style.layers.filter(L => L["source-layer"]).map(L => L["source-layer"]));
	const out = [];
	for (const t of tiles) {
		const url = tileUrl(t.z, t.x, t.y);
		if (!url) continue;
		let data = cache?.get(t.key);
		if (!data) {
			const rq = request && !isPMTiles(url) ? request(url, "Tile") : null;
			data = isPMTiles(url) ? await fetchPMTiles(url, t.z, t.x, t.y, signal, need)
				: rq?.load ? await fetchMVT(rq.url, signal, need, null, await rq.load())
				: await fetchMVT(rq?.url ?? url, signal, need, rq ? { headers: rq.headers, credentials: rq.credentials } : null);
			cache?.set(t.key, data);
		}
		if (!data || data.__empty) continue;
		const N = 2 ** t.z;
		for (let li = style.layers.length - 1; li >= 0; li--) {   // 上に描かれた層から（MapLibre と同じ順）
			const L = style.layers[li];
			if (!L["source-layer"] || !(L.type === "fill" || L.type === "line" || L.type === "symbol")) continue;
			if (hidden?.has(li) || L.layout?.visibility === "none") continue;
			if (want && !want.has(L.id)) continue;
			if ((L.minzoom != null && zoom < L.minzoom) || (L.maxzoom != null && zoom >= L.maxzoom)) continue;
			const src = data[L["source-layer"]]; if (!src) continue;
			const ext = src.extent || 4096, pxPerU = WORLD_PX * 2 ** (zoom - t.z) / ext;
			const toU = (lon, lat) => [((lon + 180) / 360 * N - t.x) * ext, (mercY(lat) * N - t.y) * ext];
			const [ux0, uy1] = toU(w, s), [ux1, uy0] = toU(e, n);
			for (const f of src.features) {
				const ctx = { zoom, props: f.props || {}, geom: f.type, vars: {}, origin: originOfLayer(L) };
				if (L.filter && !truthy(evalExpr(L.filter, ctx))) continue;
				if (filter && !truthy(evalExpr(filter, { ...ctx, origin: filterOrigin }))) continue;
				let tol = tolPx;
				if (L.type === "line") { const lw = +evalExpr(L.paint?.["line-width"] ?? 1, ctx); tol += (lw > 0 ? lw : 1) / 2; }
				else if (L.type === "symbol" && f.type === "Point") tol += 8;
				if (!hit(f, L.type, ux0, uy0, ux1, uy1, tol / pxPerU, !!area.bbox)) continue;
				out.push({ type: "Feature", id: f.id, properties: f.props || {}, geometry: toGeoJSON(f, t, ext),
					layer: { id: L.id, type: L.type, "source-layer": L["source-layer"] }, sourceLayer: L["source-layer"], source: "basemap", tile: t.key });
			}
		}
	}
	return out;
}

// 当たり：box＝外接箱の重なり（MapLibre の box 問い合わせと同じ粗さ）／点＝面は中・線と点は距離
function hit(f, type, x0, y0, x1, y1, tolU, box) {
	const { coords: c, ends } = f.geom;
	if (box) {
		let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
		for (let i = 0; i < c.length; i += 2) { if (c[i] < bx0) bx0 = c[i]; if (c[i] > bx1) bx1 = c[i]; if (c[i + 1] < by0) by0 = c[i + 1]; if (c[i + 1] > by1) by1 = c[i + 1]; }
		return !(bx1 < x0 - tolU || bx0 > x1 + tolU || by1 < y0 - tolU || by0 > y1 + tolU);
	}
	const px = x0, py = y0;
	if (f.type === "Polygon" && type === "fill") {
		let inside = false, s = 0;
		for (const eIdx of ends) { for (let i = s, j = eIdx - 2; i < eIdx; j = i, i += 2) { const yi = c[i + 1], yj = c[j + 1]; if ((yi > py) !== (yj > py) && px < (c[j] - c[i]) * (py - yi) / (yj - yi) + c[i]) inside = !inside; } s = eIdx; }
		return inside;
	}
	if (f.type === "Point") { for (let i = 0; i < c.length; i += 2) if (Math.hypot(c[i] - px, c[i + 1] - py) <= tolU) return true; return false; }
	// 線（面の輪郭を line 層で描くものも含む）＝線分への距離
	let s = 0;
	for (const eIdx of ends) {
		for (let i = s; i + 2 < eIdx; i += 2) {
			const ax = c[i], ay = c[i + 1], bx = c[i + 2], by = c[i + 3], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
			const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
			if (Math.hypot(ax + t * dx - px, ay + t * dy - py) <= tolU) return true;
		}
		s = eIdx;
	}
	return false;
}

function toGeoJSON(f, t, ext) {
	const { coords: c, ends } = f.geom;
	const ll = i => tileLocalToLonLat(t.x, t.y, t.z, c[i], c[i + 1], ext);
	const run = (s, e) => { const a = []; for (let i = s; i < e; i += 2) a.push(ll(i)); return a; };
	if (f.type === "Point") { const pts = run(0, c.length); return pts.length === 1 ? { type: "Point", coordinates: pts[0] } : { type: "MultiPoint", coordinates: pts }; }
	if (f.type === "LineString") { const ls = []; let s = 0; for (const e of ends) { ls.push(run(s, e)); s = e; } return ls.length === 1 ? { type: "LineString", coordinates: ls[0] } : { type: "MultiLineString", coordinates: ls }; }
	// 面＝外周（正の面積）ごとに穴を束ねる（decode.polygons と同じ分け方）
	const polys = [];
	let s = 0, cur = null;
	const outerStarts = new Set(polygons(f.geom).map(([sub]) => sub.byteOffset / c.BYTES_PER_ELEMENT));
	for (const e of ends) { const ring = run(s, e); if (outerStarts.has(s) || !cur) { cur = [ring]; polys.push(cur); } else cur.push(ring); s = e; }
	return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
}
