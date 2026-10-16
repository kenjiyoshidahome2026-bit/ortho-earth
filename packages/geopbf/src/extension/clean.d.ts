// src/extension/clean.js（JS のまま）の型＝.ts の読み手（encoder/gint）向け sibling 宣言（TS 化 段 3・2026-10）。clean.js を .ts にした時は消す
import type { CleanTopologyOptions, UnPackGint } from "../../types/geopbf.js";
export function cleanTopology(gintData: UnPackGint | null | undefined, options?: CleanTopologyOptions | true): void;
/** GintBUF → clean → GintBUF（読めなければそのまま返す） */
export function cleanGintBuffer(buf: ArrayBuffer | SharedArrayBuffer, options?: CleanTopologyOptions | boolean): ArrayBuffer | SharedArrayBuffer;
