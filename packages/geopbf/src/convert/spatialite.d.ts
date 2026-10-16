// src/convert/spatialite.js の sibling 宣言（TS 化 段 3・decoder/spatialite.ts が読む分だけ・2026-10）。convert/ を .ts にした段（batch F）で消す
import type { GeoPBFBase } from "../../types/geopbf.js";
export interface SpatiaLiteStats { layers: string[]; layer?: string; droppedGeometries?: number; badGeometries?: number; datumApprox?: boolean; [key: string]: unknown }
export function fromSpatiaLite(u8: Uint8Array, opts?: Record<string, unknown>): Promise<{ pbf: GeoPBFBase; stats: SpatiaLiteStats }>;
