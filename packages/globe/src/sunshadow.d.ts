// sunshadow.js（JS のまま）の型。model-worker.ts が読む分だけ（TS 化 段 4・globe batch 3）＝sunshadow.js が TS になれば消える。

/** 日影・可視域の結果（rgba＝w×h の画素・bbox＝[w, s, e, n]・stats＝計算の数） */
export interface SunshadowResult { rgba: Uint8Array; w: number; h: number; bbox: number[]; probes: unknown; stats: Record<string, unknown>; [k: string]: unknown }
/** 日影（opts＝{ bbox, tilesets?, sets?, mode, date, decl?, hours, step, planeH, cell?, maxCells? }） */
export function computeSunShadow(opts: Record<string, unknown>): Promise<SunshadowResult>;
/** 可視域・見通し線（opts＝{ bbox, N, ground, observer, eyeH, targetH, radius, buildings, tilesets?, sets?, probe?, los? }） */
export function computeViewshed(opts: Record<string, unknown>): Promise<SunshadowResult>;
