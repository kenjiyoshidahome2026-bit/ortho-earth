// src/convert/geoparquet.js の sibling 宣言（TS 化 段 3・decoder/parquet.ts が読む分だけ・2026-10）。convert/ を .ts にした段（batch F）で消す
import type { GeoPBFBase } from "../../types/geopbf.js";
export interface GeoParquetStats { droppedGeometries?: number; skipped: { name: string; reason: string }[]; [key: string]: unknown }
export function fromGeoParquet(u8: Uint8Array, opts?: Record<string, unknown>): Promise<{ pbf: GeoPBFBase; stats: GeoParquetStats }>;
