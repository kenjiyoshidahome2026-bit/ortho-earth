// cog/worker.ts と main（cog/pool.ts・cog/index.ts）の間のメッセージ型（TS化 段 3・型だけ＝両側から import type する）
import type { LeanIfd, GeoLevel, Stretch, Lut, Composite, TargetDesc } from "./types.ts";

/** 生の圧縮バイト 1 タイル（buf===null＝sparse／欠タイル） */
export interface RawTileMsg { tx: number; ty: number; buf: ArrayBuffer | null }
/** main → worker。id は pool.submit が採番する */
export interface CogWorkerRequest {
	id?: number;
	raw: RawTileMsg[];
	ifd: LeanIfd;
	le: boolean;
	geoL: GeoLevel;
	epsg: number;
	stretch: Stretch | null;
	nodata: number | null;
	composite: Composite;
	lut: Lut | null;
	tgt: TargetDesc;
	nearest?: boolean;
	cacheKey: string;
	level: number;
}
/** worker → main（成功）。rgba は transfer */
export interface CogWorkerResult {
	id: number;
	rgba: ArrayBuffer;
	w: number;
	h: number;
	decoded: number;
	decodeMs: number;
	error?: undefined;
}
/** worker → main（失敗） */
export interface CogWorkerError { id: number | undefined; error: string }
export type CogWorkerResponse = CogWorkerResult | CogWorkerError;
