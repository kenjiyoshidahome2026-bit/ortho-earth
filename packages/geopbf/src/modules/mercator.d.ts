// modules/mercator.js の型（TS化 段 3・cog／convert が読む分だけ）。modules/mercator.js が .ts になったらこのファイルは消す
export const R_MERC: number;
export const mercYToLat: (y: number) => number;
export const mercToLonLat: (xy: readonly number[]) => [number, number];
export const latToMercY: (lat: number) => number;
export const lonLatToMerc: (lonLat: readonly number[]) => [number, number];
export const worldYToLat: (y: number) => number;
export const latToWorldY: (lat: number) => number;
export const lonToWorldX: (lon: number) => number;
export const worldToLonLat: (xy: readonly number[]) => [number, number];
export const lonLatToWorld: (lonLat: readonly number[]) => [number, number];
