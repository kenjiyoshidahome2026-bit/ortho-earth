// gadgets/zoom.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝zoom.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** ズーム＋/−（zoomMin は関数も＝実行時の床）。二重搭載は undefined */
export function zoom(this: GlobeMap, opts?: { cancelFlight?: () => void; onMove: () => void; zoomMin?: number | (() => number); zoomMax?: number; signal?: AbortSignal; [k: string]: unknown }): HTMLDivElement | undefined;
