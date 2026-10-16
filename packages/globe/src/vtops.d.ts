// vtops.js（JS のまま）の型。gadgets の vtdraw が読む分だけ（TS 化 段 4・batch 2）＝vtops.js が TS になれば消える。

/** li の帯（層の順の鍵＋副番号） */
export function liOf(key: number, sub?: number): number;
/** paint と layout（"layout:" を前に付けた鍵）を 1 つに＝ズームの鍵の材料 */
export function styleZoomProps(L: { paint?: Record<string, unknown> | null; layout?: Record<string, unknown> | null }): Record<string, unknown>;
/** 0.25 刻みに丸めた z */
export function quantZoom(z: number): number;
