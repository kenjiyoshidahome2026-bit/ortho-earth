// src/convert/table.js の sibling 宣言（TS 化 段 3・decoder/csv.ts が読む分だけ・2026-10）。convert/ を .ts にした段（batch F）で消す
import type { GeoPBFBase } from "../../types/geopbf.js";
export interface TableStats { droppedGeometries?: number; sheets?: string[]; sheet?: string; [key: string]: unknown }
export function fromTable(src: Uint8Array, opts?: Record<string, unknown>): Promise<{ pbf: GeoPBFBase; stats: TableStats }>;
