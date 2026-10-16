// gadgets/clock.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝clock.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 時計の帯（共通の時計 view.clock を進める・戻し・速さ）。戻り値＝開く関数 */
export function clockGadget(this: GlobeMap, opts?: { signal?: AbortSignal; [k: string]: unknown }): (() => void) & { open(): void };
