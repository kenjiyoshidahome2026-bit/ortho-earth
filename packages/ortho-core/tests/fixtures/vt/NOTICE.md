# bench-tile の見本（tests/fixtures/vt）— 出典

`scripts/bench-tile.mjs` が読む実タイル。検定の入力だけで、package には入らない（`files` が `tests/` を除く）。
焼き直しは `node packages/ortho-core/scripts/bake-vt-fixture.mjs`（配信元へ届く器で）。

| ディレクトリ | 出典 | 中身 |
|---|---|---|
| `tokyo-z16/` | 国土地理院 最適化ベクトルタイル（`optimal_bvmap-v1`・ベクトルタイル提供実験） | 東京駅 z16 3×3（都心＝建物・街区・道路） |
| `fuji-z13/` | 同 | 富士山 z13 2×2（郊外＝等高線・林・道路） |

層は内蔵の gsi style が読む物（`neededSourceLayers`＋建物層）だけ残し、MVT の layer を丸ごと落とすだけで再エンコードしていない。
利用は国土地理院コンテンツ利用規約（出典の明記）に従う。
