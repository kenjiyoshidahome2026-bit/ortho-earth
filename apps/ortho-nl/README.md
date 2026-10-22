# ortho-nl — オランダの 3D 建物（同じエンジン・別の国）

`@ortho-earth/japan` のエンジンに **オランダの地域パック**（`apps/ortho-japan/nl/region.js`＝PDOK 3D Basisvoorziening の建物）を渡しただけの入口。
日本固有のガジェット（地名検索・日本ボタン・デモ台本・太陽系）は載せない。`www.ortho-earth.com/nl/` で配信。

| | |
|---|---|
| URL | `/nl/` — `#z/lat/lon` の共有ビュー |
| 言語 | エンジンの UI は 26 言語（ブラウザ言語・`?lang=`）。`<head>`（題・説明・出典）は日本語のまま＝英語化は裁定待ち |
| データ | 3D Basisvoorziening（Kadaster／PDOK・CC BY 4.0）＝BAG と AHN から生成（2026-10-22 に 3DBAG から切り替え・3DBAG の配信が止まったため） |
| head | 共有カード（og:image＝www のサムネイル）・canonical・theme-color |
| 起動 | 球儀マークの起動画面（`#boot`）。エンジンが起きなければ画面に言葉で出す（`@ortho-earth/globe/page.js` の `startupFailed`） |

## 開発

```
npm run dev -w ortho-nl
npm run preview:prod -w ortho-nl    # vite build → wrangler dev
```

ブラウザ検定は未整備（www の静的検査 `tests/t-demo-pages.mjs` が head の規約だけ見る）。

License: GPL-3.0-or-later.
