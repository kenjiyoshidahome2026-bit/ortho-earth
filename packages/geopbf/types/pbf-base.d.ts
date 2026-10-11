// "geopbf/pbf-base"＝器だけの GeoPBF（拡張メソッド無し）
/// <reference path="./subpaths.d.ts" />
export * from "./geopbf.js";
import type { GeoPBFBase } from "./geopbf.js";
export const GeoPBF: typeof GeoPBFBase;
export type GeoPBF = GeoPBFBase;
export function makeKeys(keys: string[], ...rest: any[]): any;
export function propsKeyOf(row: any[]): string;
export function canUseWorker(self: GeoPBFBase, factory?: (() => Worker | null) | null, url?: string | URL | null): boolean;
