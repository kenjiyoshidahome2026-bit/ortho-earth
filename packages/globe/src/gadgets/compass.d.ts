// gadgets/compass.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝compass.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** コンパス兼リセット（3D の時だけ出る）。戻り値＝針を追わせる update（描画ごと）・二重搭載は undefined */
export function compass(this: GlobeMap, opts?: { cancelFlight?: () => void; onMove: () => void; signal?: AbortSignal; [k: string]: unknown }): (() => void) | undefined;
