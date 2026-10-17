// 素の index.html 用の入口＝モジュール（world.js）を読んで実行するだけの薄い消費者。
// アプリとしての振る舞い（?lang= を読む・URL に書き戻す・window に作業用の手を生やす）は
// target を渡さない＝「ページの持ち物」な使い方の既定でそのまま入る。
import world from "./world.js";
import type { WorldSelector, NationId } from "ortho-world";   // 型だけ＝npm に出す型定義（sdk/ortho-world.d.ts）＝合図の形の正本

const w = await world() as WorldSelector;   // as＝JS 本体の戻りは推論（lang() の 2 つの顔が 1 つに潰れる）＝型定義の顔で読む

// 埋め込み側の見本＝ここで起きる合図。地図の部品と繋ぐならこの3本を使う（README/型定義に同じものを載せる）
// 地図＝この殻の持ち物（src/mappane.js）。合図を受けてから初めてエンジンを import する＝一覧だけ見る人には 1 バイトも降ってこない。
w.on("map", e => import("./mappane.js").then(m => m.showMap(e, { lang: w.lang(), nation: (k: NationId) => w.nation(k) } as unknown as Parameters<typeof m.showMap>[1])));   // nation＝地図の上で当たった国を一覧の言葉で引く（tip・他国クリック）。as＝showMap の引数型は JS の既定値（nation = null）からの推論
w.on("select", e => console.log("select:", e.iso2 || e.key, e.name)); // 国が選ばれた
w.on("hover", e => e && console.debug("hover:", e.iso2 || e.key));    // 一覧の上でホバー（離れると null）

Object.assign(window, { world: w });   // console から w.hover("JP") / w.select("FR") を試せる
