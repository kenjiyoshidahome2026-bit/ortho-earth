# MapLibre 互換の台帳（正典）

2026-09-26 起票。描画のインターフェースを MapLibre GL JS に揃える仕事の**唯一の台帳**。段を進めるたびにここを先に書き換える（変える物・変えない物）→検定を先に書く→実装。
計画の全文（調査の根拠つき）は本人の手元の計画書。ここは「いま何がどうなっているか」の正典。

## 1. 物差しと裁定

- **コンセプト（本人）**：「MapLibre を使う感覚で Cesium みたいなことができる」。
- **物差し**：①同じ MapLibre のコードで同じ絵・同じ答えになる ②MapLibre が標準で読めるファイルは読める（読めない＝不整合に数える）。
- **裁定（本人・2026-09-26）**：
  - 全体の互換モードは作らない。**黙って一部だけ違う物はモード無しで揃える**。
  - **z の目盛りだけ起動時の旗** `createGlobe({ zoomScale: "maplibre" })`（既定 `"ortho"`＝今の z＝内製アプリ・URL・.scenes は無傷）。
  - 明確で一貫した違いは文書に書く（§4）。

## 2. 旗の規則（表の正典＝`src/zoomscale.js`）

- エンジンの z は 256px 世界（`ortho-core/src/camera.js` の `WORLD_PX`）＝**MapLibre の z＋1**（`ML_DZ = 1`）。
- 旗を立てたら、公開面の**「数」の zoom は全部 MapLibre の z**（入力 +1・出力 −1）。**「文字列」（URL hash・`view` 文字列）はエンジン z**。
  - ML 名の口だけを換算しない理由：`flyTo(lon, lat, map.getZoom())` のような混用（apps/ortho-globe/sats.js に実例）が旗の下で 1 段ずつずれる。
- 換算しない（明記する例外）：source の tile z（raster/vector/raster-dem の minzoom・maxzoom・`map.raster.add` の spec）＝元々 MapLibre と同義／`map.cam`（内部の生の状態）／worker の overlay 契約の cam／台本の族（.scenes・playScenes・sceneTimeline・demo ガジェット）。
- 約束：null・undefined は素通し（`null+1` 事故を封じる）／ML の maxzoom は排他・gint・labels2d・raster showMax は包含＝境の変換はアダプタで 1 回。
- 換算の関数は 2 枚だけ：数と表＝`src/zoomscale.js`（globe）・式と層＝`ortho-core/src/mlstyle.js` の `shiftZoomExpr`・`shiftLayerZoom`・`normalizeMLLayer`・`rescaleZoomExpr`・`rescaleZoomNum`（core）。
- 層の目盛りは `metadata["ortho:dz"]` で申告できる（getStyle が付けて返す）。source の目盛りは getStyle の root の `metadata["ortho:sourceDz"]`。
- 換算する所は次の 3 か所だけ：起動オプション・外側の顔（`mlfacade.js`＝最後の `return map` だけを包む Proxy・map と map.gadget だけを代理）・ML 形の層と source の `dz`。**内部は常に素の map**（ガジェットは `func.apply(map)`＝素）。

## 3. 揃える物（モード無し）

| 項目 | 今 | 段 | 状態 |
|---|---|---|---|
| addLayer の旧式フィルタ・stops・{token} | setStyle 経路だけ読み替え | 1 | **済**（入口 1 本・gadget も） |
| style.json の geojson の層の zoom | ずらさない（mlstyle.js:154） | 1 | **済**（層と source に dz 1） |
| zoom のずらしの往復・入口の一本化（normalizeMLLayer） | 入れ子のまま育つ | 1 | **済**（畳む・metadata["ortho:dz"] で冪等・getStyle→setStyle 三往復で不変） |
| 式の意味（ML 由来だけ MapLibre の意味・ネイティブは今のまま） | 全部 JS の寛容な意味 | 3 | 未 |
| 同じ source の層（U7）・type とジオメトリ・既定値・fill の輪郭・circle-opacity | 1 枚に畳む・全ジオメトリ・既定色 | 4 | 未（爪車 known） |
| 知らない演算子 | 黙って受け取る | 5 | 未（爪車 known） |
| raster の層の minzoom/maxzoom | 無視 | 5 | 未（爪車 known） |
| 層の種類ごとの zoom（symbol・pattern・extrude・cluster） | ばらばら | 5 | 未 |
| 旧式の関数の default（属性の欠損） | 効かない | 5 | 未（爪車 known） |
| raster の url（TileJSON）を addLayer で | 型紙として使う | 6 | 未（爪車 known） |
| geojson の data の相対 URL | バケツ名として引く | 6 | 未（爪車 known） |
| {quadkey}・{ratio}・raster-dem custom・sprite 配列 | 無い | 6 | 未（爪車 known＝quadkey・custom） |
| ML 形 source の既定値（tileSize 512・maxzoom 22） | 256・18/14 | 6 | 未 |
| promoteId・generateId・clusterProperties・cluster_id | 無い | 6 | 未 |
| symbol を面・線に置く | 点だけ | 6 | 未（爪車 known） |
| 基図の層の実行時変更（visibility・paint・filter・beforeId） | 読むだけ | 7 | 未 |
| vector source を addLayer で（MVT の fill-extrusion ほか） | 不可 | 8 | 未（別計画） |

## 4. 文書に書く違い（意図した違い）

- z の目盛り（旗なしの既定）と緯度の差：MapLibre の globe はメルカトル等価（中心緯度の sec φ を含む）＝一律 ±1 は赤道でだけ正確（東京で約 0.3 段・北緯 60° で 1 段）。カメラに cos(lat) を戻さない既存の裁定は守る。
- queryRenderedFeatures は非同期。
- flyTo・easeTo・fitBounds・addLayer・setStyle は Promise を返す（MapLibre は this）。
- 基図（tile z で焼く）の paint は連続でない（MapLibre はズームに連続）。
- 線幅・点の半径の上限（表の u8：線 約 32px・点 約 64px）。
- 描き方の違う層の上下は描画の段で決まる（下から 基図→画像→gint→押し出し→ヒートマップ→集約→記号→模様）。

## 5. 不整合の台帳（前もって把握する物）

| # | 起き得る食い違い | 手当て | 門 | 状態 |
|---|---|---|---|---|
| R1 | 旗の下で二つの z が同居・分類漏れ | 換算は zoomscale.js の表だけ | `tests/zoomscale.mjs`（d.ts）＋ t-mlcompat の実行時キー | 門あり（段 0） |
| R2 | 素の map の漏れ・同一性（連鎖・Promise・イベント・once・off・Marker） | facade が差し替え・handler の WeakMap・once を組み直す・`map[RAW]` | t-mlzoom（段 2） | 未 |
| R3 | 二重換算・null+1・包含/排他 | 変換は zoomscale.js の関数だけ | node 単体（段 1） | 未 |
| R4 | 同じ ML の層が経路で違う・二度のずらし | normalizeMLLayer 一本・印・畳み・drawLayerOf・内部は *Native を直に呼ぶ | 爪車 node（shift-roundtrip・normalize-idempotent）＋ style:getstyle-roundtrip-stable | **済**（段 1） |
| R5 | ML の意味がネイティブ gint へ波及・手綱が ML の表を上書き | buildFidStyle 据え置き・手綱に buildTable 注入 | gint-expr.mjs・t-gintlayers | 未 |
| R6 | 評価器の変更が基図・内製 paint を変える・cache の出自混線 | 出自で分岐・出自は子ノードまで | `tests/expr-golden.mjs`（内蔵 style 534 件の指紋） | 門あり（段 0） |
| R7 | GL2 と WebGPU で違う（U10） | 予約 order 帯・両土台で検定 | t-gintlayers 流 | 未 |
| R8 | ML 層の意味の変更が内製の呼び手を変える | 呼び手を固定して人が見る・内部は native の入口（heatmapNative/clusterNative/symbolsNative/extrudeNative・addLayerAt/addSourceAt に dz を明示） | `tests/internal-callers.mjs` | 門あり（段 1 で 10→2） |
| R9 | 文書とコードのずれ | 段ごとに文書を直す | verify:npm・t-start-sync・spec §11 | 未 |
| R10 | gint 層が増える＝GPU メモリ | 連続する層だけ詰める・circle-stroke は表の第 4 語 | ?hud=1・LOW_MEM | 未 |
| R11 | 共有リンクが旗で変わる | hash/view 文字列は常にエンジン z | t-mlzoom | 未 |
| R12 | 並走ブランチとの衝突 | 段ごとに小さな PR | R1 の実行時キー | — |
| R13 | 地域の語・console の言語 | 地域名なし・英語 | verify:regionless | 門あり |
| R14 | npm の版と公開順 | 本人の号令・core→globe→japan | verify:npm | — |
| R15 | maxPitch の単位（ラジアン→度） | 1.6 超を度と読む移行 | t-camera | 未 |
| R16 | 1 枚の gint 層で部分を消す時の穴（線/点の色 α0＝既定色・縮退 stencil が表を見ない） | 幅/半径 0 に直す・fillMaxEdges:0 | 両土台の画素検定 | 未 |
| R17 | 層の種類ごとに zoom の扱いがばらばら | 段 5 | t-mlcompat の行列 | 未 |
| R18 | 公開 map を受け取る部品がエンジン z で計算（geoedit・common/gintView・anno） | 入口で `map[RAW] ?? map` | t-mlzoom | 未 |
| R19 | 変換した旧関数が寛容な欠損に依存 | default へ落ちる形で包む | 爪車 node（legacy-fn-interp-default） | 門あり（known） |
| R20 | queryRenderedFeatures が ML と違う（filter の意味・層ごとの filter・集約の層 id） | 段 4 | t-mlcompat | 未 |
| R21 | 基図の paint は tile z で焼く | 触らない（§4） | — | — |

## 6. 門（互換の爪車ほか）

- **互換の爪車**：`tests/mlcompat.mjs`（node の場面）＋ `tests/t-mlcompat.html?g=layers|style`（描いて確かめる場面・globe verify:ui）。既知の失敗＝`tests/mlcompat-known.json`（値＝直す段と理由）。
  - 一覧に無い失敗＝落ちる（退行）／一覧にあるのに通った＝落ちる（直ったので外す）。**場面を足すのは MapLibre と違うと分かった時**（先に場面を書いて赤を確かめる）。
- `tests/zoomscale.mjs`（分類漏れ）・`tests/internal-callers.mjs`（内製の呼び手）・`tests/expr-golden.mjs`（評価器の黄金の写し）＝globe の `npm test`（ルートの `npm test` に連結）。
- 段の終わりの門：ルート `npm test`・globe `verify`（regionless＋ui＋webgpu）・japan `verify:japan`・census build。worktree は `npm ci` してから。

## 7. 段の進み

版の束：段 1〜2 を 1 つの束として公開する予定（SDK @ortho-earth/japan 1.3.0・globe 1.3.0・core 1.4.0＝minor・d.ts の注記は「1.3.0〜」）。版の数は公開の時に上げる（公開は本人の号令）。


- [x] **段 0**（2026-09-26）：台帳・互換の爪車（node 9 場面・browser 17 場面＝known 21・見張り 5）・分類表 `src/zoomscale.js`（データだけ・どこからも import しない）・黄金の写し・内製の呼び手の許可表。挙動の変更なし。
- [x] **段 1**（2026-09-26）：ML の層の入口＝core `normalizeMLLayer`（読み替え＋dz＋冪等の印）・globe の登録簿に dz（層・source）・`drawLayerOf` 1 本・setter/getter は呼び手と層の目盛りの差を埋める・style.json の geojson 層と source は dz 1・問い合わせの filter も入口へ・ML 形 gadget は入口で正規化→中身（*Native）／内部の描き出し・worldcontent・見通し線は中身を直に。公開の口の目盛り `PUBLIC_DZ` は 0 のまま（旗は段 2）。式の検査（知らない演算子で投げる）は段 5。
- [ ] 段 2：旗の顔（mlfacade・RAW・Marker と部品・maxPitch の度・raster と手綱の dz・d.ts）
- [ ] 段 3：評価器の出自（compile の子まで・worker へ渡る平の印・新演算子は両方へ）
- [ ] 段 4：fill / line / circle の約束（mltables・連続する層だけ詰める・予約 order 帯・U10・dash-id）
- [ ] 段 5：式の残りと層の種類ごとの zoom
- [ ] 段 6：読めない形式（小物）
- [ ] 段 7：基図の層を触れるように
- [ ] 段 8：エンジン級（着手前に別計画）
