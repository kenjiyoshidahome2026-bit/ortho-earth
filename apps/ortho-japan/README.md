# ortho-japan（日本の 3D 地図のサイト）

https://www.ortho-earth.com/japan/ のサイト（頁・案内・検定・配備）。地図の中身は共有エンジンと `@ortho-earth/regions`。

頁のうち表紙以外（fireworks・geoedit・models・onsen・parks・pointcloud・scene・tellus・terrain）は 2026-10-24 にそれぞれ独立のアプリ（`apps/<名前>/`・package.json の `"servedAt": "/japan/"`）になった。
ここの `npm run build`（`build:prod`）は表紙を組んだ後、`packages/globe/scripts/lib/gather-apps.mjs /japan/` がそれらのアプリを build して出力を重ねる＝同じ Worker が同じ URL で配る。

埋め込み用の SDK（npm `@ortho-earth/japan`・zip・`/japan/lib/`）は [sdk/japan](../../sdk/japan) に分けた（2026-10-15）。使い方と開発の手順はそちらの README を見る。
