// src/extension/gint.js（JS のまま・wasm の入口）の型＝.ts の読み手（modules/tile-load・encoder/gint・edit/large-model）が呼ぶ static だけの sibling 宣言（TS 化 段 3・2026-10）。gint.js を .ts にした時は消す
import type { GeoPBFBase } from "../../types/geopbf.js";
/** arc の集合（insertDegreeAnchors／unionArcBbox が読む） */
export interface ArcSet { count: number; buffer: BigUint64Array; meta: Uint32Array; mlen: number }
export class gint {
	/** 終端 bit（L1） */
	static TERMINAL_BIT: bigint;
	static PRECISION: number;
	/** 10^PRECISION＝度 → 整数格子 */
	static SCALE_E: number;
	/** wasm を読む（1 回だけ・何度 await してもよい） */
	static initialize(): Promise<unknown>;
	/** 整数格子 (ix, iy) → L1（終端 bit 付き） */
	static packFromInt(ix: number, iy: number): bigint;
	/** L1／L2 → [ix, iy] */
	static unpackToInt(m: bigint): [number, number];
	/** L1 → L2（8 単位丸め＋weight 6bit） */
	static toL2(L1: bigint, weight: number): bigint;
	static getWeight(m: bigint): number;
	/** arc の内部頂点を VW weight 付きの L2 に（in place） */
	static L1toL2(L1arc: BigUint64Array): void;
	static unionArcBbox(arcSet: ArcSet, bbox: number[]): void;
	static insertDegreeAnchors(arcSet: ArcSet): void;
	static topologyFullWasm(self: GeoPBFBase, formatVersion: number, shared?: boolean): ArrayBuffer | SharedArrayBuffer | null;
}
