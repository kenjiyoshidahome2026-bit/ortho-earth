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
	// slot（層の名前）ごとに 1 枚のオーバーレイ（#34・2026-09-23）＝map.addLayer の heatmap／集約は層 id（集約は source id）ごと・並べられる。
	// ガジェット直呼び（map.gadget.heatmap/cluster）は slot "default"＝従来どおり置き換え。オーバーレイ 1 枚＝WebGL2/2D のコンテキスト 1 つ（数十枚は避ける）
	const heats = new Map();   // slot → overlay handle
	const cluss = new Map();   // slot → { ov, draw, pts, cl }
	const ovName = (kind, slot) => slot === "default" ? kind : `${kind}:${slot}`;
	const ensureHeat = slot => { let h = heats.get(slot); if (!h) heats.set(slot, h = map.overlay(heatUrl, { name: ovName("heatmap", slot) })); return h; };
	// クリック＝集約へ寄る（丸の中をクリック）
	const onClick = e => {
		if (!cluss.size) return;
		const r = map.mapEl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
		const hit = ctl.clusterAt(x, y);
		if (hit && hit.properties.cluster) { const z = Math.max(hit.expansionZoom, map.getZoom() + 1); map.flyTo(hit.geometry.coordinates[0], hit.geometry.coordinates[1], Math.min(20, z), (map.view.pitch || 0) * 180 / Math.PI, (map.view.bearing || 0) * 180 / Math.PI); }
	};
	map.mapEl.addEventListener("click", onClick, { signal });
	const ctl = {
		heatmap(src, layer = {}, slot = "default") {
			const pts = pointsOf(src), paint = layer.paint || {}, z = map.getZoom();
			const pos = new Float32Array(pts.length * 3), w = new Float32Array(pts.length);
			pts.forEach((p, i) => {
				const lo = p.lon * D2R, la = p.lat * D2R, cl = Math.cos(la);
				pos[i * 3] = cl * Math.cos(lo); pos[i * 3 + 1] = Math.sin(la); pos[i * 3 + 2] = cl * Math.sin(lo);
				w[i] = Math.max(0, +evalExpr(paint["heatmap-weight"] ?? 1, ctxOf(z, p.props)) || 0);
			});
			const h = ensureHeat(slot), st = heatStyle(paint, z);
			h.post({ type: "style", ...st, minzoom: layer.minzoom ?? -99, maxzoom: layer.maxzoom ?? 99 }, [st.ramp.buffer]);
			h.post({ type: "points", pos, w }, [pos.buffer, w.buffer]);
			return { points: pts.length };
		},
		cluster(src, opts = {}, slot = "default") {
			const pts = pointsOf(src);
			const cl = buildClusters(pts, { clusterRadius: opts.clusterRadius ?? 50, clusterMaxZoom: opts.clusterMaxZoom ?? 14 });
			const draw = clusterDraw(pts, cl, opts);
			let c = cluss.get(slot); if (!c) cluss.set(slot, c = { ov: map.overlay(clusterUrl, { name: ovName("cluster", slot) }) });
			Object.assign(c, { draw, pts, cl });
			if (slot === "default") ctl._cl = cl;   // 検定窓（従来の 1 枠）
			c.ov.post({ type: "levels", levels: draw.map(L => L.map(({ lon, lat, r, fill, stroke, sw, text, tc, ts, op }) => ({ lon, lat, r, fill, stroke, sw, text, tc, ts, op }))), minLevel: cl.minLevel, maxLevel: cl.maxLevel });
			return { points: pts.length, clusters: cl.levels.map(L => L.length) };
		},
		// 画面 (x,y) の丸（今の段）＝MapLibre の集約地物の形（properties に cluster/point_count・expansionZoom）。複数の集約＝後から足した方が上
		clusterAt(x, y) {
			const z = map.getZoom();
			for (const [slot, c] of [...cluss].reverse()) {
				const L = c.draw[Math.max(0, Math.min(c.draw.length - 1, Math.floor(z) - c.cl.minLevel))] || [];
				let best = null, bd = Infinity;
				for (const d of L) { const p = map.projectLL(d.lon, d.lat); if (p[2] < 0) continue; const dd = Math.hypot(p[0] - x, p[1] - y); if (dd <= d.r + 2 && dd < bd) { bd = dd; best = d; } }
				if (!best) continue;
				const props = best.i >= 0 ? c.pts[best.i].props : { cluster: true, point_count: best.n, point_count_abbreviated: abbr(best.n) };
				return { type: "Feature", properties: props, geometry: { type: "Point", coordinates: [best.lon, best.lat] }, layer: { id: best.i >= 0 ? "unclustered-point" : "clusters", type: "circle" }, source: slot === "default" ? "cluster" : slot, expansionZoom: best.ez };
			}
			return null;
		},
		// which＝"heatmap" | "cluster" | 省略（両方）・slot 省略＝その種類の全部
		clear(which, slot) {
			if (!which || which === "heatmap") for (const [k, h] of [...heats]) if (slot == null || k === slot) { h.remove(); heats.delete(k); }
			if (!which || which === "cluster") for (const [k, c] of [...cluss]) if (slot == null || k === slot) { c.ov.remove(); cluss.delete(k); }
		},
		get active() { return { heatmap: heats.size > 0, cluster: cluss.size > 0 }; },
		get slots() { return { heatmap: [...heats.keys()], cluster: [...cluss.keys()] }; },
	};
	signal?.addEventListener("abort", () => ctl.clear(), { once: true });
	return ctl;
}
