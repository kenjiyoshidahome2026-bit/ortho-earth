// style-pm.js（JS のまま）の型。globe.ts が読む分だけ（TS 化 段 4・batch 3）＝style-pm.js が TS になれば消える。
import type { MLLayer } from "@ortho-earth/core";

/** ?pm= のアーカイブの申告（pmtilesInfo の戻り）から描画規則の層 */
export function pmLayers(info: { layers?: string[] }, theme: { style?: unknown } | null | undefined): MLLayer[];
/** 層名 → 役割（"id:role" の列） */
export function pmRoles(info: { layers?: string[] }): string[];
