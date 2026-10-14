# choju — 鳥獣の捕獲記録

捕獲報告アプリの書き出し（2024-12〜・約 1.6 万件）を日本の 3D 地図に描く単独の頁。`www.ortho-earth.com/choju/`。
www のデモ一覧には載せない（本人裁定 2026-10-14）。エンジンは ortho-japan と同じ（`../ortho-japan/app.js`・ortho-nl と同型）。

| | |
|---|---|
| URL | `/choju/` — `?m=市区町村コード`（その市区町村に絞って飛ぶ）・`?data=URL`（CSV 2 本の置き場・末尾 /） |
| 絞り | 獣種（10）・大分類（ジビエ＝施設搬入・食肉利用・ジビエ用アプリ／捕獲＝廃棄・不明）と中の利用区分・捕獲日（から／まで・年度ボタン）・市区町村（セレクタ） |
| 点 | 獣種か大分類で色分け（切り替え）。塗り＝捕獲地点の座標・白抜き＝送信位置か補完住所の座標。押すと詳細（日時・市区町村・利用区分・体長・体重・座標・受付番号・捕獲者 ID） |
| データ | GitHub Pages の `ortho-data/japan/choju/`：`captures.csv`（1 行 1 頭）・`munis.csv`（市区町村コード → 名前）。dev は手元の正本 `ortho-data/japan/choju/` |

## 開発

```
npm run dev -w choju     # http://localhost:5199/choju/
npm test -w choju        # CSV の読みと行 → 点の変換（Node だけ）
npm run build -w choju   # dist/site/choju/（wrangler.toml の assets・route /choju*）
```

License: GPL-3.0-or-later.
