// MapLibre の口（src/maplibre/・公式例の門 §8）の純粋な変換（node の検定 tests/mlshim.mjs が確かめる）。
import { LngLat, LngLatBounds } from "./geo.ts";
import type { LngLatLike, LngLatBoundsLike } from "./geo.ts";

/** 起動の視点（MapLibre の z・度） */
export interface ViewInit { center: { lng: number; lat: number }; zoom: number; pitch: number; bearing: number; roll?: number }

export const lngArr = (ll: LngLatLike): [number, number] => { const v = LngLat.convert(ll); return [v.lng, v.lat]; };
export const boundsArr = (b: LngLatBoundsLike): [[number, number], [number, number]] => { const v = LngLatBounds.convert(b); return [[v.getWest(), v.getSouth()], [v.getEast(), v.getNorth()]]; };
export const camOpts = <T extends { center?: LngLatLike | null }>(o: T | null | undefined): Omit<T, "center"> & { center?: [number, number] } => (o && o.center != null ? { ...o, center: lngArr(o.center) } : { ...o }) as Omit<T, "center"> & { center?: [number, number] };
// 起動の視点＝エンジンの view 文字列（#z/lat/lon/<度>t/<度>r・**エンジンの z**＝MapLibre の z＋dz）。dz＝目盛りの差（"mercator"＝mercatorDz(緯度)・"maplibre"＝1）
// z は丸めない（旧 toFixed(5)＝getZoom が 10 でなく 9.9999953 を返し、タイルの z の切り捨てが一段粗くなった＝o46）
export const viewOf = (i: ViewInit, dz = 1): string => `#${i.zoom + dz}/${i.center.lat}/${i.center.lng}/${i.pitch}t/${i.bearing}r${i.roll ? `/${i.roll}roll` : ""}`;
