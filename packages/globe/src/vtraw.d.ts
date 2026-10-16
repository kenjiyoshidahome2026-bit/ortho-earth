// vtraw.js（JS のまま）の型。globe.ts が読む分だけ（TS 化 段 4・batch 3）＝vtraw.js が TS になれば消える。
import type { RawTiles } from "./gadgets/vtextrude.ts";
import type { RawTileStore } from "./types/scope.ts";

/** 生のタイルの控え（vtdraw／vtextrude が put・querySourceFeatures が decoded で読む） */
export interface RawStore extends RawTiles, RawTileStore {
	has(sid: string, key: string): boolean;
	stats(): { tiles: number; bytes: number; decoded: number };
	clear(): void;
}
export function createRawStore(budget?: number): RawStore;
