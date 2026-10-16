// palettes.js（JS のまま）の型。globe.ts が読む分だけ（TS 化 段 4・batch 3）＝palettes.js が TS になれば消える。
import type { BaseStyle } from "./types/scope.ts";

/** 配色テーマの 1 件（style＋style 外の色ノブ）。カスタムテーマ（opts.theme の object）も同じ形 */
export interface MapTheme {
	style: BaseStyle;
	bldColor?: number[]; atmo?: number[]; coastLine?: number[]; facilityRGB: number[]; terrainRGB: number[];
	contourColor?: number[]; distColor?: number[];
	hypso?: { color: number[]; max: number; amount: number };
	worldHypso?: Record<string, unknown>;
	[k: string]: unknown;
}
export const MAP_THEMES: Record<string, MapTheme> & { mono: MapTheme };
