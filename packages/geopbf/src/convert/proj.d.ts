// src/convert/proj.js の sibling 宣言（TS 化 段 3・decoder/shape.ts が読む分だけ・2026-10）。convert/ を .ts にした段（batch F）で消す
/** WKT の判定結果＝kind（"lonlat"・"projected" …）・label・経緯度への変換（経緯度ならなし） */
export interface CrsInfo { kind: string; label?: string; toLonLat?: (p: number[]) => number[]; [key: string]: unknown }
export function crsFromWKT(wkt: string, opts?: Record<string, unknown>): CrsInfo;
