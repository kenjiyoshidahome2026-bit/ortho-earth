// 素の index.html 用の入口＝モジュール（world.js）を読んで実行するだけの薄い消費者。
// アプリとしての振る舞い（?lang= を読む・URL に書き戻す・window に作業用の手を生やす）は
// target を渡さない＝「ページの持ち物」な使い方の既定でそのまま入る。
import world from "./world.js";

const w = await world();

// 埋め込み側の見本＝ここで起きる合図。地図の部品と繋ぐならこの3本を使う（README/型定義に同じものを載せる）
w.on("map", e => console.log("map:", e.iso2 || e.key, e.url));        // 地図アイコンが押された＝地図を出したい
w.on("select", e => console.log("select:", e.iso2 || e.key, e.name)); // 国が選ばれた
w.on("hover", e => e && console.debug("hover:", e.iso2 || e.key));    // 一覧の上でホバー（離れると null）

Object.assign(window, { world: w });   // console から w.hover("JP") / w.select("FR") を試せる
