// convert/gzip.js ── modules/inflate.js の gzip 専用の薄い皮（PMTiles/Parquet/tile-worker が使う）。
import { inflate, deflate, deflateMany, hasZstd } from "../modules/inflate.ts";
export { hasZstd };
export const zstd = (u8: Uint8Array, level?: number): Promise<Uint8Array> => deflate(u8, "zstd", level);
export const unzstd = (u8: Uint8Array): Promise<Uint8Array> => inflate(u8, "zstd");
export const gzip = (u8: Uint8Array): Promise<Uint8Array> => deflate(u8, "gzip");
export const gunzip = (u8: Uint8Array): Promise<Uint8Array> => inflate(u8, "gzip");
export const gzipMany = (list: Uint8Array[], concurrency = 64): Promise<Uint8Array[]> => deflateMany(list, "gzip", concurrency);
