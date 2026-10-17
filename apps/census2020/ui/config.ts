// census2020 は dev プロキシを持たない＝常時 api 直（本番 www.ortho-earth.com からの CORS 越えは常用実績あり）。
export const IS_DEV    = window.location.hostname === 'localhost';
export const API_BASE  = 'https://api.ortho-earth.com';
export const TILER_BASE = 'https://tiler.ortho-earth.com';
