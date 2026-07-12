# ortho-japan — 埋め込み・設定ガイド

国土地理院の最適化ベクトルタイルを球のまま直描きする日本地図。1行で立ち上がります。

```html
<script type="module">
  import orthoJapan from "./app.js";
  orthoJapan();   // body直下に #map を自作して起動
</script>
```

## orthoJapan(opts)

| オプション | 既定 | 説明 |
|---|---|---|
| `target` | 自作 | 埋め込み先（セレクタ or 要素）。id は `map` に正規化される（家具規格） |
| `view` | 前回ビュー | 初期視点 `"#zoom/lat/lon/45t/30r/l=chimei.rail"`（t=チルト°・r=回転°・l=点火レイヤ） |
| `chips` | `true` | テーマ・チップ（右上）。`true`=全部／配列=選択的／`false`=出さない。キー: `chimei` `chikei` `rail` `road` `shisetsu` |
| `instruments` | `true` | 下部の計器盤。`true`=全部／配列=選択的／`false`=出さない。キー: `pos`(座標) `scale`(距離) `attr`(出典) `log`(デバッグ) |
| `plateau` | `true` | 建物3D（PLATEAU）の**機能スイッチ**。`false`=カタログ取得・worker・z14+の自動ロード・データ管理ガジェットを丸ごと停止（1地区数十〜百MB級の通信が一切発生しない） |

```js
const map = await orthoJapan({
  target: "#here",
  chips: ["chimei", "rail"],        // 地名と鉄道のトグルだけ
  instruments: ["scale", "attr"],   // 座標表示なし（標高照会も止まる＝通信ゼロ）
  plateau: false,                   // 建物3Dを機能ごと切る＝軽量埋め込み
});
```

戻り値 `map` ＝ `{ cam, flyTo, renderer, mapEl, gadget, destroy }`。

### map.destroy() — 剥がす

SPA のタブ切替等で地図を撤去する時に呼ぶ。worker群・イベントリスナー・描画ループ・タイマーを全て止め、DOM を撤去する（`target` に預かった div は中身だけ空にして返す）。IndexedDB のキャッシュ（PLATEAU・標高）はオリジン資産として残す＝再訪は速いまま。

```js
const map = await orthoJapan({ target: "#here" });
// …
map.destroy();   // 完全撤収（この後もう一度 orthoJapan() で再起動できる）
```

## オプトインガジェット（map.gadget.*）

呼んだものだけが左上に生える。**呼んだ順＝上からの並び**、非表示のガジェットは上詰め。

```js
map.gadget.search();    // 地名・住所検索（地理院API・キー不要）。{ onGo } で飛び方を差し替え可
map.gadget.compass();   // コンパス兼リセット（3Dの時だけ現れる）
map.gadget.plateau();   // 建物3D（PLATEAU）データ管理（公式ロゴマーク）
map.gadget.hint();      // 操作説明カード（6秒迷った人にだけ自動表示）→ { open, close }
map.gadget("myGadget", function () { /* this = map */ });   // 自作ガジェットの登録も同じ作法
```

## 出典表記（重要）

この地図のデータは以下の利用規約に基づきます。**出典明記は表示側の義務です。**

- [国土地理院 最適化ベクトルタイル（提供実験）](https://maps.gsi.go.jp/development/ichiran.html#optbv)
- [国土交通省 Project PLATEAU](https://www.mlit.go.jp/plateau/)
- [JAXA AW3D30](https://www.eorc.jaxa.jp/ALOS/jp/dataset/aw3d30/aw3d30_j.htm)

既定では右下の `attr`（出典）がこれを名乗ります。**`instruments` から `"attr"` を外す（または `false` にする）場合、義務が消えるわけではありません**——埋め込みページの見える場所（フッター等）に、同等の出典を必ず記述してください：

> 出典：国土地理院最適化ベクトルタイル（提供実験）・国土交通省 PLATEAU・JAXA AW3D30（各データを加工して作成）

## 制約

- **1ページ1地図**：家具規格（`#map` `#search` 等の id 契約）のため、複数インスタンスは非対応。
- 動作要件：WebGL2 ＋ OffscreenCanvas（Chrome / Edge / Firefox / Safari 17+）。非対応環境では言葉で案内して止まる。
