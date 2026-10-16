// gadgets/inspect-stub.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝inspect-stub.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

export const INSPECT_ICON: string;
/** 検査表示の入口（本体 inspect.js は初回に import） */
export function inspect(this: GlobeMap, opts?: {
	listSources?: () => Promise<unknown[]>; view?: { readonly on: boolean; set(on: boolean, o?: { background?: string }): void };
	canvas?: HTMLCanvasElement; evXY?: (e: { clientX: number; clientY: number }) => [number, number]; signal?: AbortSignal; [k: string]: unknown;
}): unknown;
