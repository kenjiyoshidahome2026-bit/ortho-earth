// gadgets/mesh.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝mesh.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 建物 3D データ管理のボタン（onOpen＝モーダルを開く・icon＝地域の顔・labels＝地域の文言の鍵）。二重搭載は undefined */
export function mesh(this: GlobeMap, opts?: { onOpen?: () => unknown; signal?: AbortSignal; icon?: string | null; labels?: Record<string, string>; [k: string]: unknown }): HTMLButtonElement | undefined;
