// gadgets/stack.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝stack.js が TS になれば消える。

/** 左上の gadget の積み場（#gadgets） */
export function gadgetStack(mapEl: HTMLElement): HTMLElement;
/** 左下ドック（#dock） */
export function dockStack(mapEl: HTMLElement): HTMLElement;
