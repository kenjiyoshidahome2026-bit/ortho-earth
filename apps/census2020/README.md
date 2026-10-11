# census2020 — 国勢調査 2020 を球で読む

2020 年国勢調査を丁目（小地域）まで 3D 日本地図でドリルダウンし、筆ポリゴン・防災（避難場所・土砂・洪水）・PLATEAU を重ねる。
エンジンは `@ortho-earth/japan`（`../ortho-japan/app.js`）をこのアプリの束に焼く。`www.ortho-earth.com/japan/census2020/` で配信。

| | |
|---|---|
| URL | `/japan/census2020/` — `#z/lat/lon` の共有ビュー |
| 言語 | パネルは日本語のみ（www のカードも `lang: "ja"`）。エンジンの UI 文言はブラウザ言語（`?lang=`）に従う |
| データ | e-Stat 小地域・国土数値情報・法務省登記所備付地図ほか（出典は画面右下）＝重量データは R2（`gishub-jp/shared-data`） |
| head | 日本語の `<head>`・共有カード（og:image＝www のサムネイル）・canonical・theme-color |
| 起動 | 球儀マークの起動画面（`#boot`）。エンジンが起きなければ画面に言葉で出す（`@ortho-earth/globe/page.js` の `startupFailed`） |

## 開発

```
npm run dev -w census2020
npm run verify:prod -w census2020   # 本番の束を実 Chrome で起動する門（deploy の必須ゲート）
```

License: GPL-3.0-or-later.
