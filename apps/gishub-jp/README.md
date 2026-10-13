# gishub-jp — 日本の公開 GIS データ

国が公開する GIS データ（国土数値情報・登記所備付地図・筆ポリゴン・統計 GIS・国勢調査・国立公園…）をブラウザで直接読み、
地球儀（`@ortho-earth/japan` の同じエンジン）に描き、各種形式へ書き出すカタログ。`www.ortho-earth.com/gishub-jp/` で配信。

| | |
|---|---|
| URL | `/gishub-jp/` |
| 言語 | 日本語のみ（UI・データ名とも）＝www のカードも `lang: "ja"` |
| データ | 各カタログ（`census/ estat/ jishin/ jma/ maff/ moj/ munic/ nlftp/ nps/ zipcode/`）＝取得スクリプトは各フォルダ、重量データは R2（`shared-data/`） |
| head | 日本語の `<head>`・共有カード（og:image＝www のサムネイル）・canonical・theme-color |

## 開発

```
npm run dev -w gishub-jp          # http://localhost:5192/gishub-jp/
```

検定は www の静的検査（`npm test -w www` → `tests/t-demo-pages.mjs`＝head の規約）のみ。ブラウザ検定は未整備（台帳 `apps/www/demos-quality.md`）。

License: GPL-3.0-or-later.
