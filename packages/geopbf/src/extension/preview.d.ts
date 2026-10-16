// src/extension/preview.js（JS のまま）の型＝.ts の読み手（encoder/preview）向け sibling 宣言（TS 化 段 3・2026-10）。preview.js を .ts にした時は消す
import type { GeoPBFBase } from "../../types/geopbf.js";
/** canvas へ描く（戻り＝canvas が無ければ ImageBitmap・地物が無ければ null・それ以外は描いた先） */
export function preview(self: GeoPBFBase, canvas?: OffscreenCanvas | Record<string, unknown> | null, props?: Record<string, unknown>): unknown;
