// extrude-keys.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝extrude-keys.js が TS になれば消える。
export const HEIGHT_KEYS: string[];
export const LEVEL_KEYS: string[];
/** 高さ（か階数）の鍵を持つか＝ドロップで自動に押し出すかの判定 */
export function hasHeightKey(keys: readonly string[] | null | undefined): boolean;
