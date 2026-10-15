// "geopbf/core"（軽い入口・src/core.js）＝器（pbf-base）＋共通ローダ＋gzip。拡張メソッド（centroid・identifyAt …）は無い
/// <reference path="./subpaths.d.ts" />
export * from "./geopbf.js";
import type { GeoPBFBase, MakeKeys } from "./geopbf.js";
/** geopbf/core の GeoPBF＝器だけ（geopbf/pbf の拡張メソッドは持たない） */
export const GeoPBF: typeof GeoPBFBase;
export type GeoPBF = GeoPBFBase;
/** 属性の行 → [keys, bufs]（GeoPBF.makeKeys と同じ物） */
export const makeKeys: MakeKeys;
export function propsKeyOf(row: any[]): string;
export * from "./load.js";
export function gzip(data: Blob | ArrayBuffer | ArrayBufferView): Promise<Blob>;
export function gunzip(data: Blob | ArrayBuffer | ArrayBufferView): Promise<Blob>;
export function isGzip(data: Blob | ArrayBuffer | ArrayBufferView): Promise<boolean>;
