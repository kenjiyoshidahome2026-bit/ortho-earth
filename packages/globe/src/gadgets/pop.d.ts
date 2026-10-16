// gadgets/pop.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝pop.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";

/** 地点に紐づく吹き出し（content＝HTML・行の配列・改行つきの文字列／at＝錨 { lng, lat, x, y }） */
export interface PopFn {
	(content: string | string[] | null | undefined, at: { lng: number; lat: number; x: number; y: number; hideOffscreen?: boolean; onClose?: () => unknown } | null | undefined): HTMLDivElement | undefined;
	clear?(all?: boolean): void;
	/** 描画ごと（錨の画面の位置へ線を引き直す） */
	_update?(): void;
}
/** 吹き出し。戻り値＝pop 関数（二重搭載は no-op） */
export function pop(this: GlobeMap, opts?: { projectLL: (lon: number, lat: number) => [number, number, number]; signal?: AbortSignal; [k: string]: unknown }): PopFn;
