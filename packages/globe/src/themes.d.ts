// themes.js（JS のまま）の型。globe.ts が読む分だけ（TS 化 段 4・batch 3）＝themes.js が TS になれば消える。
import type { BaseStyle, Themes } from "./types/scope.ts";

export const CHOME_MINZOOM: number;
export const CHOME800_MINZOOM: number;
export const RAILTR_MINZOOM: number;
/** 表示項目（チップ）の既定 */
export const defaultLayerState: Record<string, boolean>;
export function isTerrain(code: number): boolean;
export function isFacility(L: { code: number; text?: unknown }): boolean;
/** style の点火層の添字を焼いた分類（hiddenLi・filterLabels） */
export function createThemes(style: BaseStyle, opts?: { suppressAdmin?: boolean }): Themes;
