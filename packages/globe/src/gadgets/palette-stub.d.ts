// gadgets/palette-stub.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝palette-stub.js が TS になれば消える。
import type { Gadgets } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";

/** 配色テーマの入口（本体 palette.js はアイドルに先読み）。二重搭載は undefined */
export function palette(this: GlobeMap, opts?: {
	current?: string; onPick?: (name: string) => unknown; requestSnapshot?: () => Promise<unknown>; getZoom?: () => number; getCurrent?: () => string; signal?: AbortSignal; [k: string]: unknown;
}): ReturnType<Gadgets["palette"]>;
