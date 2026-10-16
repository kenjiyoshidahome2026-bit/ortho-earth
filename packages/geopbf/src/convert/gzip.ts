// convert/gzip.js ── modules/inflate.js の gzip 専用の薄い皮（PMTiles/Parquet/tile-worker が使う）。
import { inflate, deflate, deflateMany, hasZstd } from "../modules/inflate.js";
export { hasZstd };
export const zstd = (u8, level) => deflate(u8, "zstd", level);
export const unzstd = (u8) => inflate(u8, "zstd");
export const gzip = (u8) => deflate(u8, "gzip");
export const gunzip = (u8) => inflate(u8, "gzip");
export const gzipMany = (list, concurrency = 64) => deflateMany(list, "gzip", concurrency);
