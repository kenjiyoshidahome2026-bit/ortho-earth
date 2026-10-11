// "geopbf"（full の入口・src/index.js）の型。器と拡張の定義は ./geopbf.d.ts、残りの subpath は ./subpaths.d.ts（省略宣言）
/// <reference path="./subpaths.d.ts" />
export * from "./geopbf.js";
import type { GeoPBF, GeopbfFn, GeopbfInput, GeopbfOptions, CreateGeopbfOptions, WorkerFactory } from "./geopbf.js";

/** 入口を作る（apiBase＝bucket の API・無ければ undefined）。worker の配線と IDB の控えはここで決まる */
export function createGeopbf(apiBase?: string, options?: CreateGeopbfOptions): GeopbfFn;
/** createGeopbf() を呼んだ後に使える旧来の入口（呼ぶ前は throw） */
export function geopbf(input: GeopbfInput, options?: GeopbfOptions | string): Promise<GeoPBF | null>;
/** 呼び手の鍵（geopbf(input, { cacheKey })）で置いた控えを引く。無い・期限切れ＝null */
export function geopbfCached(key: string, options?: { gint?: boolean; maxAge?: number; name?: string }): Promise<GeoPBF | null>;
/** 呼び手の鍵で置いた控えを掃除する（prefix は必須） */
export function geopbfCachePrune(options: { prefix: string; maxAge?: number; maxEntries?: number; maxBytes?: number }): Promise<{ removed: number; kept: number; bytes: number } | null>;
/** worker の入口を外から差し替える（null＝既定へ戻す） */
export function setWorkerFactory(fn: WorkerFactory | null): void;
