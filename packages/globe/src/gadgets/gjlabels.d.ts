// gadgets/gjlabels.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝gjlabels.js が TS になれば消える。
import type { MLLayer } from "@ortho-earth/core";
import type { GlobeMap } from "../types/map.ts";
import type { DrawSize, GlobeCam } from "../types/scope.ts";

/** 線に沿う geojson の注記（symbol-placement line/line-center の geojson の symbol 層） */
export interface GJLabels {
	/** 層を足す／置き換える（layer＝正規化済み・src＝GeoJSON・key＝重ね順） */
	set(id: string, layer: MLLayer, src: unknown, key?: number): { features: number };
	remove(id: string): void;
	setOrder(id: string, n: number): void;
	has(id: string): boolean;
	readonly layerIds: string[];
	destroy(): void;
}
export function createGJLabels(map: GlobeMap, o: {
	cam: GlobeCam; size: () => DrawSize; dpr?: number;
	sendLabels(id: string, list: unknown[] | null, meta: { minZoom?: number | null; maxZoom?: number | null }): void;
}): GJLabels;
