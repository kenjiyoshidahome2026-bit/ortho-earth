// globe.js（JS のまま＝group H）の型。src/maplibre/*.ts が読む分だけ（TS 化 段 4・batch 3）＝globe.js が TS になれば消える。
// 中身は公開の型（packages/globe/globe.d.ts）そのもの＝通訳が呼ぶのは公開面だけ（mlshim の掟）。
export { createGlobe, Marker, Popup, Compare, addProtocol, removeProtocol } from "../globe.d.ts";
