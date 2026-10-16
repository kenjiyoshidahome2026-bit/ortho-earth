// @ortho-earth/react の純関数（検定は node・tests/t-react.mjs）：props の差分と、差分を map へ写す手順。React に依らない
import type { ReactNode } from "react";
import type { GlobeMap, MapLibreLayer, MapLibreSource, StyleExpression } from "@ortho-earth/globe";

/** <Layer> の props＝MapLibre の層の spec（source は親の <Source> から省ける）＋React だけの props */
export type LayerProps = Omit<MapLibreLayer, "source"> & { id: string; beforeId?: string; source?: string | MapLibreSource; children?: ReactNode };
/** <Data> の props＝map.addData の data と opts（kind・id・accessor） */
export interface DataProps { id?: string; kind?: string; data: unknown; children?: ReactNode; [accessor: string]: unknown }
/** syncLayer が触る map の口（検定は偽の map で呼ぶ） */
export type LayerSyncMap = Pick<GlobeMap, "setPaintProperty" | "setLayoutProperty" | "setFilter" | "setLayerZoomRange">;
type Rec = Record<string, unknown>;

export const shallowEqual = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	const ra = a as Rec, rb = b as Rec, ka = Object.keys(ra), kb = Object.keys(rb);
	return ka.length === kb.length && ka.every(k => Object.is(ra[k], rb[k]));
};
// 2 つの object の違う鍵（消えた鍵は値 undefined で出る）＝setPaintProperty(id, name, undefined) が既定へ戻す
export const diffProps = (prev: Rec = {}, next: Rec = {}): Rec => {
	const out: Rec = {};
	for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) if (!Object.is(prev[k], next[k]) && !deepEqualJSON(prev[k], next[k])) out[k] = next[k];
	return out;
};
const deepEqualJSON = (a: unknown, b: unknown): boolean => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };
// 層の props の変化を map へ：paint/layout は鍵ごとに set*Property、filter は setFilter、minzoom/maxzoom は setLayerZoomRange。
// type/source/source-layer が変わる時は作り直し（戻り値 "recreate"）＝呼び手が remove → add する
export const syncLayer = (map: LayerSyncMap, id: string, prev: MapLibreLayer, next: MapLibreLayer): "recreate" | string[] => {
	if (prev.type !== next.type || prev.source !== next.source || prev["source-layer"] !== next["source-layer"]) return "recreate";
	const touched: string[] = [];
	for (const [k, v] of Object.entries(diffProps(prev.paint, next.paint))) { map.setPaintProperty(id, k, v as StyleExpression | undefined); touched.push("paint." + k); }
	for (const [k, v] of Object.entries(diffProps(prev.layout, next.layout))) { map.setLayoutProperty(id, k, v as StyleExpression | undefined); touched.push("layout." + k); }
	if (!deepEqualJSON(prev.filter, next.filter)) { map.setFilter(id, next.filter ?? null); touched.push("filter"); }
	if ((prev.minzoom ?? 0) !== (next.minzoom ?? 0) || (prev.maxzoom ?? 24) !== (next.maxzoom ?? 24)) { map.setLayerZoomRange(id, next.minzoom ?? 0, next.maxzoom ?? 24); touched.push("zoom"); }
	return touched;
};
// Layer の props から MapLibre の層の spec を作る（React だけの props を除く）。source は props か親の <Source>（どちらも無ければ null のまま＝addLayer が検める）
export const layerSpecOf = ({ id, beforeId, source, children, ...rest }: LayerProps, ctxSource: string | null): MapLibreLayer => ({ id, source: (source ?? ctxSource) as MapLibreLayer["source"], ...rest });
// Data の props を data・accessor（map.addData の opts）に分ける
export const splitDataProps = ({ id, kind, data, children, ...acc }: DataProps): { id?: string; kind?: string; data: unknown; acc: Rec } => ({ id, kind, data, acc });
