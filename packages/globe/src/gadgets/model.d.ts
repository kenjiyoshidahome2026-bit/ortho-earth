// gadgets/model.js（JS のまま＝別の組の gadget）の型。aggregate-core.ts・symbols-core.ts が読む分だけ（TS 化 段 4・batch 2）＝model.js が TS になれば消える。
import type { ExprContext } from "@ortho-earth/core";

/** 色の式 → [r, g, b（0-255）, a（0-1）]（評価できない・色でない＝null） */
export function evalColor(e: unknown, ctx: ExprContext): number[] | null;
