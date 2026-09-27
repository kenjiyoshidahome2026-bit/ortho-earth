// MapLibre の口（src/maplibre/・公式例の門 §8）の純粋な変換（node の検定 tests/mlshim.mjs が確かめる）。
import { LngLat, LngLatBounds } from "./geo.js";

export const lngArr = ll => { const v = LngLat.convert(ll); return [v.lng, v.lat]; };
export const boundsArr = b => { const v = LngLatBounds.convert(b); return [[v.getWest(), v.getSouth()], [v.getEast(), v.getNorth()]]; };
export const camOpts = o => (o && o.center != null ? { ...o, center: lngArr(o.center) } : { ...o });
// 起動の視点＝エンジンの view 文字列（#z/lat/lon/<度>t/<度>r・**エンジンの z**＝MapLibre の z＋1＝台帳 §2 の ML_DZ）
export const viewOf = i => `#${(i.zoom + 1).toFixed(5)}/${i.center.lat}/${i.center.lng}/${i.pitch}t/${i.bearing}r`;
