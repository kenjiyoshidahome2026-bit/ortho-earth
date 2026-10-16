// gadgets/home.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝home.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 地域の全体へ戻るボタン（J キー）。二重搭載は undefined */
export function home(this: GlobeMap, opts?: { view?: number[]; icon?: string; label?: string; id?: string; signal?: AbortSignal; [k: string]: unknown }): HTMLButtonElement | undefined;
