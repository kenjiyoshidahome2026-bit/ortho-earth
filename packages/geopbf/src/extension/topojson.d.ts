// src/extension/topojson.js（JS のまま）の型＝.ts の読み手（encoder/topojson）向け sibling 宣言（TS 化 段 3・2026-10）。topojson.js を .ts にした時は消す
import type { GeoPBFBase, TopoFilterOptions } from "../../types/geopbf.js";
export function topojson(self: GeoPBFBase): unknown;
export function neighbors(self: GeoPBFBase, id?: number): number[] | number[][];
export function mesh(self: GeoPBFBase, opts?: TopoFilterOptions): unknown;
export function merge(self: GeoPBFBase, opts?: TopoFilterOptions): unknown;
