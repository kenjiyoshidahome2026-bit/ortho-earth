// ガジェット：点の集約（クラスタ）とヒートマップ（MapLibre の cluster／heatmap 層相当・2026-09-21）。
//   描画は同一フレームのオーバーレイ（heatmap-gl.js＝WebGL2・cluster-2d.js＝canvas2D）＝エンジン本体は触らない。
//   ここ（main）は点の読み出し・MapLibre の式の評価・集約の計算だけ。式は基図と同じ評価器（ortho-core evalExpr）。
//   ズームは ortho の z（256px 世界＝MapLibre の z＋1 と同じ見た目の縮尺）。ピクセルの値（半径など）は MapLibre と同じ意味。
// heatmap(src, layer)：paint＝"heatmap-radius"(30) "heatmap-weight"(1) "heatmap-intensity"(1) "heatmap-color"(既定の青→赤) "heatmap-opacity"(1)＋minzoom/maxzoom。
//   weight は点ごと（属性・その時のズーム）・radius/intensity はズームの表（0〜24・0.5 刻み）・color は ["heatmap-density"] 0..1 の表。
// cluster(src, opts)：{ clusterRadius:50, clusterMaxZoom:14, paint:{ circle-color/-radius/-stroke-color/-stroke-width/-opacity }（集約の丸）,
//   text:{ color, size }, unclustered:{ paint } }。集約の属性＝{ cluster:true, point_count, point_count_abbreviated }（MapLibre と同じ名前）。
//   クリック＝その集約がばらけるズームへ寄る（MapLibre の getClusterExpansionZoom の定番）。
import { evalExpr, originOfLayer, lonlatTo3D } from "@ortho-earth/core";
import heatUrl from "../heatmap-gl.js?url";
import clusterUrl from "../cluster-2d.js?url";

import { ctxOf, abbr, pointsOf, heatStyle, buildClusters, clusterDraw } from "./aggregate-core.js";   // 計算部分（検定 t-aggregate が直接読む）

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
			const pts = pointsOf(src), paint = layer.paint || {}, z = map.getZoom(), origin = originOfLayer(layer), gs = map.getGlobalState?.();   // gs＝地図の global-state（#173 段 3b）
			const pos = new Float32Array(pts.length * 3), w = new Float32Array(pts.length);
			pts.forEach((p, i) => {
				const u = lonlatTo3D(p.lon, p.lat);   // β 単位球（楕円体の世界＝#43・球ではビット同値）。旧＝測地緯度をそのまま単位球へ＝楕円体で約 10km 北
				pos[i * 3] = u[0]; pos[i * 3 + 1] = u[1]; pos[i * 3 + 2] = u[2];
				const wv = evalExpr(paint["heatmap-weight"] ?? 1, ctxOf(z, p.props, origin, gs));
				w[i] = Math.max(0, +(wv === undefined && origin ? 1 : wv) || 0);   // ML の評価エラー＝既定 1・ネイティブは従来どおり
			});
			const h = ensureHeat(slot), st = heatStyle(paint, z, origin, gs);
			h.post({ type: "style", ...st, minzoom: layer.minzoom ?? -99, maxzoom: layer.maxzoom ?? 99 }, [st.ramp.buffer]);
			h.post({ type: "points", pos, w }, [pos.buffer, w.buffer]);
			return { points: pts.length };
		},
		cluster(src, opts = {}, slot = "default") {
			const pts = pointsOf(src), gs = map.getGlobalState?.();   // gs＝地図の global-state（#173 段 3b）
			const cl = buildClusters(pts, { clusterRadius: opts.clusterRadius ?? 50, clusterMaxZoom: opts.clusterMaxZoom ?? 14, clusterProperties: opts.clusterProperties, gs });
			const draw = clusterDraw(pts, cl, { ...opts, gs });
			let c = cluss.get(slot); if (!c) cluss.set(slot, c = { ov: map.overlay(clusterUrl, { name: ovName("cluster", slot) }) });
			// 層 id と層ごとの出しズーム（MapLibre の集約の層＝丸と単点で別の層・maxzoom 排他）。無指定＝従来の名前・全ズーム
			const ids = { clusters: opts.layerIds?.clusters ?? "clusters", unclustered: opts.layerIds?.unclustered ?? "unclustered-point" };
			const rg = { clusters: opts.ranges?.clusters ?? [-Infinity, Infinity], unclustered: opts.ranges?.unclustered ?? [-Infinity, Infinity] };
			const byCid = new Map(); for (const L of cl.levels) for (const it of L || []) if (it.cid != null) byCid.set(it.cid, it.ez);   // cluster_id → ばらける段（getClusterExpansionZoom）
			Object.assign(c, { draw, pts, cl, ids, rg, byCid });
			c.ov.post({ type: "range", clusters: rg.clusters, unclustered: rg.unclustered });
			if (slot === "default") ctl._cl = cl;   // 検定窓（従来の 1 枠）
			c.ov.post({ type: "levels", textLayer: opts.layerIds?.text ?? null, levels: draw.map(L => L.map(({ lon, lat, r, fill, stroke, sw, text, tc, ts, op, i }) => ({ lon, lat, r, fill, stroke, sw, text, tc, ts, op, u: i >= 0 ? 1 : 0 }))), minLevel: cl.minLevel, maxLevel: cl.maxLevel });   // u＝単点（unclustered）
			return { points: pts.length, clusters: cl.levels.map(L => L.length) };
		},
		// 画面 (x,y) の丸（今の段）＝MapLibre の集約地物の形（properties に cluster/point_count・expansionZoom）。複数の集約＝後から足した方が上
		clusterAt(x, y) {
			const z = map.getZoom();
			for (const [slot, c] of [...cluss].reverse()) {
				const L = c.draw[Math.max(0, Math.min(c.draw.length - 1, Math.floor(z) - c.cl.minLevel))] || [];
				let best = null, bd = Infinity;
				const inR = r => z >= r[0] && z < r[1];
				for (const d of L) { if (!inR(d.i >= 0 ? c.rg.unclustered : c.rg.clusters)) continue; const p = map.projectLL(d.lon, d.lat); if (p[2] < 0) continue; const dd = Math.hypot(p[0] - x, p[1] - y); if (dd <= d.r + 2 && dd < bd) { bd = dd; best = d; } }
				if (!best) continue;
				const props = best.i >= 0 ? c.pts[best.i].props : { cluster: true, cluster_id: best.cid, point_count: best.n, point_count_abbreviated: abbr(best.n), ...(best.agg || {}) };
				return { type: "Feature", properties: props, geometry: { type: "Point", coordinates: [best.lon, best.lat] }, layer: { id: best.i >= 0 ? c.ids.unclustered : c.ids.clusters, type: "circle" }, source: slot === "default" ? "cluster" : slot, expansionZoom: best.ez };
			}
			return null;
		},
		// 今の段の丸と単点で画面の内側（余白 W/4）に居る物＝MapLibre の querySourceFeatures（集約の source）の答え。W/H＝容れ物の CSS px
		sourceFeatures(slot, W, H) {
			const c = cluss.get(slot); if (!c) return [];
			const z = map.getZoom(), L = c.draw[Math.max(0, Math.min(c.draw.length - 1, Math.floor(z) - c.cl.minLevel))] || [], mx = W / 4, my = H / 4, out = [];
			for (const d of L) {
				const p = map.projectLL(d.lon, d.lat); if (p[2] < 0 || p[0] < -mx || p[1] < -my || p[0] > W + mx || p[1] > H + my) continue;
				const props = d.i >= 0 ? c.pts[d.i].props : { cluster: true, cluster_id: d.cid, point_count: d.n, point_count_abbreviated: abbr(d.n), ...(d.agg || {}) };
				out.push({ type: "Feature", id: d.i >= 0 ? undefined : d.cid, properties: props, geometry: { type: "Point", coordinates: [d.lon, d.lat] }, layer: { id: d.i >= 0 ? c.ids.unclustered : c.ids.clusters, type: "circle" } });
			}
			return out;
		},
		// cluster_id のばらける段（エンジンの z・無ければ undefined）＝MapLibre の getClusterExpansionZoom の実体
		expansionZoom(slot, cid) { return cluss.get(slot)?.byCid?.get(cid); },
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
