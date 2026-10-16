// gadgets/legend.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝legend.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 左下の凡例パネル。戻り値＝内容の setter（html・null で消す・関数＝器の要素を受け取る） */
export function legend(this: GlobeMap, opts?: { permanent?: boolean; width?: number; [k: string]: unknown }): (html: string | null | ((body: HTMLElement) => unknown)) => unknown;
