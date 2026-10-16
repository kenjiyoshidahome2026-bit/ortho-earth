// modules/inflate.js の型（TS化 段 3・cog／convert が読む分だけ）。modules/inflate.js が .ts になったらこのファイルは消す
export type InflateFormat = "gzip" | "deflate" | "deflate-raw" | "zstd";
export function setZstdDecoder(fn: ((u8: Uint8Array) => Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>) | null): void;
export function hasZstd(): Promise<boolean>;
export function inflate(u8: Uint8Array, format?: InflateFormat): Promise<Uint8Array>;
export function deflate(u8: Uint8Array, format?: InflateFormat, level?: number): Promise<Uint8Array>;
export function deflateMany(list: Uint8Array[], format?: InflateFormat, concurrency?: number): Promise<Uint8Array[]>;
