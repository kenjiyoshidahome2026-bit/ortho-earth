// Web メルカトル（EPSG:3857）の球半径と逆変換（重複の一本化・2026-09-16）。
export const R_MERC = 6378137;   // WGS84 長半径＝3857 の球半径
const D = 180 / Math.PI;
// メートル → [lon, lat]（度）
export const mercToLonLat = ([x, y]) => [x / R_MERC * D, (2 * Math.atan(Math.exp(y / R_MERC)) - Math.PI / 2) * D];
