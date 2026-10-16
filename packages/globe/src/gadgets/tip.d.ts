// gadgets/tip.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝tip.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** カーソル追従の吹き出し。戻り値＝内容の setter（行の配列・改行つきの文字列・HTML・null で消す）＝二重搭載は同じ setter */
export function tip(this: GlobeMap, opts?: { signal?: AbortSignal; [k: string]: unknown }): (content: string | string[] | null | undefined) => void;
