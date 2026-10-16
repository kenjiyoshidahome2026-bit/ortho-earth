// model-worker（構築/再抽出/頂点数の門）の便の形＝型だけ（TS 化 段 3・2026-10）。
// 送り手（worker-rpc.ts／controller.ts）と受け手（model-worker.ts）が同じ名前で読む。
import type { TopoPayload } from "geopbf/edit/model";
import type { FeatureCollectionLike } from "geopbf/edit/topo-extract";
import type { LargeModel } from "geopbf/edit/large-model";

/** 器の GeoPBF（geopbf/pbf-base の実体＝length・getPosition と gint? を持つ）＝large-model が受ける型をそのまま借りる（worker でも読む＝DOM 型に触れないここに置く） */
export type PbfCore = LargeModel["pbf"];

/** main → worker。mode ごとに使う鍵が違う（pbf＝buffer・retopo＝payload・fc＝fc） */
export interface ModelRequest {
	mode: "pbf" | "retopo" | "fc";
	gridExp: number;
	/** mode "pbf"：geopbf バイト列（transfer）と頂点数の門 */
	buffer?: ArrayBuffer; maxVerts?: number;
	/** mode "retopo"：topoToTransfer(model, { snap:false }) の送り便 */
	payload?: TopoPayload;
	/** mode "fc"：GeoJSON FC（後方互換） */
	fc?: FeatureCollectionLike;
}
export type ModelRequestMsg = ModelRequest & { id: number };

/** 返り便＝topoToTransfer 形（snap 基底込み）＋ retopo は eids */
export type TopoReplyPayload = TopoPayload & { eids?: number[]; large?: undefined };
/** 頂点数の門を超えた＝バッファを返却して大規模モードへ */
export interface LargeReplyPayload { large: true; verts: number; buffer: ArrayBuffer }
export type ModelReplyPayload = TopoReplyPayload | LargeReplyPayload;
export type ModelReply = { id: number; ok: true; payload: ModelReplyPayload } | { id: number; ok: false; error: string };
