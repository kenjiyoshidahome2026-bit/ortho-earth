// modules/mercator.js ── Web メルカトル（EPSG:3857）の球半径と順逆変換（重複の一本化・2026-09-16、世界座標 0..1 の形も 2026-10-12・改良点 15）。
// 旧＝メートルの逆変換が proj.js / featureservice.js、0..1 の逆変換が imagequad.js / georef/transform.js / cog/warp.js に同じ式。
export const R_MERC = 6378137;   // WGS84 長半径＝3857 の球半径
const D = 180 / Math.PI, MAX_LAT = 85.05112878;
// メートル → [lon, lat]（度）
export const mercYToLat = (y) => (2 * Math.atan(Math.exp(y / R_MERC)) - Math.PI / 2) * D;
export const mercToLonLat = ([x, y]) => [x / R_MERC * D, mercYToLat(y)];
export const latToMercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat / D / 2)) * R_MERC;
export const lonLatToMerc = ([lon, lat]) => [lon / D * R_MERC, latToMercY(lat)];
// 世界座標（0..1・y 下向き＝画像タイルの z/x/y と同じ）⇄ 経緯度。緯度は ±85.05112878 で留める
export const worldYToLat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * D;
export const latToWorldY = (lat) => { const s = Math.sin(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) / D); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
export const lonToWorldX = (lon) => (lon + 180) / 360;
export const worldToLonLat = ([x, y]) => [x * 360 - 180, worldYToLat(y)];
export const lonLatToWorld = ([lon, lat]) => [lonToWorldX(lon), latToWorldY(lat)];
