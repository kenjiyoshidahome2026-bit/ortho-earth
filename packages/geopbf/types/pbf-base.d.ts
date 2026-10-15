// "geopbf/pbf-base"＝器だけの GeoPBF（拡張メソッド無し）
/// <reference path="./subpaths.d.ts" />
export * from "./geopbf.js";
import type { GeoPBFBase, MakeKeys } from "./geopbf.js";
export const GeoPBF: typeof GeoPBFBase;
export type GeoPBF = GeoPBFBase;
/** 属性の行 → [keys, bufs]（GeoPBF.makeKeys と同じ物） */
export const makeKeys: MakeKeys;
export function propsKeyOf(row: any[]): string;
/** worker 経路を使うか＝インスタンスの worker:false → クラスの配線（factory）→ その場に Worker が居るか */
export function canUseWorker(self: GeoPBFBase, factory?: (() => Worker | null) | null): boolean;
