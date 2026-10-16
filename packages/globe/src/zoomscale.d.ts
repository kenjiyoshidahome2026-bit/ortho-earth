// zoomscale.js（JS のまま）の型。TS から読む分だけ（TS 化 段 4・batch 2＝gadgets/marker.ts の RAW）＝zoomscale.js が TS になれば消える。
// 他の export（ML_DZ・zIn/zOut・MAP_MEMBERS…）を TS から読む時はここへ足す。

/** 旗つきの地図（外側の顔）から素の map へ戻る鍵（Symbol.for("ortho-earth.map.raw")） */
export const RAW: unique symbol;
/** エンジン z − MapLibre z（batch 3・globe.ts・mlfacade.ts が読む分） */
export const ML_DZ: number;
/** "mercator" の目盛りの dz（起動の視点の緯度） */
export function mercatorDz(lat: number | null | undefined): number;
/** 公開の口 → エンジン（null は素通し） */
export function zIn<T extends number | null | undefined>(z: T, dz: number): T;
/** エンジン → 公開の口（null は素通し） */
export function zOut<T extends number | null | undefined>(z: T, dz: number): T;
/** map.gadget の各ガジェットが zoom を運ぶか（"none"｜"layer"｜"engine"｜{ opts, arg? }） */
export const GADGET_MEMBERS: Record<string, (string | object) & { readonly opts?: readonly string[]; readonly arg?: number }>;
/** 起動オプションの換算（zoomMax だけ） */
export function bootOptsIn<T extends { zoomMax?: number | null }>(opts: T, dz: number): T;
/** 旗を読む（未知の値は投げる） */
export function zoomScaleOf(opts: { zoomScale?: string } | null | undefined): "ortho" | "maplibre" | "mercator";
