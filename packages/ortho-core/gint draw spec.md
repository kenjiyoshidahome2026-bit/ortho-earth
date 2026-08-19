# Gint v2 描画定義仕様（draft v0.1）

対象は gint v2（ortho-core）の**描画定義＝APIインターフェース**。ワイヤ書式（GeoPBF）には一切触れない。
v1（ortho-map gint）は現状のまま仕様として存続し、本仕様とは混ざらない。

**実装は次バージョンへ（裁定 2026-08-19）**。現行の単一スロット実装の都合がこの仕様へ逆流しないための
線引きは **§10**（何を昇格させてはならないか・layer 単位にすべき属性・合成の位置づけ）。着手する時はそこから読む。

## 1. 目的と非目標

**目的**
- 敷居を下げる：maplibre の語彙（paint プロパティ・data-driven 式）の**知識がそのまま通じる**サブセットを提供する
- 描画定義の変更（コロプレス軸切替・フィルタ）を**ジオメトリ再構築ゼロ**で成立させる
- 離散的データ（全国散在の小ポリゴン多数＝土砂災害警戒区域級）を性能の一級市民とする（v1 の弱点を再現しない）

**非目標**
- maplibre との drop-in 互換（style.json 全域・plugin・symbol/label・タイル）は追わない。ラベル・背景はMVT側の仕事
- 式の完全実装。サブセットを明文化し、必要が生じた物から増やす

## 2. 位置づけ（3層）

```
ワイヤ   : GeoPBF（真実源・不変・位相を含む）
派生     : 辺メタ/境界メタ/tier/bbox台帳/スタイル表 ＝ 使い捨て描画キャッシュ。
           初回ロードで構築し GPU レイアウトのまま IDB へ焼く。IDB バージョンで作り直し自由
表面     : 本仕様の API。書式ではなく API がインターフェース
```

## 3. 描画モデル

- **source** = GeoPBF（IF は常に FeatureCollection）。properties はスタイル評価の入力
- **layer** = 1 つの gint データ＋描画定義（paint / filter）。fid（feature index）が全テーブルの添字
- **fid 整列の契約**：式評価の入力は「fid → properties」の**整列配列**（identify と同じ getFeature/getProperties 系）。
  `.geojson` は壊れ geometry の feature をスキップして配列を**詰める**ため fid とズレる＝式評価に使ってはならない
  （札幌 aigid 実データで実証：数件の欠落で全 fid が横滑りし、コロプレスの対象が隣の feature に化けた）。
  読めない feature の props は {}＝既定値評価（§6-4 と同じ縮退）
- スタイルは**評価済みの結果だけが GPU に渡る**：式は setPaint / setFilter 時に JS で全 feature へ一括評価し、
  fid 添字のスタイルテーブル（テクスチャ）へ焼く。描画ループに式評価は存在しない

## 4. API 面（動詞は maplibre に揃える）

```js
const layer = map.addGint(source, {
  paint:  { 'fill-color': ['interpolate', ['linear'], ['get', 'pop'], 0, '#fee', 1e6, '#900'],
            'line-color': '#333', 'line-width': 0.8 },
  filter: ['==', ['get', 'pref'], '07'],   // 省略時=全表示
  overlap: 'auto',                          // 被覆宣言: true|false|'auto'（§7.2。既定'auto'=初回実測）
  interactive: true,                        // 利用者の入力（click/hover）を拾うか（既定 true。§4.1）
  minZoom, maxZoom, drape, tip,             // ★全て layer の属性（「スタック全体の設定」は作らない・§10.3）
});
layer.setPaint(partialPaint);   // 差分更新可。コスト=式再評価+texSubImage2D 1回
layer.setFilter(expr | null);
layer.on('click' | 'hover', ({ fid, feature, lngLat }) => {});
layer.query(lngLat)  → feature | null      // 明示照会（プログラム経路＝interactive に依らず常に効く）
layer.activate();               // カーソル（hover/tip/ハイライト）を持つ＝常にただ1層（§4.1）
layer.remove();

map.activeLayer                 // 現在アクティブな layer（null 可）
map.queryAll(lngLat) → [{ layer, fid, feature }]   // 層をまたぐ照会（手前の層から）
map.on('click', ({ lngLat, hits }) => {});          // hits = queryAll と同型（手前の層から）
```

### 4.1 アクティブ層 ── **カーソルは1層・照会は層をまたぐ**（裁定 2026-08-19）

`interactive`（識別に参加するか）と **active**（カーソルを持つか）の二軸で決める。**active は常にただ1層**。

| | `interactive:false` | `interactive:true`・非アクティブ | **アクティブ**（1層） |
| :--- | :---: | :---: | :---: |
| hover / tip / ハイライト | — | — | ○ |
| click（`layer.on('click')`・`map.on('click')`） | — | ○ | ○ |
| `layer.query(lngLat)` | ○ | ○ | ○ |

**なぜ hover だけ絞るか＝コスト構造が違う**。hover は連続（`MOVE_THROTTLE_MS`＝32ms 毎）で、
安さと曖昧さゼロが要る——そもそも tip は1つしか出せない。click は稀＝層数に比例した照会を払える。
実装上これは大きい：**連続経路が常に1層なら pick バッファは1枚のまま**でよく、`activeId`（ハイライト）・
`_moveTimer`・`lastMX/lastMY` も据え置ける（§10.1）。全層を識別に参加させると pick を層数ぶん焼くか
ID バッファへ layer チャンネルを足すことになり、`renderPickingBuffer` と `idfill` の作り直しが要る。

- **既定のアクティブ** = 最後に `addGint` した `interactive:true` の層（「今載せたデータを見たい」）。
  `layer.activate()` で移す。アクティブ層を `remove()` したら、残る interactive な層のうち最後に足された物へ落ちる（無ければ null）
- **戻り値の形**：hover はアクティブ層が確定しているので `fid` で足りる。**層をまたぐ経路
  （`map.queryAll` / `map.on('click')`）は必ず `{ layer, fid }` の対で返す**——fid は layer 内の添字であり、
  層をまたいで衝突する（§10.2）
- **順序**：手前の層から（gint 層は追加順に重なる＝後の層が上）。同一層内で複数ヒットする場合の扱いは §7.2 の pick に従う
- `interactive` は利用者の**入力**の話。`layer.query()` はプログラムからの明示照会なので `interactive:false` でも効く
- maplibre は `queryRenderedFeatures` が全層から返す＝この規約は**意識的な逸脱**（§1「drop-in 互換は追わない」）。
  GIS デスクトップ（QGIS/ArcGIS）の「アクティブレイヤ」＝利用者が既に持っている概念に寄せる

## 5. paint プロパティ（初期サブセット）

| プロパティ | 型 | data-driven | 実体 |
| :--- | :--- | :---: | :--- |
| `fill-color` | color | ○ | fid表 R（RGBA8） |
| `fill-opacity` | number 0-1 | ○ | fill-color の A へ合成 |
| `line-color` | color | ○ | fid表 G（RGBA8） |
| `line-opacity` | number 0-1 | ○ | line-color の A へ合成 |
| `line-width` | number px | ○ | fid表 B（u8, 1/8px 単位 0–31.9px） |
| `line-dasharray` | [dash, gap] px | △（dash-id 256種） | fid表 B（u8）→ dash パレット |
| `circle-color` | color | ○ | point 系。fid表 G を共用 |
| `circle-radius` | number px | ○ | fid表 B（u8, 1/4px 単位） |
| `visibility` | 'visible'/'none' | —（layer 単位） | draw スキップ |

色は CSS 色文字列（`#rgb/#rrggbb/#rrggbbaa/rgb()/hsl()`）を受ける。

## 6. 式（expression）初期サブセット

```
リテラル / ['get', key] / ['match', in, …cases, fallback] / ['step', in, base, …stops]
['interpolate', ['linear'], in, …stops] / ['case', cond, out, …, fallback]
比較: ['==' '!=' '<' '<=' '>' '>=', a, b] / ['zoom']（制約下記）
```

**評価規約**
1. 式は **setPaint / setFilter 時に一括評価**。結果は fid 表へ焼かれ、フレーム毎コストはゼロ
2. `['zoom']` は **data-driven でないプロパティに限り**許可し、毎フレーム uniform で解決
   （例：`'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 15, 2]` は可）
3. `['zoom']` × `['get']` の**合成は初期版では非対応**。合成＝1式の出力が zoom と属性の両方に依存する形
   （例：`['interpolate',['zoom'], 5, ['match',['get','class'],…], 15, ['match',…]]`＝ズーム停留値が属性で変わる）。
   逃げ道：restyle は安い（§8.1）のでアプリがズーム閾値で setPaint を呼び直せば等価。
   将来経路も既知：zoom 停留ごとの fid 列を焼きシェーダで列間 lerp（maplibre composite と同型）
4. 評価エラー・型不一致はその feature をプロパティ既定値へフォールバック（throw しない）

## 7. 実装契約（内部仕様。API 利用者は読まなくてよい）

### 7.1 fid スタイル表
- RGBA32UI テクスチャ、1 texel / fid：`R=fill色 G=line/circle色 B=width|dash|radius|flags A=予備`
- flags: bit0 = visible（filter の実体）。他は予備
- width は**正味のスタイル幅のみ**を焼く。パス都合の増分（active ハイライト +2px・pick マージン 12px×dpr）は
  uniform で加算し、表には混ぜない（u8 レンジ超過の回避と関心の分離）
- width=0 は「線を描かない」（VS 棄却）。塗りのみ feature の表現
- 分解能/レンジが実運用で不足した場合は A 列へ f16 移設可（レイアウト互換の逃げ道＝安い決定）
- 更新は texSubImage2D 一回のみ。メタ・tier・ジオメトリに触れることを**仕様として禁止**
- 規模感：1,919 市区町村=31KB / 100万 feature=16MB

### 7.2 塗り機構の選択（被覆×式の形から自動決定）

塗りは常に nonzero winding（NOTEQUAL 0）系であり、**偶奇（even-odd）は使わない**。
リング向き正規化の下で、複数 feature の重ね書きは画素値=被覆数となり、NOTEQUAL 0 は
**合併（OR塗り）と厳密一致**する（穴の上に別 feature が乗るケースも正しい）。
＝素性の悪い重複データ（災害系・MOJ 重複登記）への耐性は winding 機構の側に元からある。

| 被覆 | fill-color の式 | 機構 |
| :--- | :--- | :--- |
| 非重複 | 任意（連続 `interpolate` 可） | **winding 和 ID バッファ**：fan 三角形を FS で `gl_FrontFacing ? +(fid+1) : -(fid+1)`、R32F 加算 → 画素値=fid+1 → 解決パスで fid→スタイル表。2パス・色数非依存 |
| 重複あり | 離散（literal / match / step / case、出力クラス ≤16） | **クラス別 nonzero OR**：クラス k の feature だけ stencil に巻き（fid表の class で VS 判定）NOTEQUAL 0 で塗る × クラス数パス。優先順=パス順（後勝ち） |
| 重複あり | 連続（interpolate × get） | **仕様エラー**（重畳画素の色が意味論として定義不能）。step/match 化を促すメッセージを返す |

- 被覆の判定：layer option `overlap: true | false | 'auto'`（既定 'auto'）。'auto' は**初回ロード時に
  winding プローブで実測**（被覆数>1 の画素の有無。v1 STENCIL_DEBUG の自動化）し、IDB メタへ焼く
- pick：ID バッファ経路は readPixels 1 回。union（重複）経路は JS レイキャスト＝**複数ヒットを配列で返す**
  （重なった区域を全部返す。災害系ではそれが正しい応答）
- ID バッファの前提と退避：EXT_float_blend → 無ければ RGBA16F（fid<2048）→ それも無理なら
  クラス別 nonzero OR に降格（離散化して表示は維持）

### 7.3 事前計算の3層原則
- **データ純関数は焼く**：リング正規化・辺メタ・境界メタ・tier（整数 rank 刻み＝lodSnap 歩行ゼロ）・bbox 台帳・
  Morton 展開（GPU アップロード境界で平置き (ix,iy) へ＝unpack は入口一回）・rankA/anti フラグの辺メタ埋込
- **カメラ依存は毎フレーム1回に共有**：投影・snap は前段パス（TF）で辺あたり1回、全描画パスが共有。
  feature 単位の少数量（扇要投影等）は CPU double → 小テクスチャ
- **3D 座標の事前焼きは禁じ手**（float32 量子化）。整数経緯度＋RTE を維持

## 8. 性能要件（受け入れ基準）

1. **restyle**（setPaint/setFilter）: O(features) の JS 評価＋テクスチャ更新 1 回のみ。60fps 中に実行して落ちない
2. **毎フレーム GPU 仕事は可視 feature に比例**させる（feature bbox カリング＋pivotClip）。
   全辺数比例のパス（v1 stencil 全密度・全 VS 空回し）を作らない
3. **基準ベンチに離散データを含める**：全国散在の小ポリゴン群（土砂災害警戒区域級・共有 arc なし・
   tier 発火閾値未満の中規模・**重複被覆＝union 塗り経路**）。v1 で遅い型がそのまま検収条件
4. ID バッファ塗りはパス数が色数に非依存（コロプレス 1,919 色でも 2 パス）

## 9. 決定点（**全点裁定済み 2026-07-25**：以下の案どおり確定。次はプロトタイプで裏取り→v1.0 へ）

| # | 論点 | 案 |
| :--- | :--- | :--- |
| 1 | 式サブセットの範囲 | §6 の初期集合で開始（coalesce/in/文字列演算は保留） |
| 2 | zoom × data-driven 合成 | 初期版では非対応。必要が立証されたら再評価時機ごと導入 |
| 3 | 拡張機能の下限 | EXT_float_blend 前提＋二段フォールバック（§7.2）で良いか |
| 4 | line-width 分解能 | u8×1/8px（最大 31.9px）で足りるか |
| 5 | API 動詞 | maplibre 同名（setPaint/setFilter/on/query）で確定して良いか |
| 6 | 被覆の既定 | `overlap:'auto'`＝初回ロード時の winding プローブ実測（IDB メタへ焼く）で良いか |
| 7 | 重複×連続式 | 仕様エラーで弾く（黙って壊れた色を出さない）で良いか |
| 8 | 識別の層またぎ（**追加裁定 2026-08-19**） | **hover/tip/ハイライトはアクティブ1層・click/query は層をまたぐ**（§4.1）。根拠＝コスト構造（hover は連続・tip は1つ／click は稀）と、連続経路が1層なら pick 機構を据え置ける実装上の利得。「クリックもアクティブ1層へ寄せる」案は不採用＝『この筆は土砂かつ洪水』という重ね合わせ照会（census2020 の一級のユースケース）を落とすため |

## 10. 単一スロット（現行実装）との境界 ── **v2 仕様を汚さないための線引き**

裁定 2026-08-19：**本仕様の実装は次バージョンへ送る**。送る以上、現行の単一スロット実装の都合が
この仕様へ逆流しないよう、何が「現行の都合」で何が「v2 の契約」かをここで固定する。

### 10.1 構造的な壁（実装を送る理由）

`src/gl/gint/state.js` の `s` は**モジュールシングルトン**であり、9臓器（programs / textures / passes /
identify / idfill / drawdata / fbo / utility / embed ≒3,000行）が直接読み書きしている。
＝エンジンは構造的に1層しか持てない。現行は `userGint`（ユーザー層）と `coastGint`（世界海岸線）が
zoom（`GINT_SWAP_Z=7`）で1スロットを奪い合う。**§4 の API は複数レイヤ共存が前提**なので、
実装には `s` の脱シングルトン（per-layer インスタンス化）が先行する。

**ただし割るのは3ブロックのうち1つだけでよい**（§4.1 の裁定＝カーソルは常に1層、の実装上の利得）：

| ブロック | 扱い | 主なフィールド |
| :--- | :--- | :--- |
| データ・スタイル | **層ごとに割る** | `arcTex` `metaTex` `ptTex` `metaTexB` `totalEdges*` `polyEdges*` `fidStyleTex/W/Count` `pivotTex` `lodTiers` `metaChunks` `fillOff` `tiersDone` `polyEdgeByFid` `polyBboxByFid` `minZoom/maxZoom` `gintData` |
| GL 基盤 | 据え置き | `canvas` `gl` `dpr` `width/height` `programs` `TEX_ARC_W` `baseFBO` 一式 `embedded` `requestDraw` |
| 識別・カーソル | **据え置き**（§4.1） | `pickFBO` `pickColorTex` `pickDepthStencilRBO` `activeId` `lastMX/lastMY` `_moveTimer` `_pendingMove` `_inRange` `lastViewBbox` `cam` |

第1ブロックの GPU リソース（テクスチャ・tier 梯子）は層ごとに増えるため、`fallback-ladder.md` の
メモリ天井の再調律とセット。第3ブロックが据え置ける＝`renderPickingBuffer` と `idfill` は無改造で通る。

### 10.2 v2 の API に**昇格させてはならない**現行の口

以下は単一スロット前提の v1 動詞であり、`map` 直下に生えている。派生アプリ（census2020 等）の
現行の足場として残すが、**§4 の layer API と混ぜない・改名して再利用しない**。

| 現行の口 | なぜ v2 に持ち込めないか |
| :--- | :--- |
| `map.applyGintData(pbf, label, moveCamera, opts)` | 「唯一のスロットを置き換える」動詞。v2 の `addGint` は**追加**であって置換ではない |
| `map.paintTable(u32, count)` | fid 表の生バイト直書き＝スロットが1つだから成立する。v2 は layer 単位の `setPaint`（式）が正面口 |
| `map.paint(paint, filter)` | 引数に layer の指定が無い＝暗黙の「今のスロット」。v2 は `layer.setPaint()` |
| `map.gintFeatures()` | 同上。fid 空間が1つしか無い前提 |
| `map.standupGint(liftM)` | ドレープ設定がスタック全体に掛かる。v2 は layer の属性 |
| `map.onGintClick(fn)` | ハンドラが1本＝どの層のヒットか呼び側が `_src` で判る前提。v2 は `layer.on('click')` |

**fid 空間の扱いが決定的な差**：現行は「fid＝唯一のスロットの添字」。v2 は「fid＝その layer 内の添字」で、
layer をまたいで fid は衝突する。§4.1 の裁定により経路で分かれる：

- **hover / tip**＝アクティブ層が確定している ⇒ `fid` だけで足りる
- **層をまたぐ経路**（`map.queryAll` / `map.on('click')`）⇒ **必ず `{ layer, fid }` の対で返す**

`map.onGintClick` は「fid だけ・層の概念なし」＝後者を表現できない。そのまま引き継がないこと。

### 10.3 スタック全体でしか持てない属性 ＝ v2 では**必ず layer 単位**

現行 `applyGintData` の opts は「載っている物すべて」に掛かる。census2020 の防災スタックに妥協の跡が残る：

```js
map.applyGintData(pbf, …, { minZoom: 10, drapeFill: hazard, hover: !hazard, tip: hazard ? null : FUDE_TIP });
```

`hover: !hazard` ＝**ハザード層が1つでも点いていると筆ポリゴンのホバーもまとめて死ぬ**。
v2 では `minZoom` / `maxZoom` / `drape` / `tip` / `interactive` を layer のプロパティとし、
「スタック全体の設定」という概念を**作らない**。

`hover` は layer のプロパティにすらしない——**§4.1 の active（カーソルを持つ層）がその役割を吸収する**。
現行の `hover: !hazard` は「カーソルが誰のものか」を言う語彙が無いための場当たりであり、
v2 では「ハザード層をアクティブにする（＝筆はホバーしない）」と**意図をそのまま書ける**。ハックが概念に置き換わる。

### 10.4 合成（FC マージ）は利用者の作法として残す・API にはしない

census2020 は複数主題を「`properties._src` で出自を刻んだ1つの FeatureCollection へ合成 → 1回焼く →
fid 表で塗り分ける」で捌いている（`apps/census2020/bousai.js`）。これは §3 の restyle 哲学の正しい応用で、
**利用者の作法としては v2 でも有効**（トグルの見た目切替が再焼きゼロで済む）。
ただし v2 の API がこれを要求してはならない：

- 合成は**データセットの集合が変わるたびに再焼き**が要る（`stack://{code}/{sig}` の IDB キャッシュはその緩和策）。
  layer の add/remove が再焼きを強いる API は §8-1 の受け入れ基準（restyle は O(features) の評価＋テクスチャ更新1回）に反する
- 出自の刻印（`_src`）は**利用者がデータを加工する**ことを意味する。v2 は source を不変（§2 のワイヤ＝真実源）に保つ

### 10.5 送る時に持ち越す前提の確認（次バージョンの入口）

1. §5〜§7.1 は**実装済み**＝`src/gl/gint/style.js` の `buildFidStyle`（paint プロパティ・式サブセット・
   fid 表パック・filter→visible ビット）。§7.2 の winding 和 ID バッファも `idfill.js`（GL）と
   `gpu/gint.js`（WebGPU）で稼働中。**残りは API 面と複数レイヤの2つだけ**
2. 式評価器 `src/expr.js` は MVT 基図と共用のプリコンパイル方式＝v2 で新規に書かない
3. `map.on('move'|'click'|'load')`（レイヤ横断のイベント）は §4 に無い。実装時に §4 へ追記すること
