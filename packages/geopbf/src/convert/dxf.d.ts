// src/convert/dxf.js の sibling 宣言（TS 化 段 3・decoder/dxf.ts が読む分だけ・2026-10）。convert/ を .ts にした段（batch F）で消す
import type { GeoPBFBase } from "../../types/geopbf.js";
export interface DxfStats { assumedLonLat?: boolean; skipped: Record<string, number>; datumApprox?: boolean; [key: string]: unknown }
export function fromDxf(src: Uint8Array, opts?: Record<string, unknown>): Promise<{ pbf: GeoPBFBase; stats: DxfStats }>;
