// src/extension/spatial.js（JS のまま）の型＝.ts の読み手（encoder/fgb）向け sibling 宣言（TS 化 段 3・2026-10）。spatial.js を .ts にした時は消す
import type { GeoPBFBase, LngLat } from "../../types/geopbf.js";
export const centroid: (self: GeoPBFBase, i: number) => LngLat;
export const lineLength: (self: GeoPBFBase, i: number) => number;
export const area: (self: GeoPBFBase, i: number) => number;
/** i 無し＝全地物の bbox を組んで self._bbox／self._bboxes に置く */
export function getBbox(self: GeoPBFBase, i?: number): number[];
export function bboxes(self: GeoPBFBase): number[][];
export function bbox(self: GeoPBFBase): number[];
