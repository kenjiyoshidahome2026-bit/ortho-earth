// gadgets/edit.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝edit.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 編集ボタン（押すと mount で geoedit を部品として開く・onResult＝閉じた時の図形 buf か null） */
export function edit(this: GlobeMap, opts?: {
	mount?: (o: { onClose: () => unknown }) => unknown; onResult?: (buf: ArrayBuffer | null) => unknown; signal?: AbortSignal; [k: string]: unknown;
}): unknown;
