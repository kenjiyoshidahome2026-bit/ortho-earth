export const IS_DEV    = window.location.hostname === 'localhost';
export const API_BASE  = IS_DEV ? '/api' : 'https://api.ortho-earth.com';
export const TILER_BASE = 'https://tiler.ortho-earth.com';
