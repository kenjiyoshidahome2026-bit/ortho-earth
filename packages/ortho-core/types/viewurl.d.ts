// @ortho-earth/core/viewurl — 共有 URL の hash（エンジンの z の文字列 "#z/lat/lon/..."）。
import type { CameraPose } from "./camera.js";
export const wrapLon: (lon: number) => number;
/** "#5/35.7/139.7/45/60" などを読む。読めなければ null。 */
export function parseViewHash(h: string): Partial<CameraPose> & { extras?: string[] } | null;
export function buildViewHash(cam: CameraPose, extras?: string[]): string;
