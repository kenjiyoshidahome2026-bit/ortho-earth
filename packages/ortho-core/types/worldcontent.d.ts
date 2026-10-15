// @ortho-earth/core/worldcontent — 世界の内容（Natural Earth の国・都市・空港・多言語名）。
/** 台帳・名前・検索の索引（ortho-data の GitHub Pages）。 */
export const WORLD_DATA: string;
export const culturalUrl: (g: string) => string;
export const culturalName: (g: string) => string;
export const WORLD_Z: Record<string, number>;
export const F: (p: Record<string, unknown>, k: string) => unknown;
export const stripJaCitySuffix: (s: string) => string;
export const fetchJsonMaybeGz: (url: string) => Promise<unknown>;
export function loadNations(): Promise<unknown[]>;
export const loadI18n: (lang: string) => Promise<Record<string, unknown> | null>;
export function loadNeCities(lang: string): Promise<unknown>;
export const countryName: (n: Record<string, unknown>, i18n: unknown, shortEn: Map<string, string> | null | undefined) => string;
export function cityName(p: Record<string, unknown>, lang: string, i18n: unknown, neCities: unknown): string;
export function shortEnNames(n: unknown, props: unknown): Map<string, string>;
export const WORLD_LABEL: { scale: number; pad: number };
export const labelSize: (px: number) => number;
export function countryLabelRule(n: Record<string, unknown>): { minZoom: number; priority: number; [k: string]: unknown };
export function cityLabelRule(p: Record<string, unknown>): { minZoom: number; priority: number; [k: string]: unknown };
export const airportLabelRule: (p: Record<string, unknown>) => { minZoom: number; priority: number };
export const PLANE_PATH: string;
