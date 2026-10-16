// gadgets/viewshed.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝viewshed.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 可視域と見通し線のパネル。戻り値＝開く関数（open／close つき） */
export function viewshed(this: GlobeMap, opts?: {
	run?: { viewshed(o: Parameters<GlobeMap["viewshed"]>[0]): Promise<unknown>; lineOfSight(...a: Parameters<GlobeMap["lineOfSight"]>): Promise<unknown>; clear(): unknown };
	onOpen?: () => void; minZoom?: number; signal?: AbortSignal; [k: string]: unknown;
}): (() => void) & { open(): void; close(): void };
