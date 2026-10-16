// gadgets/editdoc.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝editdoc.js が TS になれば消える。

/** 編集中の図形の置き場（IndexedDB）の 1 件 */
export interface EditDocRecord { buf: ArrayBuffer; name?: string; t?: number; edited?: boolean }
export function editDocLoad(): Promise<EditDocRecord | null | undefined>;
export function editDocSave(buf: ArrayBuffer, name: string): Promise<unknown>;
export function editDocClear(): Promise<unknown>;
