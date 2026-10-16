// gadgets/sunshadow.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝sunshadow.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 日影のパネル（run＝map.sunShadow・live＝map.setShadows）。戻り値＝開く関数（open／close つき） */
export function sunShadow(this: GlobeMap, opts?: {
	run?: (o: Parameters<GlobeMap["sunShadow"]>[0]) => Promise<unknown>; clear?: () => unknown; live?: (o: Parameters<GlobeMap["setShadows"]>[0]) => unknown; canLive?: () => boolean; onOpen?: () => void; minZoom?: number; signal?: AbortSignal; [k: string]: unknown;
}): (() => void) & { open(): void; close(): void };
