// src/pbf-base.js（JS のまま・GeoPBF の器）の型＝.ts の読み手（modules／decoder／encoder／edit）に内部の欄まで見せる sibling 宣言（TS 化 段 3・2026-10）。
// 公開面は types/geopbf.d.ts の GeoPBFBase（正典）＝ここはそれに worker・edit が直に触る内部（pbf・fmap・_name …）を足すだけ。
// pbf-base.js を .ts にした時はこのファイルを消す（.ts が隣にあれば TS はそちらを読む）。
import type Pbf from "./modules/pbf.ts";
import type { GeoPBFBase, GeoPBFOptions, MakeKeys, GintOptions } from "../types/geopbf.js";

/** fmap の 1 行＝[fpos, gpos, type]。GeometryCollection（type 6）だけ [fpos, gpos, 6, garray, tarray] */
export type FMapEntry = [fpos: number, gpos: number, type: number, garray?: number[], tarray?: number[]];

/** pbf-base.js の内部（復号・符号化の worker と edit が直に触る欄・公開 API ではない） */
export interface GeoPBFInternals {
	/** ワイヤの読み書き手（decoder/moj は entry ごとに差し替える） */
	pbf: Pbf;
	fmap: FMapEntry[];
	bufs: ArrayBuffer[];
	/** 地物ごとの属性の行（keys の順・worker 復号では遅延＝undefined） */
	props: unknown[][];
	_name: string; _description: string; _license: string; _attribution: string;
	_minZoom: number | null; _maxZoom: number | null;
	/** 精度（10^n）と 10^_precision */
	_precision: number; e: number;
	_bodyPos: number; end: number;
	/** extension/spatial.js getBbox が置く */
	_bbox?: number[]; _bboxes?: number[][];
	/** ヘッダ（と skipProps でなければ属性）を読んで fmap を組む */
	getPosition(options?: { skipProps?: boolean }): Promise<this>;
	/** FEATURE 等のメッセージを直に書く（fn の中で copyGeometry／setProperties） */
	setMessage(tag: number, fn: (obj: undefined, pbf: Pbf) => void): this;
}
export interface GeoPBF extends GeoPBFBase, GeoPBFInternals {
	/** createGeopbf／geopbf/pbf が載せる拡張（器だけの時は無い） */
	gint?(options?: GintOptions): Promise<this>;
}
export const GeoPBF: { new (options?: GeoPBFOptions): GeoPBF } & typeof GeoPBFBase;
/** 属性の行 → [keys, bufs]（GeoPBF.makeKeys と同じ物） */
export const makeKeys: MakeKeys;
export function propsKeyOf(row: unknown[]): string;
/** worker 経路を使うか＝インスタンスの worker:false → クラスの配線（factory）→ その場に Worker が居るか */
export function canUseWorker(self: GeoPBFBase, factory?: (() => Worker | null) | null): boolean;
