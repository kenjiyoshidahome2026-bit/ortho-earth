// @ortho-earth/core/worldstyle — 世界の基図のテーマ。
export const hex: (h: string, a?: number) => [number, number, number, number];
export const css: (v: number[], alpha?: number) => string;
export const WORLD_STYLE_THEMES: Record<string, Record<string, unknown>>;
export const WORLD_THEME_NAMES: string[];
export const normWorldTheme: (name: unknown) => string;
