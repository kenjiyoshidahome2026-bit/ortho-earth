// src/convert/filegdb.js の sibling 宣言（TS 化 段 3・decoder/gdb.ts が読む分だけ・2026-10）。convert/ を .ts にした段（batch F）で消す
import type { GeoPBFBase } from "../../types/geopbf.js";
export interface GdbStats { layers: string[]; layer?: string; droppedGeometries?: number; curves?: number; reprojected?: boolean; crs?: string; datumApprox?: boolean; crsUnknown?: boolean; z?: number; m?: number; skipped: { name: string; reason: string }[]; [key: string]: unknown }
/** zip の中身（File の列）→ FileGDB の読み口 */
export function gdbSourceFromFiles(files: File[]): unknown;
export function fromFileGDB(source: unknown, opts?: Record<string, unknown>): Promise<{ pbf: GeoPBFBase; stats: GdbStats }>;
