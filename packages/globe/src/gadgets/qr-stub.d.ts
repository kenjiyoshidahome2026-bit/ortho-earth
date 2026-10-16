// gadgets/qr-stub.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝qr-stub.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 共有 QR の入口（本体は初回に import）。二重搭載は undefined */
export function qr(this: GlobeMap, opts?: { getUrl?: () => string; signal?: AbortSignal; [k: string]: unknown }): { open(): unknown; close(): unknown } | undefined;
