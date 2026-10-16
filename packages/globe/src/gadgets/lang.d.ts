// gadgets/lang.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝lang.js が TS になれば消える。
import type { Gadgets } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";

/** UI 言語の切替。二重搭載は undefined */
export function lang(this: GlobeMap, opts?: Parameters<Gadgets["lang"]>[0] & { [k: string]: unknown }): HTMLButtonElement | undefined;
