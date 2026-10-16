// modules/varint.js の型（TS化 段 3・convert が読む分だけ）。modules/varint.js が .ts になったらこのファイルは消す
export interface VarintCursor { pos: number }
export function readUvarint(u8: Uint8Array, c: VarintCursor): number;
export const zigzagDecode: (n: number) => number;
export function readSvarint(u8: Uint8Array, c: VarintCursor): number;
export function writeUvarint(buf: Uint8Array, pos: number, v: number): number;
export const zigzagEncode: (v: number) => number;
export function writeSvarint(buf: Uint8Array, pos: number, v: number): number;
