// quakes-gl.js の型（手書き）。quakes-gl.js は JS のまま＝quakes.ts が ?url で URL を取り、vite がそのまま（変換せずに）置く＝
// レンダーワーカーが import() する。TS にすると素の TS が出荷されて読めない。ここは main（quakes.ts）が読む表と、オーバーレイの契約の形。
export const M_SPLIT: number;
export const DEPTH_MAX: number;
/** [t＝√(深さ/700), [r, g, b]] */
export const STOPS: [number, [number, number, number]][];
export function depthT(d: number): number;
export function depthColor(d: number): number[];
export const DEFAULTS: { magMin: number; magMax: number; size: number; faint: number; clear: number; m6km: number };
export function lambdaOf(clear: number): number;
// オーバーレイの契約（map.overlay）
export function init(canvas: HTMLCanvasElement | OffscreenCanvas, opts?: { earthM?: number }): void;
export function message(d: { type: string; [k: string]: unknown }): void;
export function frame(cam: { dpr?: number }, s: { mvp: ArrayLike<number>; eye: ArrayLike<number>; invMvp: ArrayLike<number>; focal: number }, size: { w: number; h: number }): boolean;
export function destroy(): void;
