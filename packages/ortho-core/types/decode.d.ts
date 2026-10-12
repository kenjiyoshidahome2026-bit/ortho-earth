// @ortho-earth/core/decode — MVT の解読と取得。
export { decodeTile, loadTileFormat, registerTileFormat, tileFormatReady } from "./tileformat.js";
import type { DecodedTile } from "./tileformat.js";
export function neededSourceLayers(style: unknown): Set<string>;
export function decodeMVT(buf: ArrayBuffer | Uint8Array, need?: Set<string> | null): DecodedTile;
export function polygons(geom: number[][][]): number[][][][];
export function signedArea(c: number[][], s: number, e: number): number;
export function fetchMVT(url: string, signal?: AbortSignal | null, need?: Set<string> | null, init?: RequestInit | null, bytes?: ArrayBuffer | null, encoding?: string): Promise<DecodedTile | null>;
