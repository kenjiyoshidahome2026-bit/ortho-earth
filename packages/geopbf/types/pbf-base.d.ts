// "geopbf/pbf-base"＝器だけの GeoPBF（拡張メソッド無し）
/// <reference path="./subpaths.d.ts" />
export * from "./geopbf.js";
import type { GeoPBFBase, MakeKeys } from "./geopbf.js";
export const GeoPBF: typeof GeoPBFBase;
export type GeoPBF = GeoPBFBase;
/** 属性の行 → [keys, bufs]（GeoPBF.makeKeys と同じ物） */
export const makeKeys: MakeKeys;
export function propsKeyOf(row: any[]): string;
export function canUseWorker(self: GeoPBFBase, factory?: (() => Worker | null) | null, url?: string | URL | null): boolean;
