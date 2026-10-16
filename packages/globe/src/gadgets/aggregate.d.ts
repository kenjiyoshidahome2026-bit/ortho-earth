// gadgets/aggregate.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝aggregate.js が TS になれば消える。
import type { MLLayer } from "@ortho-earth/core";
import type { GlobeMap } from "../types/map.ts";

/** 集約の丸・単点（MapLibre の集約地物の形・properties に cluster／point_count） */
export interface AggFeature {
	type: "Feature"; id?: number; properties: Record<string, unknown>; geometry: { type: "Point"; coordinates: [number, number] };
	layer: { id: string; type: "circle" }; source?: string; expansionZoom?: number;
}
/** cluster の指定（層は正規化済み＝エンジンの目盛り） */
export interface ClusterOpts extends Partial<MLLayer> {
	clusterRadius?: number; clusterMaxZoom?: number; clusterProperties?: Record<string, unknown>; unclustered?: Partial<MLLayer>;
	layerIds?: { clusters?: string; unclustered?: string; text?: string | null }; ranges?: { clusters?: [number, number]; unclustered?: [number, number] };
}
/** 点の集約とヒートマップ（slot＝addLayer の層 id・既定 "default"） */
export interface Aggregate {
	heatmap(src: unknown, layer?: Partial<MLLayer>, slot?: string): { points: number };
	/** vector source の heatmap（vtdraw-worker が集めた点＝ll は経緯度の列・w は重み） */
	heatmapPoints(ll: ArrayLike<number>, w: Float32Array, layer?: Partial<MLLayer>, slot?: string): { points: number };
	cluster(src: unknown, opts?: ClusterOpts, slot?: string): { points: number; clusters: number[] };
	clusterAt(x: number, y: number): AggFeature | null;
	sourceFeatures(slot: string, W: number, H: number): AggFeature[];
	expansionZoom(slot: string, cid: number): number | undefined;
	clear(which?: "heatmap" | "cluster" | null, slot?: string | null): void;
	readonly active: { heatmap: boolean; cluster: boolean };
	readonly slots: { heatmap: string[]; cluster: string[] };
}
export function createAggregate(map: GlobeMap, o?: { signal?: AbortSignal }): Aggregate;
