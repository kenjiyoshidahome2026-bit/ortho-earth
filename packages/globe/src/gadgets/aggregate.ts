// ガジェット：ヒートマップ（MapLibre の heatmap 層相当・2026-09-21）。点の集約（クラスタ）は集約の source と層（api/images.ts・2026-10-22〜）。
//   描画は同一フレームのオーバーレイ（heatmap-gl.js＝WebGL2）＝エンジン本体は触らない。
//   ここ（main）は点の読み出し・MapLibre の式の評価だけ。式は基図と同じ評価器（ortho-core evalExpr）。
//   ズームは ortho の z（256px 世界＝MapLibre の z＋1 と同じ見た目の縮尺）。ピクセルの値（半径など）は MapLibre と同じ意味。
// heatmap(src, layer)：paint＝"heatmap-radius"(30) "heatmap-weight"(1) "heatmap-intensity"(1) "heatmap-color"(既定の青→赤) "heatmap-opacity"(1)＋minzoom/maxzoom。
//   weight は点ごと（属性・その時のズーム）・radius/intensity はズームの表（0〜24・0.5 刻み）・color は ["heatmap-density"] 0..1 の表。
import { evalExpr, originOfLayer, lonlatTo3D } from "@ortho-earth/core";

import { ctxOf, pointsOf, heatStyle } from "./aggregate-core.ts";   // 計算部分（検定 t-aggregate が直接読む）
import type { MLLayer } from "@ortho-earth/core";
import type { OverlayHandle } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";

/** ヒートマップ（slot＝addLayer の層 id・既定 "default"） */
export interface Aggregate {
	heatmap(src: unknown, layer?: Partial<MLLayer>, slot?: string): { points: number };
	/** vector source の heatmap（vtdraw-worker が集めた点＝ll は経緯度の列・w は重み） */
	heatmapPoints(ll: ArrayLike<number>, w: Float32Array<ArrayBuffer>, layer?: Partial<MLLayer>, slot?: string): { points: number };
	clear(which?: "heatmap" | null, slot?: string | null): void;
	readonly active: { heatmap: boolean };
	readonly slots: { heatmap: string[] };
}

export function createAggregate(map: GlobeMap, { signal }: { signal?: AbortSignal } = {}): Aggregate {
	// slot（層の名前）ごとに 1 枚のオーバーレイ（#34・2026-09-23）＝map.addLayer の heatmap は層 id ごと・並べられる。
	// ガジェット直呼び（map.gadget.heatmap）は slot "default"＝従来どおり置き換え。オーバーレイ 1 枚＝WebGL2 のコンテキスト 1 つ（数十枚は避ける）
	const heats = new Map<string, OverlayHandle>();   // slot → overlay handle
	const ovName = (kind: string, slot: string) => slot === "default" ? kind : `${kind}:${slot}`;
	const ensureHeat = (slot: string) => { let h = heats.get(slot); if (!h) heats.set(slot, h = map.overlay({ builtin: "heatmap" }, { name: ovName("heatmap", slot) })); return h; };
	const ctl: Aggregate = {
		heatmap(src, layer = {}, slot = "default") {
			const pts = pointsOf(src), paint = layer.paint || {}, z = map.getZoom(), origin = originOfLayer(layer), gs = map.getGlobalState?.();   // gs＝地図の global-state（#173 段 3b）
			const pos = new Float32Array(pts.length * 3), w = new Float32Array(pts.length);
			pts.forEach((p, i) => {
				const u = lonlatTo3D(p.lon, p.lat);   // β 単位球（楕円体の世界＝#43・球ではビット同値）。旧＝測地緯度をそのまま単位球へ＝楕円体で約 10km 北
				pos[i * 3] = u[0]; pos[i * 3 + 1] = u[1]; pos[i * 3 + 2] = u[2];
				const wv = evalExpr(paint["heatmap-weight"] ?? 1, ctxOf(z, p.props, origin, gs));
				w[i] = Math.max(0, +((wv === undefined && origin ? 1 : wv) as number) || 0);   // ML の評価エラー＝既定 1・ネイティブは従来どおり
			});
			const h = ensureHeat(slot), st = heatStyle(paint, z, origin, gs);
			h.post({ type: "style", ...st, minzoom: layer.minzoom ?? -99, maxzoom: layer.maxzoom ?? 99 }, [st.ramp.buffer]);
			h.post({ type: "points", pos, w }, [pos.buffer, w.buffer]);
			return { points: pts.length };
		},
		// vector source の heatmap（C1・2026-10-12）＝vtdraw-worker が集めた点（ll＝経緯度の列・w＝heatmap-weight 済み）をそのまま heatmap-gl へ。style（半径・強さ・色・不透明度の表）は層の paint から
		heatmapPoints(ll, w, layer = {}, slot = "default") {
			const n = w.length, pos = new Float32Array(n * 3);
			for (let i = 0; i < n; i++) { const u = lonlatTo3D(ll[i * 2], ll[i * 2 + 1]); pos[i * 3] = u[0]; pos[i * 3 + 1] = u[1]; pos[i * 3 + 2] = u[2]; }
			const h = ensureHeat(slot), st = heatStyle(layer.paint || {}, map.getZoom(), originOfLayer(layer), map.getGlobalState?.());
			h.post({ type: "style", ...st, minzoom: layer.minzoom ?? -99, maxzoom: layer.maxzoom ?? 99 }, [st.ramp.buffer]);
			h.post({ type: "points", pos, w }, [pos.buffer, w.buffer]);
			return { points: n };
		},
		// which＝"heatmap" | 省略・slot 省略＝全部
		clear(which, slot) {
			if (!which || which === "heatmap") for (const [k, h] of [...heats]) if (slot == null || k === slot) { h.remove(); heats.delete(k); }
		},
		get active() { return { heatmap: heats.size > 0 }; },
		get slots() { return { heatmap: [...heats.keys()] }; },
	};
	signal?.addEventListener("abort", () => ctl.clear(), { once: true });
	return ctl;
}
