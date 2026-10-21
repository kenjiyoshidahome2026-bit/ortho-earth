# yokohama — 横浜市デジタルツイン

横浜市の 3D 都市モデル（国土交通省 PLATEAU）に、観光・交通・防災・解析を重ねる単独の頁。`www.ortho-earth.com/yokohama/`。
エンジンは ortho-japan と同じ（共有エンジンの `regions/app.js`・choju と同型）。建物は 18 区とも常に出す（LOD2 の 5 区＝エンジン・残り 13 区の LOD1＝twin.ts）。市の外は薄く覆う。

| 面 | 中身 | 出どころ |
|---|---|---|
| 観光 | 地区（18 区）＝真上から区を画面の 9 割に収める・区の線と名前・名所ツアー・名所 15 か所（写真つき）・公共施設（区分ごと・押すと吹き出し） | 区の境界＝国土数値情報 N03・写真＝Wikimedia Commons・施設＝国土数値情報 P05／P29／P27／P28／P17／P18／P04 |
| 交通 | 横浜市営地下鉄（路線の色・駅番号の記号・既定で出る）・市営バスの停留所・JR と私鉄の駅と線路 | 国土数値情報 N02（鉄道）・P11（バス停留所） |
| 防災 | 洪水（想定最大）・高潮・津波・土砂災害警戒区域を 3D の街に重ねる（濃さ・凡例）・指定緊急避難場所（対応災害で絞る・押すと標高） | 重ねるハザードマップ（disaportaldata）・避難場所＝bucket `bousai/hinan/14.json` |
| 解析 | 可視域・切り取り（断面・WebGPU）・一人称で歩く・距離と面積・断面図・その時刻の影（WebGPU）・冬至の日影図 | エンジンの機能 |

旧「時間」（年代の航空写真）は継ぎ目と色むらが目立つので外した（2026-10-21）。出典は案内板に書かず地図の出典の欄にまとめる（写真の作者と使用許諾だけは写真に添える）。

台帳＝`ortho-data/japan/yokohama/`（wards・rail・bus・facilities・photos の 5 本の JSON）。組む＝`node apps/yokohama/scripts/bake-yokohama.mjs`（外部網が要る＝手元の Mac・`--inspect` で KSJ の列名を確かめる）、
置く＝`npm run publish:pages -w world-data -- --scope=japan --only=yokohama --write`。dev は手元の正本を読む。

URL：`?tab=sight|transit|risk|tools`・`&ward=14101〜14118`・`&spot=<名所の id>`（data.ts）・`&hz=flood,hightide,tsunami,dosha`・`&tr=subway,bus,rail`（既定 subway）。旧 `tab=city|time` は観光・解析へ読み替える。
UI は日本語のみ。市政の中立な道具として作る（選挙・候補者・政策の中身には触れない）。

## 開発

```
npm run dev -w yokohama     # http://localhost:5201/yokohama/
npm test -w yokohama        # data.ts の台帳と URL の状態（Node だけ）
npm run build -w yokohama   # dist/site/yokohama/（wrangler.toml の assets・route /yokohama*）
```

本番は `npm run deploy:engine`（root）か Actions の deploy＝エンジンの後に他のアプリと一緒に配る（scripts/deploy-engine.mjs の APPS）。

License: GPL-3.0-or-later.
