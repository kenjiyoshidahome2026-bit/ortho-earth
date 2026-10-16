// src/convert/fgb.js の sibling 宣言（TS 化 段 3・decoder/fgb.ts が読む分だけ・2026-10）。convert/ を .ts にした段（batch F）で消す
import type { GeoPBFBase } from "../../types/geopbf.js";
export interface FgbStats { rows: number; droppedGeometries: number; bigints: number; skipped: { name: string; reason: string }[]; z?: number; m?: number; reprojected?: boolean; crs?: string; datumApprox?: boolean; [key: string]: unknown }
export function fromFlatGeobuf(u8: Uint8Array, opts?: Record<string, unknown>): Promise<{ pbf: GeoPBFBase; stats: FgbStats }>;
