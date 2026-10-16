// gadgets/full.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝full.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 全画面のトグル。非対応・二重搭載は undefined */
export function full(this: GlobeMap, opts?: { signal?: AbortSignal; [k: string]: unknown }): HTMLButtonElement | undefined;
