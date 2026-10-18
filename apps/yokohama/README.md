# yokohama — 横浜市デジタルツイン

横浜市の 3D 都市モデル（国土交通省 PLATEAU）に、防災・時間・解析を重ねる単独の頁。`www.ortho-earth.com/yokohama/`。
エンジンは ortho-japan と同じ（共有エンジンの `regions/app.js`・choju と同型）。データは焼かない＝ブラウザが配信元から直に取る。

| 面 | 中身 | 出どころ |
|---|---|---|
| まち | 18 区へ飛ぶ・名所 15 か所・名所ツアー（10 か所を巡って回り込む） | 建物＝PLATEAU（エンジンの登録簿 `plateau-sets.json`）・橋梁＝PLATEAU 横浜市 |
| 防災 | 洪水（想定最大）・高潮・津波・土砂災害警戒区域を 3D の街に重ねる（濃さ・凡例）・指定緊急避難場所（対応災害で絞る・押すと標高） | 重ねるハザードマップ（disaportaldata）・避難場所＝bucket `bousai/hinan/14.json`（census2020 と同じ焼き） |
| 時間 | 年代の航空写真（1945〜50・1961〜69・1974〜78・1979〜83・1988〜90・いま）・その時刻の建物の影（WebGPU）・冬至の日影図 | 地理院タイル |
| 解析 | 可視域・切り取り（断面・WebGPU）・一人称で歩く・距離と面積・断面図 | エンジンの機能 |

URL：`?tab=city|risk|time|tools`・`&hz=flood,hightide,tsunami,dosha`・`&era=now|1988|1979|1974|1961|1945`・`&ward=14101〜14118`・`&spot=<名所の id>`（data.ts）。今の画面をそのまま共有できる。
UI は日本語のみ。市政の中立な道具として作る（選挙・候補者・政策の中身には触れない）。

## 開発

```
npm run dev -w yokohama     # http://localhost:5201/yokohama/
npm test -w yokohama        # data.ts の台帳と URL の状態（Node だけ）
npm run build -w yokohama   # dist/site/yokohama/（wrangler.toml の assets・route /yokohama*）
```

本番は `npm run deploy:engine`（root）か Actions の deploy＝エンジンの後に他のアプリと一緒に配る（scripts/deploy-engine.mjs の APPS）。

License: GPL-3.0-or-later.
