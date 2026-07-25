# Gint v2 描画定義仕様（draft v0.1）

対象は gint v2（ortho-core）の**描画定義＝APIインターフェース**。ワイヤ書式（GeoPBF）には一切触れない。
v1（ortho-map gint）は現状のまま仕様として存続し、本仕様とは混ざらない。

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
});
layer.setPaint(partialPaint);   // 差分更新可。コスト=式再評価+texSubImage2D 1回
layer.setFilter(expr | null);
layer.on('click' | 'hover', ({ fid, feature, lngLat }) => {});
layer.query(lngLat)  → feature | null      // queryRenderedFeatures 相当（点1つ）
layer.remove();
```

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
