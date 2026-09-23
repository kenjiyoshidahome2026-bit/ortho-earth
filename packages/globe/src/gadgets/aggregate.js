// ガジェット：点の集約（クラスタ）とヒートマップ（MapLibre の cluster／heatmap 層相当・2026-09-21）。
//   描画は同一フレームのオーバーレイ（heatmap-gl.js＝WebGL2・cluster-2d.js＝canvas2D）＝エンジン本体は触らない。
//   ここ（main）は点の読み出し・MapLibre の式の評価・集約の計算だけ。式は基図と同じ評価器（ortho-core evalExpr）。
//   ズームは ortho の z（256px 世界＝MapLibre の z＋1 と同じ見た目の縮尺）。ピクセルの値（半径など）は MapLibre と同じ意味。
// heatmap(src, layer)：paint＝"heatmap-radius"(30) "heatmap-weight"(1) "heatmap-intensity"(1) "heatmap-color"(既定の青→赤) "heatmap-opacity"(1)＋minzoom/maxzoom。
//   weight は点ごと（属性・その時のズーム）・radius/intensity はズームの表（0〜24・0.5 刻み）・color は ["heatmap-density"] 0..1 の表。
// cluster(src, opts)：{ clusterRadius:50, clusterMaxZoom:14, paint:{ circle-color/-radius/-stroke-color/-stroke-width/-opacity }（集約の丸）,
//   text:{ color, size }, unclustered:{ paint } }。集約の属性＝{ cluster:true, point_count, point_count_abbreviated }（MapLibre と同じ名前）。
//   クリック＝その集約がばらけるズームへ寄る（MapLibre の getClusterExpansionZoom の定番）。
import { evalExpr } from "@ortho-earth/core";
import heatUrl from "../heatmap-gl.js?url";
import clusterUrl from "../cluster-2d.js?url";

import { D2R, ctxOf, abbr, pointsOf, heatStyle, buildClusters, clusterDraw } from "./aggregate-core.js";   // 計算部分（検定 t-aggregate が直接読む）

export function createAggregate(map, { signal } = {}) {
	let heat = null, clus = null, clusDraw = null, clusPts = null;
	const ensureHeat = () => heat ??= map.overlay(heatUrl, { name: "heatmap" });
	const ensureClus = () => clus ??= map.overlay(clusterUrl, { name: "cluster" });
	// クリック＝集約へ寄る（丸の中をクリック）
	const onClick = e => {
		if (!clusDraw) return;
		const r = map.mapEl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
		const hit = ctl.clusterAt(x, y);
		if (hit && hit.properties.cluster) { const z = Math.max(hit.expansionZoom, map.getZoom() + 1); map.flyTo(hit.geometry.coordinates[0], hit.geometry.coordinates[1], Math.min(20, z), (map.view.pitch || 0) * 180 / Math.PI, (map.view.bearing || 0) * 180 / Math.PI); }
	};
	map.mapEl.addEventListener("click", onClick, { signal });
	const ctl = {
		heatmap(src, layer = {}) {
			const pts = pointsOf(src), paint = layer.paint || {}, z = map.getZoom();
			const pos = new Float32Array(pts.length * 3), w = new Float32Array(pts.length);
			pts.forEach((p, i) => {
				const lo = p.lon * D2R, la = p.lat * D2R, cl = Math.cos(la);
				pos[i * 3] = cl * Math.cos(lo); pos[i * 3 + 1] = Math.sin(la); pos[i * 3 + 2] = cl * Math.sin(lo);
				w[i] = Math.max(0, +evalExpr(paint["heatmap-weight"] ?? 1, ctxOf(z, p.props)) || 0);
			});
			const h = ensureHeat(), st = heatStyle(paint, z);
			h.post({ type: "style", ...st, minzoom: layer.minzoom ?? -99, maxzoom: layer.maxzoom ?? 99 }, [st.ramp.buffer]);
			h.post({ type: "points", pos, w }, [pos.buffer, w.buffer]);
			return { points: pts.length };
		},
		cluster(src, opts = {}) {
			const pts = pointsOf(src);
			const cl = buildClusters(pts, { clusterRadius: opts.clusterRadius ?? 50, clusterMaxZoom: opts.clusterMaxZoom ?? 14 });
			clusDraw = clusterDraw(pts, cl, opts); clusPts = pts; ctl._cl = cl;
			ensureClus().post({ type: "levels", levels: clusDraw.map(L => L.map(({ lon, lat, r, fill, stroke, sw, text, tc, ts, op }) => ({ lon, lat, r, fill, stroke, sw, text, tc, ts, op }))), minLevel: cl.minLevel, maxLevel: cl.maxLevel });
			return { points: pts.length, clusters: cl.levels.map(L => L.length) };
		},
		// 画面 (x,y) の丸（今の段）＝MapLibre の集約地物の形（properties に cluster/point_count・expansionZoom）
		clusterAt(x, y) {
			if (!clusDraw) return null;
			const z = map.getZoom(), L = clusDraw[Math.max(0, Math.min(clusDraw.length - 1, Math.floor(z) - ctl._cl.minLevel))] || [];
			let best = null, bd = Infinity;
			for (const c of L) { const p = map.projectLL(c.lon, c.lat); if (p[2] < 0) continue; const d = Math.hypot(p[0] - x, p[1] - y); if (d <= c.r + 2 && d < bd) { bd = d; best = c; } }
			if (!best) return null;
			const props = best.i >= 0 ? clusPts[best.i].props : { cluster: true, point_count: best.n, point_count_abbreviated: abbr(best.n) };
			return { type: "Feature", properties: props, geometry: { type: "Point", coordinates: [best.lon, best.lat] }, layer: { id: best.i >= 0 ? "unclustered-point" : "clusters", type: "circle" }, source: "cluster", expansionZoom: best.ez };
		},
		clear(which) {
			if (!which || which === "heatmap") { heat?.remove(); heat = null; }
			if (!which || which === "cluster") { clus?.remove(); clus = null; clusDraw = null; clusPts = null; }
		},
		get active() { return { heatmap: !!heat, cluster: !!clus }; },
	};
	signal?.addEventListener("abort", () => ctl.clear(), { once: true });
	return ctl;
}
