// 利用者の geojson の symbol 層＝線に沿う注記（symbol-placement "line"／"line-center"・C9・2026-10-12）。
// 点の記号（symbols-2d）は線の最初の頂点に置くだけだった。ここは基図／vector source の注記と同じ経路に流す：
// 視野のタイル（selectLOD＝描く側と同じ選び）ごとに線をタイル単位（extent 4096）へ写して枠で切り（clipLineGeom）、core の buildLabels で
// 錨と折れ線（symbol-spacing・line-center・text-max-angle・keep-upright は描く側 labels2d が裁く）を焼き、sendLabels（"vt:" の層＝vector の注記と同じ口）で渡す。
// 止まるたび（settle）にタイルの集合と ["zoom"] の値（quantZoom）が変わっていれば焼き直す。衝突は基図の注記と同じ土俵（利用者の層が勝つ＝sort を負の帯に）。
import { selectLOD } from "@ortho-earth/core";
import { buildLabels } from "@ortho-earth/core/tilelabels";
import { clipLineGeom, substituteZoom, quantZoom } from "../vtops.js";

const E = 4096, D2R = Math.PI / 180, R2D = 180 / Math.PI, MAX_TILES = 48, TILE_PX = 512 * Math.SQRT2;
const merc = (lon, lat) => { const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * D2R); return [lon / 360 + 0.5, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)]; };
const tileBbox = (z, x, y) => { const n = 2 ** z, lat = v => R2D * Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))); return [x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)]; };

// GeoJSON → 線の地物（LineString／MultiLineString だけ・点と面は捨てる＝MapLibre の line 配置と同じ）。parts＝世界メルカトル [0,1] の平らな列・bbox＝同じ単位
export function gjLineFeatures(src) {
	const feats = Array.isArray(src) ? src : src?.type === "FeatureCollection" ? src.features : src?.type === "Feature" ? [src] : src?.type && src?.coordinates ? [{ type: "Feature", properties: {}, geometry: src }] : src?.features || [];
	const out = [];
	for (const f of feats) {
		const g = f?.geometry; if (!g) continue;
		const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : null;
		if (!lines) continue;
		const parts = [], bbox = [Infinity, Infinity, -Infinity, -Infinity];
		for (const l of lines) {
			if (!Array.isArray(l) || l.length < 2) continue;
			const p = new Float64Array(l.length * 2);
			for (let i = 0; i < l.length; i++) { const [mx, my] = merc(+l[i][0], +l[i][1]); p[i * 2] = mx; p[i * 2 + 1] = my; if (mx < bbox[0]) bbox[0] = mx; if (my < bbox[1]) bbox[1] = my; if (mx > bbox[2]) bbox[2] = mx; if (my > bbox[3]) bbox[3] = my; }
			parts.push(p);
		}
		if (parts.length) out.push({ id: f.id, props: f.properties || {}, parts, bbox });
	}
	return out;
}

// 層の symbol-placement が線か（文字列・式なら今のズームで評価＝地物の属性は見ない）
export const isLinePlacement = (layer, zoom, evalExpr) => {
	const p = layer.layout?.["symbol-placement"]; if (p == null) return false;
	const v = typeof p === "string" ? p : evalExpr(p, { zoom, props: {}, geom: "LineString", vars: {}, origin: "ml" });
	return v === "line" || v === "line-center";
};

// 呼び手の口：cam・size()＝{ w, h }（device px）・dpr・sendLabels(id, list|null, meta)（globe の vtdraw と同じ）
export function createGJLabels(map, { cam, size, dpr = 1, sendLabels }) {
	const layers = new Map();   // id → { layer, feats, key, sig }
	const tilesNow = () => {
		const { w, h } = size();
		let ts = selectLOD(cam, w, h, { minZ: 0, maxZ: 22, tilePx: TILE_PX * dpr });
		if (!ts.length) return [];
		const fine = Math.max(...ts.map(t => t.z));
		ts = ts.filter(t => t.z >= fine - 2);   // 急な傾きの遠くの粗い段は捨てる（vtdraw と同じ）
		const [cx, cy] = cam.center, cw = Math.cos(cy * D2R);
		const d2 = t => { const b = tileBbox(t.z, t.x, t.y), dx = Math.max(b[0] - cx, 0, cx - b[2]) * cw, dy = Math.max(b[1] - cy, 0, cy - b[3]); return dx * dx + dy * dy; };
		return ts.sort((a, b) => d2(a) - d2(b)).slice(0, MAX_TILES);
	};
	const build = (s, ts, pz) => {
		const L0 = s.layer, L = { ...L0, "source-layer": "g", minzoom: undefined, maxzoom: undefined, paint: substituteZoom(L0.paint || {}, pz), layout: { ...substituteZoom(L0.layout || {}, pz), visibility: "visible" } };   // ["zoom"]＝表示の z（worker と同じ近似）
		const out = [];
		for (const t of ts) {
			const n = 2 ** t.z, x0 = t.x / n, y0 = t.y / n, x1 = (t.x + 1) / n, y1 = (t.y + 1) / n, feats = [];
			for (const f of s.feats) {
				if (f.bbox[2] < x0 || f.bbox[0] > x1 || f.bbox[3] < y0 || f.bbox[1] > y1) continue;
				const coords = [], ends = [];
				for (const p of f.parts) { for (let i = 0; i < p.length; i += 2) coords.push((p[i] * n - t.x) * E, (p[i + 1] * n - t.y) * E); ends.push(coords.length); }
				const g = clipLineGeom({ coords, ends }, E);
				if (g) feats.push({ type: "LineString", id: f.id, props: f.props, geom: g });
			}
			if (!feats.length) continue;
			const { labels } = buildLabels({ layers: { g: { extent: E, features: feats } }, z: t.z, x: t.x, y: t.y }, { layers: [L] });
			for (const lb of labels) { lb.sort = -1e6 - s.key * 1e3 + (lb.sort || 0); delete lb.li; out.push(lb); }   // 利用者の注記が基図に勝つ・上の層ほど先に置く（vtdraw-worker と同じ）
		}
		return out;
	};
	const refresh = (force = false) => {
		if (!layers.size) return;
		const ts = tilesNow(), pz = quantZoom(cam.zoom), tsig = ts.map(t => `${t.z}/${t.x}/${t.y}`).join(",") + "@" + pz;
		for (const [id, s] of layers) {
			const sig = tsig + "#" + s.key + "#" + s.rev;
			if (!force && s.sig === sig) continue;
			s.sig = sig;
			const list = build(s, ts, pz);
			sendLabels(id, list.length ? list : null, { minZoom: s.layer.minzoom ?? null, maxZoom: s.layer.maxzoom ?? null });
		}
	};
	const onSettle = () => refresh();
	map.on("settle", onSettle);
	let rev = 0;
	const ctl = {
		// 層を足す／置き換える（layer＝正規化済み＝エンジンの目盛り・src＝GeoJSON・key＝重ね順）
		set(id, layer, src, key = 0) {
			const old = layers.get(id);
			layers.set(id, { layer, feats: gjLineFeatures(src), key: old?.key ?? key, sig: null, rev: ++rev });
			refresh();
			return { features: layers.get(id).feats.length };
		},
		remove(id) { if (layers.delete(id)) sendLabels(id, null, {}); },
		setOrder(id, n) { const s = layers.get(id); if (s && s.key !== n) { s.key = n; refresh(); } },
		has: id => layers.has(id),
		get layerIds() { return [...layers.keys()]; },
		destroy() { for (const id of [...layers.keys()]) ctl.remove(id); map.off("settle", onSettle); },
	};
	return ctl;
}
