// @ortho-earth/core/geodesic — WGS84 の測地距離・面積（Karney は geopbf 側）。
export const WGS84: { a: number; b: number; f: number; e2: number };
/** 面積等価球の半径 ≈ 6371007.18 m */
export const AUTHALIC_R: number;
export function primeVerticalRadius(latDeg: number): number;
export function meridionalRadius(latDeg: number): number;
/** 2 点間の測地距離［m］。p＝[lon, lat]。 */
export function geodesicDistance(p1: [number, number], p2: [number, number]): number;
/** 環の測地面積［m²］（符号つき・反時計回り正）。 */
export function geodesicArea(ring: [number, number][] | number[][]): number;
