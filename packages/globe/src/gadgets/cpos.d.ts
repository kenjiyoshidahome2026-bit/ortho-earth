// gadgets/cpos.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝cpos.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 現在地（GPS）。戻り値＝印を追わせる update（描画ごと）・二重搭載は undefined */
export function cpos(this: GlobeMap, opts?: { projectLL: (lon: number, lat: number) => [number, number, number]; signal?: AbortSignal; [k: string]: unknown }): (() => void) | undefined;
