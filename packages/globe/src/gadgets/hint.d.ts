// gadgets/hint.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝hint.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 操作説明のカード。二重搭載は undefined。close(false)＝記憶に書かずに畳む */
export function hint(this: GlobeMap, opts?: { signal?: AbortSignal; onOpen?: () => void; [k: string]: unknown }): { open(): void; close(remember?: boolean): void } | undefined;
