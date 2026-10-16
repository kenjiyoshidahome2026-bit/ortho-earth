// src/convert/epsg.js の sibling 宣言（TS 化 段 3・decoder/shape.ts が読む分だけ・2026-10）。convert/ を .ts にした段（batch F）で消す
/** EPSG 番号 → WKT（知らない番号は null） */
export function epsgToWKT(code: number): string | null;
