# japan-map（日本の 3D 地図＝/japan/ の表紙）

https://www.ortho-earth.com/japan/ の表紙の頁と、日本を試料に使うエンジンの検定・焼きの道具。地図の中身は共有エンジンと `@ortho-earth/regions`。
2026-10-24 までの名は `apps/ortho-japan`（頁の入れ物と配信を兼ねていた）。

/japan/ の頁はどれも独立のアプリ（`apps/<名前>/`・package.json の `"servedAt": "/japan/"`）＝この表紙もその 1 つ。自前の Worker は持たない。
配信は [`apps/japan-host`](../japan-host)（Worker の名は ortho-japan のまま）：`packages/globe/scripts/lib/gather-apps.mjs /japan/` が各アプリを build して出力を集め、`build:prod` が SDK を `/japan/lib/` に足す。本番デプロイ（訳の門・エディタ関門・verify:prod・wrangler・verify-live）も japan-host の `npm run deploy`。

埋め込み用の SDK（npm `@ortho-earth/japan`・zip・`/japan/lib/`）は [sdk/japan](../../sdk/japan) に分けた（2026-10-15）。使い方と開発の手順はそちらの README を見る。
