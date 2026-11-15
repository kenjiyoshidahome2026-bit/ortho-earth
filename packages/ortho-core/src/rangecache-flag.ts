// Range の端末キャッシュ（pmtiles-src.ts）の入切。pmtiles-src は使う時だけ読む（動的 import）ので、入切だけを先に置ける小さな置き場に分ける。
// 既定＝入。頁の URL に `?tilecache=0` があれば切。worker の中では頁の URL が見えない＝main が init で渡した値で上書きする
export const rangeCacheFlag = { on: !(typeof location !== "undefined" && /[?&]tilecache=0/.test(location.search || "")) };
