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
| `view` | 前回ビュー | 初期視点 `"#zoom/lat/lon/45t/30r/l=place.rail/c=dark"`（t=チルト°・r=回転°・l=点火レイヤ・c=配色テーマ） |
| `theme` | `"mono"` | 配色テーマの固定（台帳＝palettes.js）。`"mono"`=白地図（既定）／`"dark"`=黒地図（夜家具付き）／`"gsi"`=地理院地図（標準地図）配色・道路は格ごとの色帯／`"sepia"`=暖色・古地図。焼き付け＝共有URLにも書かれず `c=` でも破れない。台帳と同形のオブジェクト=カスタムテーマ（styleと色ノブの部分上書き）。未記述=共有URLの `c=<name>` で選択 |
| `layers` | — | 表示項目の固定。キー: `place`(地名) `terrain`(地形) `rail`(鉄道) `road`(道路) `facility`(施設)。`true`=常時表示・`false`=常時非表示（どちらもチップ非搭載＝利用者は触れない）、未記述=既定値から開始しチップで選択。固定キーは共有URL（`l=`）でも上書きされない |
| `chips` | `true` | テーマ・チップ帯（右上）そのものの表示。`true`=搭載（`layers` で固定したキーのボタンは出ない）／`false`=出さない。旧配列形式=選択的も後方互換で動作（非推奨） |
| `instruments` | `true` | 下部の計器盤。`true`=全部／配列=選択的／`false`=出さない。キー: `pos`(座標) `scale`(距離) `attr`(出典) `log`(デバッグ) |
| `plateau` | `true` | 建物3D（PLATEAU）の**機能スイッチ**。`false`=カタログ取得・worker・z14+の自動ロード・データ管理ガジェットを丸ごと停止（1地区数十〜百MB級の通信が一切発生しない） |

```js
const map = await orthoJapan({
  target: "#here",
  layers: { rail: true, facility: false },   // 鉄道は焼き付け・施設は封印（両方チップ非搭載）
                                             // → 残る地名・地形・道路だけが利用者のトグル
  instruments: ["scale", "attr"],   // 座標表示なし（標高照会も止まる＝通信ゼロ）
  plateau: false,                   // 建物3Dを機能ごと切る＝軽量埋め込み
});
```

旧キー（`chimei`/`chikei`/`shisetsu`）と旧共有URLの `l=` トークンは自動で読み替えられます（書き出しは常に新キー）。

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
map.gadget.palette();   // 配色テーマ切替（中央に他テーマの地図見本＝色で選ぶ）→ { open, close }。未搭載でも c= には従う
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

## 開発

UIまわりを改修したら `npm run verify:ui`（要ローカルChrome）。ガジェットスタック・起動opts・destroy・タッチ操作・狭画面の掟を headless で一括検証します（tests/*.html＝判定はページ内、scripts/verify-ui.mjs＝巡回）。

## 制約

- **1ページ1地図**：家具規格（`#map` `#search` 等の id 契約）のため、複数インスタンスは非対応。
- 動作要件：WebGL2 ＋ OffscreenCanvas（Chrome / Edge / Firefox / Safari 17+）。非対応環境では言葉で案内して止まる。
