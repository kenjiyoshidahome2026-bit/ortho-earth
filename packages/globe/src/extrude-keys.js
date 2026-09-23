// 押し出しの「高さの鍵」＝app.js（ドロップで自動に立てるかの判定＝初期バンドル）と gadgets/model.js（値の解決＝遅延 chunk）の共有。
// よく使われる名前を上から順に：MapLibre/OSM の height、PLATEAU/CityGML の measuredHeight、日本語の列。階数だけの列は ×3m。
// geoedit の面パネル「高さ」は height を書く＝ここで拾われる。
export const HEIGHT_KEYS = ["height", "building:height", "measuredHeight", "measured_height", "bldg_height", "HEIGHT", "Height", "建物高さ", "高さ", "計測高さ"];
export const LEVEL_KEYS = ["building:levels", "levels", "floors", "storeys", "階数", "地上階数"];
export const hasHeightKey = keys => !!keys?.some(k => HEIGHT_KEYS.includes(k) || LEVEL_KEYS.includes(k));
