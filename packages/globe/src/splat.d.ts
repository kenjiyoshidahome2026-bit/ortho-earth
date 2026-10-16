// splat.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝splat.js が TS になれば消える。
export const SPLAT_FORMATS: readonly string[];
export function isSplatUrl(u: unknown): boolean;
/** addData の kind "splat" の契約（SplatData か .ply/.splat/.spz の URL）を検める */
export function normSplat(data: unknown): unknown;
