// zoomscale.js（JS のまま）の型。TS から読む分だけ（TS 化 段 4・batch 2＝gadgets/marker.ts の RAW）＝zoomscale.js が TS になれば消える。
// 他の export（ML_DZ・zIn/zOut・MAP_MEMBERS…）を TS から読む時はここへ足す。

/** 旗つきの地図（外側の顔）から素の map へ戻る鍵（Symbol.for("ortho-earth.map.raw")） */
export const RAW: unique symbol;
