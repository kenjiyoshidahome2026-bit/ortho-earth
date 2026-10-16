// gadgets/shot-stub.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝shot-stub.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 画面保存の入口（本体は初回に import）。モバイル・二重搭載は undefined */
export function shot(this: GlobeMap, opts?: { requestSnapshot?: () => Promise<unknown>; attribution?: () => string[]; signal?: AbortSignal; [k: string]: unknown }): { open(): Promise<unknown>; composite(...a: unknown[]): Promise<unknown>; close(): void } | undefined;
