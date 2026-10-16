// src/extension/topology.js（JS のまま）の型＝.ts の読み手（modules/tile-load・decoder/gint・encoder/gint）向け sibling 宣言（TS 化 段 3・2026-10）。
// 公開面（"geopbf/topology"）は types/topology.d.ts＝ここはその写し（器＝GeoPBFBase で受ける）。topology.js を .ts にした時は消す
import type { GeoPBFBase, UnPackGint } from "../../types/geopbf.js";
export function topology(self: GeoPBFBase, options?: { shared?: boolean }): ArrayBuffer | SharedArrayBuffer;
export function attachLazyStreams<T extends object>(d: T): T & UnPackGint;
export function unPackGintBuffer(GintBUF: ArrayBuffer | SharedArrayBuffer | ArrayBufferView): UnPackGint | null;
export const isSharedView: (v: unknown) => boolean;
export function repackGintBuffer(d: UnPackGint): ArrayBuffer;
export function rebuildStreams(d: UnPackGint): UnPackGint;
