// src/convert/ndjson.js の sibling 宣言（TS 化 段 3・decoder/ndjson.ts が読む分だけ・2026-10）。convert/ を .ts にした段（batch F）で消す
import type { GeoPBFBase } from "../../types/geopbf.js";
export interface NdjsonStats { lines: number; badLines: number; features: number; droppedGeometries: number; passes: number; [key: string]: unknown }
export function fromNdjson(src: Blob | Uint8Array | string, opts?: Record<string, unknown>): Promise<{ pbf: GeoPBFBase; stats: NdjsonStats }>;
