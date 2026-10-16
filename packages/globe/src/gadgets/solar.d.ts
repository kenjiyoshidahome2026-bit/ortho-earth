// gadgets/solar.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝solar.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 太陽系（ortho-solar）への口。二重搭載は undefined */
export function solar(this: GlobeMap, opts?: { url?: string; [k: string]: unknown }): HTMLButtonElement | undefined;
