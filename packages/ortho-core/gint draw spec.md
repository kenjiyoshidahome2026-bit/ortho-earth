# Gint 描画定義仕様 1.0

対象は Gint（`@ortho-earth/core` の知性の層）の**描画定義＝API** と、それを支える**実装契約**。
ワイヤ書式（GeoPBF・GintBUF）はここに書かない（`packages/geopbf/pbf spec.md`・説明書 docs/gint の §8）。

| | |
| :--- | :--- |
| 版 | **1.0（2026-09-26）**＝draft 0.1（2026-07-25）を実装に合わせて確定した版（Issue #10）。以後の変更は §13 に足す |
| 正典 | 本書。本書・実装・`globe.d.ts`・説明書の食い違いは不具合＝見つけたら揃える。実装と本書の意図がずれている所は §12-B に**未決**として並べた |
| 実装 | main＝`packages/globe/src/gint/layers.js`（層の手綱・照会）／WebGL2＝`packages/ortho-core/src/gl/gint/`／WebGPU＝`packages/ortho-core/src/gpu/gint.js`・`gintwgsl.js`／式＝`packages/ortho-core/src/expr.js`・`gl/gint/style.js` |
| 型 | `packages/globe/globe.d.ts`（`GintLayerOptions`・`GintLayerHandle`・`GintPaint`・`GintDrawStyle`） |
| 利用者向け | `apps/docs/gint.html`・`gint-jp.html`（Part I＝使い方・§6＝リファレンス・書式は geopbf の `reference.md` に揃えた） |
| 公開の線（本人裁定 2026-09-26） | 外向きに約束する式＝§6.1 の契約の集合（d.ts の一覧と同じ）。診断プローブ（§7.12）は内部のまま＝API にしない |

## 1. 目的と非目標

**目的**
- 敷居を下げる：MapLibre の語彙（paint プロパティ・式・`setPaint`/`setFilter`/`on`/`query`）の**知識がそのまま通じる**サブセットを出す。互換ではなく知識の移転
- 描画定義の変更（コロプレスの軸切替・filter・feature-state）を**幾何の再構築ゼロ**で成立させる
- 離散的データ（全国に散在する小ポリゴン多数＝土砂災害警戒区域級）を性能の一級市民にする（§8-3）
- 層はデータ：「この点の下に何があるか」に層をまたいで答える（§4.4・§4.5）

**非目標**
- MapLibre との drop-in 互換（style.json 全域・plugin・タイル）。背景と注記の本体は MVT 側（Gint のラベルは基図の注記の利用者チャンネルに相乗り＝§4.6）
- 式の完全実装。契約の集合を明文化し（§6.1）、必要が立証された物から足す

## 2. 位置づけ（3層）

```
ワイヤ : GeoPBF（真実源・不変・位相を含む）＋ GintBUF（geopbf が符号化・IndexedDB にキャッシュ・版の検札で自己修復）
派生   : 辺メタ／境界メタ／tier 梯子／chunk／fid 別 bbox／扇の要 ＝ 使い捨ての描画キャッシュ。
         読み込みごとに bake worker で焼き、GPU レイアウトのまま render worker へ transfer（IndexedDB には置かない）
表面   : 本書の API（書式ではなく API がインターフェース）＋ fid スタイル表（式の評価結果）
```

派生物の IndexedDB 焼き（再訪で bake を飛ばす）は draft の構想で、未実装（§12-A）。

## 3. 描画モデル

- **source** = GeoPBF（IF は常に FeatureCollection）。`geopbf(input, { gint: true })` で `unPackGint`（GintBUF の展開）を持つこと＝無ければ `addGint` は `null`
- **layer** = 1 つの GeoPBF＋描画定義（paint / filter）＋層の属性（§4.1）。**fid**＝GeoPBF の feature 番号（0 始まり）＝全テーブルの添字
- **fid 整列の契約**：式評価の入力は「fid → properties」の**整列配列**（`pbf.getProperties(i)`・identify と同じ真実源）。
  `.geojson` は壊れ geometry の feature を飛ばして配列を**詰める**ため fid とずれる＝式評価に使ってはならない
  （札幌の筆で実証：数件の欠落で全 fid が横滑りし、コロプレスの対象が隣の feature に化けた）。読めない feature の props は `{}`＝既定値の評価
- **評価済みの結果だけが GPU に渡る**：式は setPaint / setFilter / feature-state の変化の時に main で全 feature を一括評価し、
  fid 添字のスタイル表（テクスチャ）へ焼く（`buildFidStyle`）。描画ループに式評価は無い

## 4. API 面

```js
const layer = map.addGint(pbf, {           // pbf＝geopbf(…, { gint: true })。unPackGint が無ければ null
  order, minZoom, maxZoom,                 // 層の属性（「スタック全体の設定」は作らない・§10.2）
  interactive: true,                       // false＝カーソルを取らない（§4.4）
  tip,                                     // true＝全属性／fn(props)→行の配列／無指定＝出さない
  label,                                   // { field, size, color, halo, haloW, sort, minZoom, maxZoom }（§4.6）
  style,                                   // 式なしの描き方（GintDrawStyle：fillColor/lineWidth/ptRadius/styleTable/dashTable…）
  fillMaxEdges, lowFill,                   // 塗りの辺数上限（0＝輪郭だけ）／上限超えでも低ズームの単色塗りだけ生かす
});
await layer.ready;                         // true＝焼き上がり（bake worker）／false＝失敗
await layer.setPaint(paint, filter?);      // 式を一度評価→fid 表。paint は**丸ごと置換**・filter 省略＝今の filter
await layer.setFilter(expr | null);        // paint 未設定なら預かり（次の setPaint で効く）
layer.setFeatureState(fid, obj | null); layer.removeFeatureState(fid?);   // ['feature-state', key]（§4.7）
await layer.setData(pbf, { minZoom?, maxZoom? });   // 差し替え（手綱・イベント・paint・filter は生存）→ true＝焼き上がり
layer.setOrder(n); layer.setVisible(bool); layer.style(drawStyle);
await layer.setLabel(label | null);
layer.on('hover' | 'click' | 'mouseenter' | 'mouseleave', cb);   // アクティブ層だけ（§4.4）
layer.query([lng, lat]) → { fid, properties } | null            // main 同期の JS 照会（§4.5）
layer.activate(); layer.remove();

map.queryAll([lng, lat]) → [{ layer, fid, feature: { fid, properties } }]   // 手前の層から（§4.5）
map.on('click', ({ lngLat, hits }) => {})                                   // hits＝queryAll と同型
map.on('move' | 'settle' | 'load', cb); map.off(ev, cb)                     // load は登録が遅くても即発火
```

### 4.1 `map.addGint(pbf, opts)` の属性

| 属性 | 型 | 既定 | 意味 |
| :--- | :--- | :--- | :--- |
| `order` | number | 追加順 | 重ね順（小さいほど下）。GL＝`order ?? ++seq` の安定挿入 |
| `minZoom` / `maxZoom` | number | データから | 未指定の minZoom＝arc の bbox 最大辺から `floor(log2(360/maxDim))`（狭域ほど高い）・maxZoom＝精度から `floor(0.491 + 3.322·precision)`（`checkZoomRange`） |
| `interactive` | boolean | true | false＝カーソルを取らない（持ち主はそのまま）。照会（queryAll・map.on('click')）には入る |
| `tip` | boolean / fn | 無し | true＝`key: value` の全属性・fn＝`props → string[]`（null・空＝出さない）・ホバー tip は全層で 1 つ（`gintHoverTip`） |
| `label` | object | 無し | §4.6 |
| `style` | GintDrawStyle | 既定色 | paint なしの見た目。`fillColor [r,g,b,a]`（0〜1）・`lineWidth`（CSS px）・`ptRadius`・`styleTable`（styleId 0＝面の辺・1＝線）・`dashTable`・`moveBudget`・`outlineZoom` |
| `fillMaxEdges` | number | 2,000,000 | 面の辺がこれを超えると塗りを止める（fillOff）。0＝輪郭だけ |
| `lowFill` | boolean | false | fillOff でも低ズーム帯の単色塗り（境界メタ）だけ生かす |

`paint`・`filter`・`overlap`・`drape` は**属性に無い**（draft からの差＝§4.10）。塗りは `ready` の後 `setPaint` で、重なりは解決パスが常に扱い（§7.2）、3D は常に地形へ載る（§7.6）。
`addGint` はカメラを動かさない（単一スロットの `applyGintData` の moveCamera と別物）。

### 4.2 層の手綱

| 動詞 | 意味 | 備考 |
| :--- | :--- | :--- |
| `id` / `ready` / `order` | 層 id（`"gl<n>"`）・焼き上がりの Promise<boolean>・重ね順 | ack は待ち行列＝初回 ready と setData の再ロードを同じ経路で受ける |
| `setPaint(paint, filter?)` | 式を一度評価→fid 表を送る | **全置換**（プロパティごとの差分は MapLibre 形の `setPaintProperty`＝§4.9）。`null`＝表を捨てて既定の描き方 |
| `setFilter(f)` | 絞り込みだけ | paint 前は預かり（警告を出す）。paint 後は `setPaint(lastPaint, f)` |
| `setFeatureState(fid, obj)` / `removeFeatureState(fid?)` | 一時状態 | obj は既存に混ぜる・null で消す。同じタスク内の連打は microtask で 1 回の再評価に束ねる |
| `setData(pbf, {minZoom, maxZoom})` | データ差し替え | 手綱・イベント・paint・filter・ラベルは生存。焼き上がり後に paint を新しい feature で再評価 |
| `setOrder(n)` | 実行時の重ね順 | 両土台（`gintOrder`） |
| `setVisible(v)` | 表示 | 焼き直しなし（census2020 防災のトグル＝§8-1 の実例） |
| `style(drawStyle)` | paint なしの見た目の差し替え | |
| `setLabel(label)` | ラベルの付け替え | Promise の解決時に `labelCount` 確定（検定窓・非公開） |
| `on(ev, cb)` | hover / click / mouseenter / mouseleave | **アクティブ層だけ**（§4.4）。`off` は無い |
| `query(ll)` | 明示照会 | §4.5 |
| `activate()` | カーソルをこの層へ | main のゲート（`extActive`）とエンジンの `act` を同時に移す |
| `remove()` | 撤去 | 焼き途中は捨てる・tip を消す・アクティブなら main のゲートは null |

イベントの形：hover＝`{ fid, properties } | null`／mouseenter＝`{ fid, properties }`／mouseleave＝`{ fid }`／click＝`{ fid, properties, lngLat: [lng, lat] }`（lngLat は直近ホバー識別の**ポインタ位置**）。

### 4.3 地図の側

- `map.queryAll(ll)`：**いま見えている**追加層（`_shown`＝setVisible・ズーム域・焼き着地済み・地球儀の内部層でない）に `query` を、手前から（order 降順・同値は新しい方が先）。
  末尾に単一スロットのユーザー層を `layer: null` で足す（§10 の橋渡し・その paint 表の visible ビットを filter として尊重）
- `map.on('click', cb)`：地球の上のクリックごとに `{ lngLat: [lng, lat], hits: queryAll(lngLat) }`（hits は空もある）。球の外・測距/断面/台帳編集/編集アプリのクリック横取り中は呼ばない
- `map.on('move' | 'settle' | 'load')`・`map.off`：draft の約束（旧 §10.5-3）どおり 2026-09-09 に実装。`settle`＝カメラ静止（onMove の 150 ms 無音）
- 層 id つきの `map.on('click', layerId, cb)` は MapLibre 形の入口の物（§4.9）

### 4.4 アクティブ層 ── カーソルは 1 層・照会は層をまたぐ（裁定 2026-08-19・実装 2026-09-09）

`interactive`（入力に参加するか）と **active**（カーソルを持つか）の二軸。**active は常にただ 1 層**。

| | `interactive:false` | `interactive:true`・非アクティブ | **アクティブ**（1 層） |
| :--- | :---: | :---: | :---: |
| hover / tip / ハイライト | — | — | ○ |
| `layer.on('click')` | — | — | ○ |
| `map.on('click')` の hits | ○ | ○ | ○ |
| `layer.query` / `map.queryAll` | ○ | ○ | ○ |

**なぜ hover だけ絞るか＝コスト構造が違う**。hover は連続（`MOVE_THROTTLE_MS`＝32 ms・先頭と末尾の 2 回）で、安さと曖昧さゼロが要る——tip は 1 つしか出せない。
click は稀＝層数に比例した照会を払える。実装上も大きい：**連続経路が常に 1 層なら pick の的は 1 枚**でよく、`activeId`・`moveTimer`・`lastMX/lastMY` もエンジンに据え置ける（§7.9）。

- **既定のアクティブ**＝最後に `addGint` した interactive な層。`activate()` で移す
- `interactive:false` の層を足しても、**足す前のアクティブ層がカーソルを持ったまま**（main のゲートも、エンジンの `act` も `gintActivate(前の層)` で戻す・2026-09-26＝U2 解決）。
  前が居なければ既定層（WebGL2 エンジンにも既定層へ返す `activate()` を足した＝旧は no-op で、エンジンのカーソルが non-interactive の層に残っていた）
- 照会の表の「内部層」＝地球儀が自分で足す層（admin0・世界の線・worldContent＝非公開の印 `_internal`）は、interactive に関わらず照会に出ない（§4.5）
- ⚠ アクティブ層を `remove()` すると main のゲートは null＝activate か新しい interactive 層まで、どの追加層もホバーしない（draft の「残る interactive 層の最後へ落ちる」は WebGPU エンジン内部の `act` だけ＝U6）
- ⚠ `layer.on('click')` はアクティブ層だけに届く（click は直近のホバー識別の結果を運ぶ）。draft の表は非アクティブの interactive 層にも ○ だった（U5）。層をまたぐクリックは `map.on('click')` が担う
- **戻り値の形**：hover はアクティブ層が確定＝`fid` で足りる。**層をまたぐ経路（`queryAll` / `map.on('click')`）は必ず `{ layer, fid }` の対**＝fid は層内の添字で、層をまたいで衝突する
- MapLibre の `queryRenderedFeatures` は全層から返す＝この規約は**意識的な逸脱**（§1 非目標）。GIS デスクトップ（QGIS/ArcGIS）の「アクティブレイヤ」＝利用者が既に持っている概念に寄せた

### 4.5 照会の意味（2026-09-26 に確定＝U3/U4 解決）

| 口 | 答える物 | filter | setVisible・ズーム域 | interactive:false | 地球儀の内部層 |
| :--- | :--- | :---: | :---: | :---: | :---: |
| ホバー（エンジン） | アクティブ層の、ポインタの下の地物 | 尊重（隠した面に当たらない） | 描いていなければ識別しない（`_inRange`） | 取らない | 取らない |
| `layer.query(ll)` | **その層の地物**（わざわざ問う口） | 尊重 | 見ない（消していても・範囲外でも答える） | 答える | —（利用者は手綱を持たない） |
| `map.queryAll(ll)` / `map.on('click')` | **いま見えている物** | 尊重 | 見えている層だけ | 入る（筆×警戒区域の重ね合わせ照会） | 出さない |
| `queryRenderedFeatures`（MapLibre 形の層） | 描かれている物 | 尊重 | layout.visibility・ズーム域 | — | 出さない |

- 実体＝`pbf.identifyAt(lng, lat, { accept })`（geopbf・描画レス識別）：**50 m 以内の点 → 30 m 以内の線 → その位置を含む面（smallest-wins）**の順で、`accept(fid)` が偽の地物は**無いものとして次の候補**を探す（geopbf 2026-09-26・`findPolygon` の 8 番目の引数も同じ）。距離はメートル固定（ズーム非依存）
- `accept`＝層の直近の fid 表の visible ビット（表が無い＝paint 未設定＝全部通す・表の外の fid も通す）。エンジンのホバーは `fidVisible(層の状態)`（`gl/gint/utility.js`・両土台共通）
- 「見えている」＝main の `_shown(z)`＝`setVisible` の台帳 ∧ 焼き着地済み ∧ `z ∈ [max(エンジンの minZoom, style.minZoom), min(エンジンの maxZoom, style.maxZoom)]`（エンジンの `zoomInRange` と同じ積）。
  エンジンの実レンジ（データからの自動導出を含む）は焼きの ack（`gintAck` の `minZoom/maxZoom`）で main へ返る
- smallest-wins の実体：`findPolygon` は polyStream を全走査して**最後に当たった物**を返す。polyStream の成分は重み（`sqrt(|面積|/2) + 周長/4`）の降順に並ぶ（geopbf topology.rs）＝最後＝最小
- ホバーの経路：GPU の pick 的（線と点・visible ビットを見る）→ 画素が 0 の時だけ `findPolygon`（accept つき）＝**線と点が面より先**
- **properties が完全に同じ地物は 1 つの fid**：geopbf の JSON/Shapefile デコーダは同一属性の地物を併合（`dissolve`）し、`topologyFullWasm` も properties で fid を束ねる＝同じ実体として塗り・強調・答えが一緒（U12 も読む）

### 4.6 ラベル（text-field 相当・2026-09-09）

- `opts.label` / `setLabel(label)`。`field`＝**式**（§6 の全域・`concat`/`to-string`）／関数 `props → string`／文字列（**リテラル**＝全地物に同じ文字。属性名ではない）
- `size`・`color`・`halo`・`haloW`・`sort`（数・小さいほど優先）・`minZoom`/`maxZoom`（既定＝層の範囲）
- 錨：面/線＝fid 別 bbox の中心・点＝geometry。描画は基図の注記と同じ衝突/フェード/標高投影（labels2d の利用者チャンネル・`gintLabels`）
- **filter 連動**：直近の fid 表の visible ビット（bit0）が 0 の地物は出さない。paint 未設定＝全部出す

### 4.7 feature-state（2026-09-09）

`setFeatureState(fid, obj)`・`removeFeatureState(fid?)`＋式 `['feature-state', key]`（MapLibre 同名）。状態は main の `Map<fid, object>`＝評価文脈の `state`。
変化のたびに `setPaint(lastPaint, lastFilter)` を呼び直す（restyle は安い＝§8-1）。連打は microtask で 1 回に束ねる。paint 未設定なら何もしない。

### 4.8 zoom × data-driven（settle 再評価・2026-09-09 → 09-24）

paint か filter の JSON に `["zoom"` を含む層は、**settle ごとに |Δz| ≥ 0.25** なら `setPaint(lastPaint, lastFilter)` を自動で呼び直す（`_zoomReeval`）。
式は評価時点の `cam.zoom` の写し＝ズームの最中は変わらず、止まった時に変わる。0.25＝出しズームの境（z4/z5…）の跨ぎを取り逃がさない値
（旧 0.5 は 4.6→5.05 の跨ぎを逃した）。filter の `["zoom"]`（NE の min_zoom 等）も対象（2026-09-24・世界帯の道路/河川の段階表示）。
毎フレームの連続補間が要るなら将来の fid 列＋シェーダ lerp（§12-A）。

### 4.9 MapLibre 形の入口（#34・2026-09-23）

`map.addSource(id, { type: 'geojson', data })`＋`map.addLayer({ type: 'fill' | 'line' | 'circle', … })` は、**source ごとに Gint の追加層 1 枚**を作る（globe.js `rebuildGint`）：

- 同じ source の層の paint は `Object.assign` で**混ぜ**、filter は層ごとに `all` で**結ぶ**（⚠ MapLibre は層ごと＝U7）
- 出しズーム＝**MapLibre の既定**：`minzoom` の無い層は z0 から・`maxzoom` の無い層は上限なし（同じ source の層は和）。
  旧（〜2026-09-25）は minzoom 無し＝null＝Gint の自動導出（狭い範囲のデータは z9 等から）で、MapLibre の層が引くと消えたまま照会だけ当たっていた
- `setPaintProperty` / `setLayoutProperty(visibility)` / `setFilter` / `moveLayer` / `setLayerZoomRange`＝登録簿を書き換えて `setPaint`（fid 表だけ）か `setData`
- `map.setFeatureState({ source, id }, state)`＝`id`＝その source の地物番号（GeoJSON の並び＝fid）→ 層の `setFeatureState`
- `queryRenderedFeatures` と `map.on('click' | 'mousemove' | 'mouseenter' | 'mouseleave', layerId, cb)` はこれらの層に当たる（`identifyAt` に画素の許容を渡す）
- 重ね順＝登録簿の並びの添字（0 始まり）＝`order`。描き方の違う層どうしの上下は描画の段で決まる（基図 → 画像 → gint → 押し出し/建物 → ヒートマップ → 集約 → 記号 → 模様）
- `fill-pattern` / `line-pattern` / `line-gradient` / `line-offset` は Gint ではなく canvas2D の模様の口（紙の遺物の側＝互換の口だけ）

### 4.10 draft 0.1 からの差（実装で決まったこと）

| draft 0.1 | 1.0（実装） |
| :--- | :--- |
| `addGint(source, { paint, filter, overlap, drape, … })` | paint/filter は `setPaint` で（ready の後）。`overlap`・`drape` は属性に無い（§7.2・§7.6） |
| `setPaint(partialPaint)`＝差分更新 | **全置換**。差分は MapLibre 形の `setPaintProperty` |
| `on('click', ({ fid, feature, lngLat }))`・`query → feature` | `properties` を返す（`{ fid, properties }`） |
| `map.activeLayer` | **無い**（`activate()` が唯一の口） |
| click は interactive な非アクティブ層にも | アクティブ層だけ（U5）。層またぎは `map.on('click')` |
| アクティブ層を remove → 残る interactive の最後へ | main のゲートは null（U6） |
| 重複×連続式＝仕様エラー | **後勝ち**（§7.2・2026-09-15） |
| `overlap:'auto'`＝初回 winding プローブ→IDB | **作らない**（後勝ちで不要に） |
| `line-dasharray`（dash-id 256 種） | **未実装**（dash-id 欄は常に 0） |
| `visibility` を paint に | 層の `setVisible`（MapLibre 形は `layout.visibility`） |
| ID バッファ不可→クラス別 OR へ降格 | stencil 単色へ縮退（§7.2） |
| TF 前段・Morton の入口一回展開 | **未実装**（§7.10・§12-A） |
| zoom 再評価 0.5z・paint だけ | 0.25・filter も（§4.8） |
| 式は §6 の初期集合 | §6.1 の契約の集合（d.ts と一致） |

## 5. paint プロパティ

| プロパティ | 型 | data-driven | fid 表の欄 | 実体・注意 |
| :--- | :--- | :---: | :--- | :--- |
| `fill-color` | 色 | ○ | R（RGBA8） | **表がある層の面はこれだけで塗る**（書かない＝塗らない＝どのズームでも輪郭だけ・既定のベタ塗りも出ない） |
| `fill-opacity` | 0〜1 | ○ | R の α に掛ける | |
| `line-color` | 色 | ○ | G（RGBA8） | 点以外が使う。**α=0 は既定色（styleTable）に戻る**＝消えない。消すのは width 0 |
| `line-opacity` | 0〜1 | ○ | G の α に掛ける | G 欄は線と点で共有＝点の色にも掛かる |
| `line-width` | 数 | ○ | B 上位 u8（1/8 刻み・0〜31.875） | 0＝線を描かない。⚠ 単位＝**デバイス画素**（×dpr されない。既定の `style.lineWidth` は CSS px＝U1） |
| `circle-color` | 色 | ○ | G | Point/MultiPoint は circle-color 優先→無ければ line-color（2026-09-11）。α=0 は既定色 #FF6B35 |
| `circle-radius` | 数 | ○ | B 第 3 バイト（1/4 刻み・0〜63.75） | ×dpr＝CSS px。0＝点を描かない |
| `visibility` | — | 層単位 | — | `setVisible`／MapLibre 形は `layout.visibility` |
| `line-dasharray` | — | ✕ | B 第 2 バイト（dash-id）＝常に 0 | 地物ごとの破線は未実装。破線は `style.dashTable`（styleId 単位） |

- 既定（プロパティ無し）：塗り 0（無し）・線色 0（→既定色）・幅 1（8/8）・半径 1.5（6/4）・visible
- 色（`color.js` `parseRGBA`・大文字小文字を問わない）：`#rgb` `#rgba` `#rrggbb` `#rrggbbaa`・カンマ区切りの `rgb()`/`rgba()`・`hsl()`/`hsla()`（カンマ・空白・`/` 可）・CSS の色名 148＋`transparent`。
  空白区切りの `rgb(… / …)`・% の成分・`hwb`/`lab`/`color()` は読めない（NaN か不透明の黒）

## 6. 式

### 6.1 契約の集合（外向きに約束する＝d.ts の一覧＝説明書 §4）

```
データ     get has feature-state geometry-type zoom literal
選ぶ       match case step coalesce
補間       interpolate（["linear"] / ["exponential", base]・数と色）
比較と論理 == != > >= < <= ! all any in
算術       + - * / % ^ min max
型と文字   to-number to-string concat
変数       let var
```

### 6.2 評価規約

1. setPaint / setFilter / feature-state の変化の時に、main で全 feature を**一括評価**（`buildFidStyle`）。結果は fid 表へ焼かれ、フレームごとのコストはゼロ
2. `["zoom"]` は評価時点の写し＝§4.8 の settle 再評価。毎フレームの補間は無い
3. **throw しない**：評価エラー・型不一致・未知の演算子は、その feature のその欄を既定値に（塗りなし・1 px・1.5 px）。未知の演算子は `globalThis.__orthovtUnknownOps` に記録
4. `==` `!=` `match` は `===`（MapLibre の型つき比較の簡略）＝`"13101"` と `13101` は別。`to-string`/`to-number` で揃える
5. `interpolate` は数・色（rgba の線形）・配列。**入れ子も可**（`match` の枝の中の色の `interpolate` も評価器 #33 で補間される）
6. `match` のラベルは配列可（どれかに当たれば出力）。`in`＝`["in", 探す値, 対象]`・対象は文字列（包含）か配列（要素）
7. **欠けた値**：`interpolate` は入力が有限でなければ透明・`step` は base・`match` は fallback＝意味は利用者が `coalesce`/`has`/filter で決める（説明書 §2.3）
8. `geometry-type` は GeoPBF の型名（Multi 付きもそのまま）

### 6.3 契約外（評価器は受けるが Gint には約束しない）

評価器（`expr.js`）は MVT の基図と共用＝外来 style.json のために `id` `properties` `to-boolean` `to-color` 等の型表明・`rgb`/`rgba`・`typeof`・`downcase`/`upcase`・
`length`/`slice`/`index-of`・`abs`〜`round`/`sqrt`/`log*`/`ln`/`e`/`pi`・`image`・`format`・`number-format`・`interpolate-hcl`/`-lab`（rgb 線形の近似）・`collator`（null）…も受ける。
Gint の評価文脈に `id` は無い（`["id"]`＝undefined）。契約に足すなら d.ts・説明書・検定を同時に（§12-A）。

## 7. 実装契約（内部。API 利用者は読まなくてよい）

### 7.1 fid スタイル表

- RGBA32UI・1 texel / fid・幅 `min(4096, TEX_ARC_W)`：`R=塗り色 G=線/点の色 B=width(1/8)<<24 | dash<<16 | radius(1/4)<<8 | flags A=予備`
- flags bit0 = visible（filter の実体）。他は予備
- width は**正味のスタイル幅だけ**を焼く。パス都合の増分（アクティブの強調 +2 px・pick の余白 12 px×dpr）は uniform で足し、表に混ぜない
- width=0＝線を描かない（VS で棄却）／radius=0＝点を描かない。線色・点色の α=0＝既定色（§5）
- 更新は同寸なら `texSubImage2D`（WebGPU は `writeTexture`）1 回。メタ・tier・幾何に触れることを**仕様として禁止**。context lost 用に CPU 側の写しを保持
- 規模：16 B/fid＝1,919 市区町村で 31 KB／100 万 feature で 16 MB
- **visible ビットを見る所**：線の描画と強調・線の pick・点の描画と pick・ID 塗りの蓄積と解決・ラベル・`findPolygon`／`identifyAt`（`accept`＝ホバーの面と照会・2026-09-26）。
  **見ない所**：stencil 単色の塗り（`VS_STENCIL` は表を読まない＝ID 塗りが使えない時の縮退で隠した面も単色で塗る＝U13）

### 7.2 塗りの機構

塗りは常に**非ゼロ巻き数**（NOTEQUAL 0）系で、**偶奇は使わない**。リング向きは bake で正規化（`normalizeRingOrientation`＝外環多数決で逆巻きを反転・冪等）。
向きを揃えた下では、複数 feature の重ね書きは画素値＝被覆数となり、NOTEQUAL 0 は**和集合（OR 塗り）と厳密に一致**する（穴の上に別 feature が乗る場合も）。
＝素性の悪い重複データ（災害系・法務省地図の重複登記）への耐性は巻き数の側に元からある。

**経路の選択**（毎フレーム・層ごと）：

| 条件 | 経路 |
| :--- | :--- |
| fid 表あり ∧ 面あり ∧ !fillOff ∧ 能力あり ∧ fid 数 ≤ 上限 ∧ 予算内（!_forceLow）∧ 面を画面に描く（!noFaces） | **ID バッファ塗り**（地物ごとの色） |
| それ以外 | **stencil 単色**（境界メタ・既定の低ズーム塗りか `style.fillColor`）＝地物ごとの色は失われる |

**ID バッファ塗り**（`idfill.js`・`gintwgsl.js` の `vsId/fsId/idResolve`）：

- 蓄積：stencil と同じ扇（**基準メタ・全密度 rank 0・地物ごとの扇の要・bbox とキャップの間引き**）。invisible な fid は蓄積から除外。
  FS は `(±(fid+1), ±1, 0, fid+1)` を書き、blend は RGB 加算・**A は MAX**（両向きとも）
- 解決（全画面 1 パス）：G<0 なら R と G の符号を反転 → G<0.5 は捨てる → `q=R/G` → `multi = G>1.5 ∨ |q−round q|>0.25` →
  multi ∧ A≥0.5 なら `fid=round(A)−1`（**後勝ち＝fid の大きい方**）・multi でなければ `round(q)−1` →
  **剥がし**（最大 3 候補）：候補が invisible か塗り α=0 なら `R−=fid+1, G−=1` で次へ。2 重までは厳密・3 重以上は R/G が平均化され整数に近い時だけ塗る（保証しない）
- 多重登記（同じ環が k 回）は `R=k(fid+1), G=k` ＝ q で約分されて正しい fid に戻る
- パス数は色数に非依存（1,919 色でも蓄積＋解決の 2 パス）

**能力の梯子**：

| 土台 | 条件 | 形式 | fid 上限 |
| :--- | :--- | :--- | :--- |
| WebGL2 | EXT_color_buffer_float ＋ EXT_float_blend | RGBA32F | 2^24 |
| WebGL2 | EXT_color_buffer_float のみ／EXT_color_buffer_half_float のみ | RGBA16F | 2,047 |
| WebGL2 | どれも無い・FBO 不完全 | —（stencil 単色へ） | — |
| WebGPU | `float32-blendable` | rgba32float | 2^20 |
| WebGPU | 無し | rgba16float | 2,047 |

fid が上限を超える層は地物ごとの塗りを失う。回避は「同じスタイルの地物をマルチポリゴンにまとめる」（census2020 の A33＝区分×現象で束ねて fid を 1 桁に）。

**重なりの監査モード**（内部・§7.12）：paint の送りに `overlap: true` を付けると、解決パスが通常の塗りをせず巻き数の異常画素だけを塗る＝
マゼンタ（別々の地物の重なり＝R/G が非整数）／橙（同じ地物の多重登記＝G≥2 で q は整数）／シアン（向きの矛盾＝G≈0 なのに R≠0）。

### 7.3 境界メタと低ズームのベタ塗り

- `buildBoundaryEdgeMeta`：arc の符号付き正味参照（順向き +1・逆向き −1）が 0 でない arc だけを、正味の向きに |正味| 回出す。折れ線は後ろに全部。fid＝最初に参照した地物
- 隣り合う面の共有 arc は巻き数の寄与が対で打ち消す＝**単色の stencil 塗りは全ズームでこれに置き換えても数学的に同一**（同じ向きの重複は正味 ±2 で残る＝端ケース込みで等価）
- 使う所：**stencil 単色の塗り（全ズーム）**・線パス（`lowZoomEff ∧ 境界の面辺>0 ∧ 境界の辺数 ≤ 最細 tier の 1.5 倍`〔tier 無しは ≤ 600,000〕、または予算の安表現で境界の辺数 ≤ 予算）
- 描き方：**扇の要は 1 つ（クリップ原点）・fid 別 bbox とキャップの間引きは無効**＝残る arc は多数の地物にまたがる輪になり、地物ごとの要で扇ぐと巨大な楔になる（札幌の大字で実測）。
  chunk・tier も使わず 1 本の範囲で描く（LOD の rank は効く）
- 使わない所：**ID 塗り・pick・強調/マスク**（地物ごとの情報が要る）。相殺は fid 非依存の巻き数だけで効く＝fid で重み付けすると隣の筆の共有 arc が打ち消し合わない
- `outlineZoom`（低ズームのベタ塗りの切替）：`deriveOutlineZoom(fid 別 bbox, targetPx=8)`＝対角の中央値が画面 8 px になるズーム
  `log2(8 / (med × 40.74 × π/180 × 1e-7))`・[3, 17] に丸め・面が無ければ null → 既定 `OUTLINE_ZOOM=13`。`style.outlineZoom` で上書き（admin0＝0）
- `lowZoomEff = z<oz ∨ (moving ∧ z<oz+1.5) ∨ _forceLow`・`moving = _isDrawing ∨ _staticN<4`（帯の中で静止フレームを数える間は層が自分でフレームを要求）
- ベタ塗りの α：`style0 の α × 0.8 × clamp((oz+1.2−z)/1.2, 0, 1)`（安表現中は 0.8 固定）。明示の `style.fillColor` は全ズームで尊重（stencil 経路）
- 調律の教訓：targetPx=4 では境界メタ→全表現の引き継ぎ（oz+1.5）が可視 27 万辺＞移動予算 25 万の縮尺に落ち「ズーム中に描かない帯」ができた。8 で 18 万＝予算内。
  **調律値は式の由来ではなく、結合先（予算・フェード帯）との噛み合わせで決める**

### 7.4 移動中の予算・tier・chunk・塗りの上限

- 移動予算 `MOVE_EDGE_BUDGET = style.moveBudget ?? 250,000`（辺/フレーム）。移動中に前フレームの線の辺数が予算を超えたらラッチ（`_forceLowMove`）・静止 4 フレームで解除
- ラッチ中：線＝境界メタ（≤ 予算の時）／塗り＝単色の影（境界の面辺 ≤ 予算×8 の時）／ID 塗りなし／どちらも無理なら**層ごと飛ばす**（`_budgetSkipped`・識別も止める）
- 復帰：settle（150 ms 無音）→ `gintDrawn` → `drawn()`：飛ばしていたら `_staticN=4`・pick 予約・フレーム要求 → 次のフレームで全表現と pick の的。
  ⚠ この自前復帰は**アクティブ層だけ**（非アクティブ層は他のフレームに便乗＝U9）
- 移動中は常に：隠線パスを止める・地形の細分を半分・tier の構築を 120 ms 遅らせる・ホバーを保留・pick の的は settle で
- **tier 梯子**：`TIER_COUNT=9`・`TIER_MAX_EDGES=600,000`・総辺数 > 200,000 の時だけ。刻みは重みの分布に合わせる（`tierPlan`：`fineCap=min(0.7×総数, 60万)`・比 ρ≤0.7）。
  線の段選び（`pickLineTier`）：可視辺 > 最細 tier の 1.5 倍なら最細 tier・tier 無しは 60 万で頭打ち
- **chunk**：`CHUNK_EDGES=16,384`・地物単位で閉じる・fid 別 bbox 中心の Morton 順＝視野の中の連なりだけ描く
- **塗りの上限**：`FILL_MAX_EDGES=2,000,000`（`fillMaxEdges`・0＝輪郭だけ）。超え＝fillOff（既定のベタ塗りも ID 塗りも無し・明示の fillColor は stencil で塗る）。
  `lowFill`＝fillOff でも低ズームの単色塗りだけ生かす。静的上限 `MAX_SAFE_EDGES=10,000,000`

### 7.5 球面（地平・キャップ・縫い目・周期）

- **地平クランプ**（塗りの扇の共通契約・2026-09-15）：扇の辺の端点は VS の `horizonClamp`＝裏半球の頂点を地平円（中心 E/|E|²・半径 √(1−1/|E|²)）へ射影。
  裏の面は円周上に縮退＝巻き数 0、地平を跨ぐ面は可視部だけを囲む。扇の要はクランプしない
- **球冠の間引き**：`bboxVisible` は視野 bbox の後に、bbox を囲む小円と可視キャップの交わりを見る（余裕 +3.5°）＝対蹠点を囲む面が「全面 ±1」になるのを防ぐ。
  bbox の経度幅 ≥180° は免除・地面アトラスの窓モードでは使わない。境界メタ（fid 混成）はクランプだけ
- **縫い目**：±180° を跨ぐ地物は符号化で切る。線パスは両端が縫い目上（ix=0 か 360e7）の面の辺を描かない（塗りの巻き数には残す）。CPU も同じ fid の対の縫い目辺を除く（許容 ±2）
- **周期の fid 別 bbox**（2026-09-15）：`buildPolyBboxByFid` は縫い目の両側の片を周期で近い側へ寄せ、x が 360e7 を超える表現を許す（u32 に収まる時）。
  消費側は周期で読む＝扇の要とキャップは `% 360e7`、`bboxVisible` と geopbf `findPolygon` は 2 区間で交差判定。経度幅 ≥180° の地物は要をクリップ原点に
- 経度の周期は **360e7**（2^32 ではない）＝差分は周期で折り返す

### 7.6 3D（2026-09-21）

- **面は地面アトラスへ**：地形が有効（`fillsIn`）な間、Gint の面は地面アトラスの窓ごとに焼く（`bakeFaces`＝stencil か ID 塗りを窓座標モードで・窓 bbox で間引き・キャップ判定なし）。
  地形の FS が標本化する＝どんな地形でも地面にぴたり乗る。画面側は `noFaces`＝**線・点・強調だけ**。合成鍵 `bakeSig`＝内容の版＋移動/安表現の状態
- **線は地形適応細分**：bake で長い辺を長さの桶ごとに複製し、フレームごとに `subPlan`（`SUB_MAX=128`・`SUB_BUDGET=1,500,000`・移動中は半分）でインスタンス描画。
  `?nosub=1`＝細分なし（端点のドレープは残る）
- **隠線**：深度あり（地形あり ∧ !noDepth）∧ 静止 ∧ 描いた辺 < 100,000 で、深度 GREATER の破線（周期 10 px・6 px 描く・α×0.35）
- 単一スロットのユーザー層だけの事情：pitch ≥ 0.02 では `drapeFill` が無ければ隠す・`standupGint`（CPU ドレープ線 `gintBld`）が出ている間も隠す

### 7.7 識別（pick と findPolygon）

- GPU の pick 的：RGBA8（fid+1 を 24 bit）。**線（styleId 1 の辺）と点だけ**を描く。画素が 0 の時だけ `findPolygon`（JS・`fidVisible` の accept つき）＝線と点が面より先
- 的は **settle で・アクティブ層だけ**作る。面も点も無い層（線だけ）は作らない＝ホバーしない（U8）
- 読み戻しは非同期：GL＝PBO＋フェンス／WebGPU＝`copyTextureToBuffer`＋`mapAsync`
- ホバーの間引き `MOVE_THROTTLE_MS=32`（先頭＋末尾）。pick の余白 `12×dpr`（線＝幅＋余白・点＝`max(ptRadius, 余白/2)`・fid 別の幅は pick では見ない）
- 強調：+2 device px（`hiliteWidth` があればそれ）・色 `hiliteColor` か黄・点は半径 ×1.6。マスク＝アクティブな面の外を α0.4 で暗く
- `findPolygon` の smallest-wins と `identifyAt` の順序は §4.5

### 7.8 WebGPU の storage 経路（2026-09-09）

- 既定 ON：`maxStorageBufferBindingSize > 0 ∧ maxStorageBuffersPerShaderStage ≥ 2`。group(2)（arc・meta・metaB・tier・pt・ptMeta）を storage buffer へ。扇の要・fid 表・標高はテクスチャのまま
- buffer ごとに `byteLength ≤ device の上限`（既定 128 MiB）の時だけ写す＝超えればその層はテクスチャ経路。`sbReady(L)` を draw/drawn/bakeFaces の頭で層ごとにラッチ＝同じフレームで混在しても各層のパスは自己完結
- パイプラインは storage × MSAA で引く。storage 用 WGSL はテクスチャ版から `toStorageWGSL` で生成（`textureLoad` が残れば throw）
- `?gintsb=0`＝テクスチャ経路（globe.js `noGintSB` → renderworker → `createGintLayerGPU({ noSB })`）。WebGL2 に storage 経路は無い
- 検札口 `stats().sb`＝−1（経路なし）/0（この層はテクスチャ）/1（storage）・render worker の `self.__gintStats`

### 7.9 層の分割（脱シングルトン・2026-09-09）

| ブロック | 扱い | 中身 |
| :--- | :--- | :--- |
| データ・スタイル | **層ごと** | arc/meta/pt/metaB のテクスチャと buffer・辺数・fid 表・扇の要・tier 梯子・chunk・fillOff・fid 別 bbox・minZoom/maxZoom・予算のラッチ・perf |
| GPU 基盤 | エンジンに据え置き | デバイス/コンテキスト・パイプライン/プログラム・staging・ID 塗りのスクラッチ（FBO・idTex） |
| 識別・カーソル | エンジンに据え置き（§4.4） | pick の的（1 枚）・`activeId`・`act`・ホバーのタイマー・ビュー状態 |

- WebGPU：`makeLayer` が層ごとに UBO（gfBuf 4×512 B・gpBuf 11×256 B・styleBuf 8 KB・idRBuf 16 B・gfBufA 8×512 B）と bind group を持つ。
  **UBO は層の所有が正しさの必須条件**＝共有すると `writeBuffer` が submit 前に全部適用され、同じフレームの全層が最後の層の値で描かれる
- WebGL2：`addLayer` は `Object.create(s)`＋`emptySlot()`＝GL 基盤・ビュー・運動の状態はプロトタイプ委譲で、第 1 ブロックだけ自前。臓器は状態を第一引数で受ける
- 重ね順：GL＝`order<0` → 既定スロット → `order≥0`。WebGPU＝既定層も `addLayer` 由来で order 1 ⚠ order 0 の層は GL では既定スロットの上・WebGPU では下（U10）
- worker の口：`gintAdd`（ack の error `"no-multilayer"`＝addLayer を持たないエンジン）・`gintRemove`・`gintActivate`・`gintOrder`・`gintPaint`・`gintStyle`・`gintVis`・`gintLabels`・`gintBaked`（層指名）。
  identify/click の返信は `layer` を持つ＝main が手綱へ配る。ロードの ack（`gint`/`gintBaked`）は層の実レンジ `minZoom/maxZoom` を運ぶ（層の手綱の `range()`・§4.5）。
  `gintActivate` の layer 無し＝既定層へ（両土台）。bake worker 経由の焼き（`bakeAndSend`）は失敗時に同期経路へ落ちる

### 7.10 事前計算の 3 層原則

- **データの純関数は焼く**：符号化時（geopbf）＝共有弧・順位・**度アンカー**（弧の累積の経緯度スパン `max(|Δlon|,|Δlat|)` ≤ 1° ごとに L1＝既存頂点を昇格か大円上に補間・弧の bbox も膨らみを含める・`insertDegreeAnchors`・検定 `t-anchors.mjs`）。
  bake 時（読み込みごと）＝リングの向き・辺メタ・境界メタ・tier・chunk・fid 別 bbox・扇の要
- **カメラ依存は毎フレーム**：今は各パスの VS が頂点ごとに復号（`decodeDLL`＝Morton の compact16）・投影・`lodSnap` をやり直す。
  draft の「TF 前段で辺ごとに 1 回＝全パス共有」「Morton は入口一回で平置き」は**未実装**（§12-A。storage 経路の実測で ALU＝復号＋投影が支配的と判明＝次の的）。
  地物単位の少数量（扇の要）は CPU の double で小テクスチャへ
- **3D 座標の事前焼きは禁じ手**（float32 量子化）。整数経緯度＋原点相対（RTE）を保つ

### 7.11 z の目盛り

z は **256 px 世界**（`camera.js` の `WORLD_PX = 256`・`radPerDevPx = 2π/(2^z·256·dpr)`・2026-07-26 に統一）。
Gint の式（`deriveOutlineZoom` の 40.74＝256/(2π)・`precisionMax = floor(0.491 + 3.322·precision)`・`checkZoomRange` の `floor(log2(360/maxDim))`）は同じ目盛り。
⚠ 統一前は 512 px 世界で、同じ画角で z が 1 段ずれた（初期 fit が 1 段深く出た実バグ）。**fit・画角の計算は必ず `WORLD_PX` を通す**（`layers.js` `fitZoomForBbox`）。

### 7.12 診断プローブ（内部＝公開しない・本人裁定 2026-09-26）

`dbgHost` の手（`createGlobe` に target が無い自前頁か `opts.debugGlobals: true` の時だけ `window` に生える）。**単一スロットのユーザー層**が相手（ドロップ・`?g=`・`__gload`）。
アプリは触らない（§「コアは硬く・アプリは柔らかく」＝`dbgHost/__*` は内部）。検定は使ってよい。

| 手 | 用途 |
| :--- | :--- |
| `__paint(paint, filter)` / `__paint(null)` | 式の塗りの試運転（`paintGint`） |
| `__paintOverlap(on)` | 重なりの監査（§7.2 の色分け）＝「地図にすると品質が見える」 |
| `__paintParity()` | fid の偶奇の市松（偶数＝赤・奇数＝青）＝fid 空間の横滑りを場所に依らず見る |
| `__paintFid(...fids)` / `__paintProps(fid)` | 指定 fid だけ赤＝クリックの fid と突き合わせる／fid の properties |
| `__gload(name, opts)` | bucket の GeoPBF を単一スロットへ（全国級は minZoom 3） |
| `__budget(n)` | 移動予算の調律（`__budget(Infinity)`＝移動中も全表現） |
| `__standup(liftM)` / `__admin0(res)` / `__a0()` / `__worldLines()` | ドレープ線・admin0 の解像度・二層化と世界の線の検定窓 |
| `self.__gintStats`（render worker） | 層の perf・`sb`（§7.8） |

## 8. 性能要件（受け入れ基準と実測）

1. **restyle**（setPaint / setFilter / feature-state）：O(features) の JS 評価＋テクスチャ更新 1 回だけ。幾何・メタ・tier に触れない（§7.1）。
   実例＝census2020 の防災スタックは層ごとの `setVisible`＋`setPaint`＝トグルで**再焼きゼロ**（従来はトグルごとに FC 再マージ＋WASM 再焼き）
2. **毎フレームの GPU 仕事は可視 feature に比例**：chunk の視野連なり＋fid 別 bbox＋キャップの間引き・tier 梯子・単色の塗りは境界メタ。全辺数に比例するパスを作らない
   （例外＝ID 塗りは全密度が本質＝§7.3。軽くする次の手は §12-A の TF 前段）
3. **基準ベンチに離散データを含める**：全国散在の小ポリゴン群（共有 arc なし・tier 発火閾値未満の中規模・重複被覆あり）。記録＝離散データの境界メタは約 120 万辺（実測）で、線パスは 60 万で頭打ち（`passes.js`）
4. ID 塗りのパス数は色数に非依存（コロプレス 1,919 色でも 2 パス）

**実測（出典つき）**

| 項目 | 値 | 条件・出典 |
| :--- | :--- | :--- |
| 中ズームの 1 フレーム | gpuGint **20〜37 ms → 約 2 ms** | 札幌市中央区の筆（約 37 万辺・tier なし＝錨支配）・境界メタ導入（9547adc4・2026-07-26） |
| storage 経路 | z14 **1.43→1.28 ms（−10%）**・z8 1.38→1.30（−6%）・z3 20.8→20.8（±0） | 実 Metal GPU・交互 5 反復×N100 の中央値（291b4695）。`t-gintsbperf.html`＋`bench-gintsb.mjs`（合成 3000×700 辺の全密度・検定ではない）。**単発の A/B は熱と順序で ±50% 揺れる＝交互反復の中央値でしか語らない** |
| 描画の等価性 | storage/テクスチャ両経路で画素数が完全一致（塗り 5334・tier 881・ID 塗り 7144・ドレープ 380） | `t-gintgpu`（291b4695） |
| 筆のコロプレス | **57,341 筆**で match/case/in の塗り分けを通電 | 札幌市中央区・法務省地図（3333e15c）。特殊地番の語彙＝道・河川・無地番・筆界未定地 |
| 面の識別 | **0.5〜4 ms** | admin_all（1,919 市区町村）の identify（4f1f646a） |
| fid 表 | **31 KB**（1,919）／16 MB（100 万） | 16 B/fid |
| 移動予算との噛み合わせ | 可視 27 万辺（targetPx 4）→ 18 万辺（targetPx 8） | `utility.js` `deriveOutlineZoom`・予算 25 万 |

## 9. 確定仕様（裁定の記録）

| # | 論点 | 1.0 の確定 | 経緯 |
| :--- | :--- | :--- | :--- |
| 1 | 式の範囲 | §6.1 の契約の集合（＝d.ts の一覧）。評価器の残りは契約外 | 7/25 初期集合 → 9/9 concat/to-string/feature-state → 9/23 #33 評価器の拡張（基図用）→ 9/26 本人裁定「一周＋契約の式表」 |
| 2 | zoom × data-driven | settle ごとの自動再評価（ズームが 0.25 段以上動いて止まった時・filter も）。毎フレームの補間は無し | 7/25「非対応・逃げ道＝呼び直し」→ 9/9 自動化（0.5）→ 9/24 filter も・0.25 |
| 3 | 拡張機能の下限 | ID 塗りは float の加算 blend（§7.2 の梯子）。無ければ stencil 単色。クラス別 OR への降格は作らない | 7/25「二段の退避→クラス別 OR」→ 実装は stencil 単色 |
| 4 | line-width の分解能 | u8×1/8（0〜31.875）。単位は U1 | 7/25 確定 |
| 5 | API の動詞 | MapLibre 同名（setPaint/setFilter/setData/setFeatureState/on/query）＋層の手綱（activate/setOrder/setVisible/setLabel/style/remove） | 7/25 → 9/9 |
| 6 | 被覆の宣言 | `overlap` 属性は**作らない**。重なりは解決パスが常に扱う＝事前プローブ不要 | 7/25「overlap:'auto'＝初回プローブ→IDB」→ 9/15 後勝ちで不要に |
| 7 | 重複 × 連続式 | **エラーにしない**＝後勝ち（fid の大きい方）＋上が見えなければ剥がす（2 重まで厳密） | 7/25「仕様エラー」→ 9/15 本人報告（エディタの重なりで塗りが消える・偶然整数なら第三者の色）で後勝ちへ |
| 8 | 識別の層またぎ | hover/tip/ハイライト/`layer.on('click')`＝アクティブ 1 層・`map.on('click')`/query/queryAll＝層をまたぐ | 8/19 裁定。「click もアクティブ 1 層へ」案は不採用＝「この筆は土砂かつ洪水」の重ね合わせ照会（census2020 の一級の用途）を落とすため |
| 9 | 実装の順 | WebGPU 先行・WebGL2 は同じ契約の後追い＝両土台で同じ検定 | 9/9 本人裁定「GPU での性能を優先する設計」 |
| 10 | 多層の器 | 第 1 ブロックだけ層ごと・GPU 基盤と識別/カーソルは据え置き（§7.9） | 8/19 → 9/9 |
| 11 | 3D の面 | 地形ありは地面アトラスへ焼く（RTT）＝画面は線と点 | 9/21 |
| 12 | 公開の線 | 外向き＝一周＋契約の式表・診断プローブは内部 | 9/26 本人裁定 |
| 13 | 照会とカーソル | §4.5 の表：query＝その層の地物×filter／queryAll・hits＝見えている層×filter・内部層を除く・interactive:false は入る／ホバーは隠した面に当たらない／interactive:false の追加でカーソルは動かない／MapLibre 形の層は MapLibre の出しズーム既定 | 9/26 本人「2,3 を直す」（U2・U3・U4） |

## 10. 単一スロットの口との境界 ── 多層の API を汚さないための線引き

`map` 直下には、多層（§4）より前からある**単一スロット**の口が残っている。派生アプリ（census2020 のコロプレス・geoedit・gishub-jp）の足場として残すが、
**§4 の層の API と混ぜない・改名して再利用しない・昇格させない**。新しいコードは `addGint`。

### 10.1 昇格させてはならない口

| 口 | なぜ層の API に持ち込めないか |
| :--- | :--- |
| `map.applyGintData(pbf, label, moveCamera, opts)` / `clearUserGint()` | 「唯一のスロットを置き換える」動詞。`addGint` は**追加**であって置換ではない |
| `map.paintTable(u32, count)` | fid 表の生バイト直書き＝スロットが 1 つだから成立。層の正面口は式の `setPaint` |
| `map.paint(paint, filter)` | 層の指定が無い＝暗黙の「今のスロット」 |
| `map.gintFeatures()` / `map.userPbf()` | fid 空間が 1 つしか無い前提 |
| `map.standupGint(liftM)` | ドレープ設定がスタック全体に掛かる（層は常に地形へ載る＝§7.6） |
| `map.onGintClick(fn)` | ハンドラが 1 本・層の概念が無い＝`{ layer, fid }` を表せない |

**fid 空間の差が決定的**：単一スロットは「fid＝唯一のスロットの添字」、層は「fid＝その層の中の添字」＝層をまたいで衝突する。
層をまたぐ経路は必ず `{ layer, fid }` の対（§4.4）。`queryAll` は単一スロットを `layer: null` で末尾に足す（併用期の橋渡し）。

### 10.2 スタック全体の設定は作らない

旧 `applyGintData` の opts は載っている物すべてに掛かった（census2020 の防災スタックの `hover: !hazard`＝ハザード層が 1 つでも点くと筆のホバーもまとめて死んだ）。
層では `minZoom`/`maxZoom`/`tip`/`interactive`/`style` を層の属性にし、`hover` は属性にすらしない——**アクティブ層（§4.4）がその役を吸収**した
＝「ハザード層を non-interactive にし、筆をアクティブにする」と意図をそのまま書ける（2026-09-09 実装・`hover: !hazard` は撤去済み）。

### 10.3 合成（FC マージ）は利用者の作法・API にはしない

複数の主題を `properties._src` で刻んだ 1 つの FC に合成→1 回焼く→fid 表で塗り分ける、は restyle の哲学の正しい応用で、利用者の作法としては有効。
ただし API がこれを要求してはならない：合成はデータの集合が変わるたびに再焼きが要る（§8-1 に反する）・出自の刻印は利用者のデータ加工を意味する（source は不変＝§2）。
census2020 の防災は 2026-09-09 に層ごとの `addGint` へ移り、合成スタック（`stack://` キャッシュ）は撤去済み。

### 10.4 admin0 と世界帯の層

admin0（NE admin_0_countries＝海岸線＋国境）は 2026-09-09 から**独立層**（`addGint`・order −10・interactive:false・`fillMaxEdges: 0`・50m→10m は `setData`）。
世界帯の河川・海洋境界（order −9）と worldContent も interactive:false の追加層＝単一スロットはユーザー専用（スロットの取り合いは消えた）。
⚠ これらは `queryAll` / `map.on('click')` の hits に現れる（U4）。

## 11. 検定

| 頁 | 門 | 守るもの |
| :--- | :--- | :--- |
| `apps/ortho-japan/tests/t-gintlayers.html` | japan `verify:webgpu`（`t-gintlayers` と `?gl2=1` の**両土台**） | `map.addGint` の一周：on('load')・ready・setPaint・ホバー往復＋層 tip＋mouseenter/leave・query・queryAll（`{layer,fid}`）・setFilter・setData・setOrder・setLabel・式の text-field・feature-state・ラベルの filter 連動・map.on('click') の hits・admin0 層・on('move')・remove。**2026-09-26 追加**＝interactive:false の層を足してもホバーが生きる（U2）・query は filter を尊重・隠した層／ズーム域の外は queryAll に出ない・隠した面にホバーしない（U3）・地球儀の内部層は queryAll に出ない（U4）＝修正前のコードでは両土台とも落ちることを確認済み |
| `packages/globe/tests/t-gintmulti.html` | globe `verify:webgpu` | WebGPU 多層 11 項目：同フレーム 2 層・層別スタイル（UBO 検札）・層別表示・層またぎ pick・重ね順・setOrder・remove・dispose |
| `packages/globe/tests/t-gintmultigl.html` | globe `verify:ui` | WebGL2 多層の worker プロトコル 10 項目（ラベルと order の画素を含む） |
| `packages/globe/tests/t-gintgpu.html` | globe `verify:webgpu`（`?gintsb=0` も） | 17 項目：stencil 塗り・storage 経路・線の GPU pick・面の JS pick・tier・overlay・readback・ドレープ・点の fid スタイル・**ID 塗りのコロプレス** |
| `packages/globe/tests/t-backfill.html` | globe `verify:webgpu`・japan deploy の頭 | 裏半球の塗り（ゴースト・跨ぎ面・キャップ）12 項目 |
| `packages/globe/tests/t-gintdepth.html` | globe `verify:ui`・`verify:nocoi` | 隠線の破線・rank の退避・標高ドレープ 5 項目 |
| `packages/globe/tests/t-gintswap.html` | globe `verify:ui`・`verify:nocoi` | 単一スロットの入れ替え（再焼きなし）・bake-ahead の点火 12 項目 |
| `t-gintembed`（5）・`t-gintlod`（10） | globe `verify:ui`・`verify:nocoi` | 埋め込みと LOD |
| `apps/ortho-japan/tests/t-gndfaces.html` | japan `verify:ui`・`verify:webgpu` | 地面アトラスの面（`setPaint` の ID 塗りがアトラスへ焼かれる）9 項目 |
| `packages/ortho-core/tests/gint-expr.mjs` | ルートの `npm test`（ortho-core の test） | **§6.1 の契約の演算子すべて**が fid 表まで届く・§6.2 の評価規約（=== の比較・欠けた値・throw しない・入れ子の色の補間）・§7.1 の詰め方（幅 1/8・半径 1/4・visible・点の色・opacity・dash-id 0）・色の書式＝20 項目（2026-09-26・説明書の「約束する範囲」の裏打ち） |
| node：`gint-bake` `gint-drape` `gint-jitter` `gint-lod` `gint-seam`（ortho-core）・`t-anchors.mjs`（geopbf） | ルートの `npm test` | 焼き・ドレープ・周期・度アンカー |
| `packages/geopbf/tests/t-identify-accept.mjs` | geopbf の `test` | `identifyAt`/`findPolygon` の accept＝外すたびに次の候補（点→線→小さい面→大きい面→null）・bbox 台帳が無くても効く（9 項目・2026-09-26） |
| `packages/globe/tests/t-mllayers.html` | globe `verify:ui` | MapLibre 形の層（2 source の fill・押し出し・ヒートマップ・性質・重ね順・層ごとのイベント・getStyle）＝照会が「描かれている物」になった後も通る（出しズームの既定を MapLibre に揃えた） |
| `apps/ortho-japan/tests/t-gintsbperf.html` | **門ではない**（`bench-gintsb.mjs` だけ） | storage/テクスチャの計測 |

契約の式を足す時は、d.ts の一覧・説明書 §4 の表・`gint-expr.mjs` を同じコミットで揃える。

## 12. 未実装・未決

### 12-A 未実装（将来の候補・必要が立証されたら）

- クラス別 nonzero OR の和集合塗り（重複 × 離散の厳密化）＝今は後勝ちで代替
- 地物ごとの破線（`line-dasharray`・dash-id 欄は確保済み）
- zoom の毎フレーム補間（zoom 停留ごとの fid 列＋シェーダ lerp＝MapLibre の composite と同型）
- TF 前段（復号・投影・lodSnap を辺ごとに 1 回・全パス共有）と Morton の入口一回展開＝ID 塗り（全密度）を軽くする本命
- 派生物の IndexedDB 焼き（再訪で bake を飛ばす）
- ID バッファを面の pick に使う（findPolygon の GPU 化）
- storage 一本化（案 3・複数 binding で 128 MiB 上限を回避）
- 契約の式の拡張（`["id"]` を fid として評価文脈へ 等）

### 12-B 未決（実装と意図がずれている所＝本人裁定待ち・説明書は現状を書いた）

| # | 何が | 今の挙動 | 案 |
| :--- | :--- | :--- | :--- |
| U1 | `line-width` の単位 | paint の幅は**デバイス画素**（×dpr されない）。`style.lineWidth` と `circle-radius` は CSS px | ×dpr に揃える。⚠ 既存アプリの線（census2020・世界の線など）が高 dpr 端末で太る＝見た目の再調律とセット |
| ~~U2~~ | interactive:false の追加 | **解決 2026-09-26**：足す前のアクティブ層が持ったまま（GL エンジンにも既定層へ返す activate を足した） | — |
| ~~U3~~ | 隠した地物とホバー・照会 | **解決 2026-09-26**：ホバーも query/queryAll も filter を尊重（geopbf の accept・§4.5） | — |
| ~~U4~~ | 照会に内部層・消した層 | **解決 2026-09-26**：内部層（`_internal`）・消した層・ズーム域の外は queryAll/hits に出ない。interactive:false は入る（census2020 の重ね合わせ照会のため） | — |
| U5 | `layer.on('click')` | アクティブ層だけ | 現状を仕様にする（層またぎは map.on('click')） |
| U6 | アクティブ層の remove | main のゲートが null | 残る interactive 層の最後へ落とす（draft の意図） |
| U7 | MapLibre 形の filter | 同じ source の層の filter が `all` で結ばれる | 層ごとの filter を別の Gint 層に分ける／現状を明記のまま |
| U8 | 線だけの層 | pick の的を作らない＝ホバーしない | 線だけの層にも的を作る |
| U9 | 予算で飛ばした非アクティブ層 | 静止時に自前でフレームを要求しない | drawn の復帰を全層へ |
| U10 | order 0 | GL＝既定スロットの上・WebGPU＝下 | 既定層の order を揃える |
| ~~U11~~ | d.ts のずれ | **解決 2026-09-26**：`label.field`＝式・関数・文字列／`label.sort`＝number／`map.on('click')` の hits に `layer: GintLayerHandle \| null` と `feature`（型だけ・版上げで npm に届く） | — |
| U12 | fid の束ね方の鍵 | geopbf `topologyFullWasm` は properties を `join("\|")` で束ねる＝`dissolve` が 9/25 に直した「1 と "1"・"" と null を同じ地物に」を GintBUF の fid でまだ起こす（併合されずに残った別の地物が同じ fid を指す） | `dissolve` と同じ型つきの鍵（valKey）に揃える（geopbf・版上げ） |
| U13 | 縮退した塗りと filter | ID 塗りが使えない時（能力なし・fid 上限超え・移動中の安表現・3D の窓）の stencil 単色は fid 表を読まない＝隠した面も単色で塗る | stencil 扇の VS で visible ビットを見る（表がある時だけ） |

## 13. 変更履歴

- **2026-07-25** draft 0.1（§1〜§10・決定点 7 つ全部を裁定）
- **2026-07-26** プロトタイプ①〜④（fid 表・ID 塗り・式評価器の共用）・fid 整列の契約・多重登記の RG 約分・監査プローブ・境界メタの移植（中ズーム 2 ms）・256 px 世界へ統一
- **2026-08-19** アクティブ層の裁定（§4.4）・単一スロットとの線引き（§10）・実装は次へ送る
- **2026-09-09** 多層の実装（両土台・脱シングルトン・storage 経路・bake-ahead・層 tip・照会・ラベル・feature-state・setData/setOrder・settle 再評価・admin0 独立層）
- **2026-09-10** 点の fid スタイル（circle-color/radius）
- **2026-09-15** 重なりの後勝ち＋剥がし・周期の fid 別 bbox・縫い目跨ぎの扇の要・地平クランプ／球冠の間引き
- **2026-09-21** 3D の面＝地面アトラス（RTT）・線の地形適応細分
- **2026-09-23** 評価器の拡張（#33・基図の外来 style.json）・MapLibre 形の入口（#34）
- **2026-09-24** filter の `["zoom"]` も再評価・閾値 0.25
- **2026-09-26** **1.0**：実装に合わせて全面改稿（Issue #10）。公開の線（本人裁定）・draft からの差（§4.10）・実測（§8）・検定（§11）・未決の一覧（§12-B）
- **2026-09-26** 1.0 の後の直し（本人「2,3,1」）：U2＝interactive:false の追加でカーソルが動かない／U3・U4＝照会の意味（§4.5 の表・geopbf の accept・エンジンが ack で実レンジを返す・地球儀の内部層を照会から外す）／
  MapLibre 形の層の出しズームを MapLibre の既定に／d.ts の型（U11）。U12・U13 を未決に足した
