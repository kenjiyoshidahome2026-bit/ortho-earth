// gadgets/close.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝close.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 閉じる×（埋め込み用・ortho:close を飛ばすだけ）。二重搭載は undefined */
export function close(this: GlobeMap, opts?: { signal?: AbortSignal; [k: string]: unknown }): HTMLButtonElement | undefined;
