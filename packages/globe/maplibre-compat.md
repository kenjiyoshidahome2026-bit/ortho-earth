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
- 換算する所は次の 3 か所だけ：起動オプション（`bootOptsIn`＝createGlobe の最初）・外側の顔（`src/mlfacade.js`＝最後の `return map` だけを包む Proxy・map／map.gadget／map.raster だけを代理）・ML 形の層と source の `dz`（`PUBLIC_DZ`）。**内部は常に素の map**（ガジェットは `func.apply(map)`＝素・地域パックの install も素）。
- **実装済み（段 2）**：旗なしは素の map をそのまま返す（Proxy も無い）。旗つきの顔は、連鎖の戻り値・Promise の解決値・層イベントの `target`・contextmenu の `c.map`・利用者ガジェットの `this` を顔に差し替え、`once` は顔の on/off の上で組む（handler は (ev, 層キー) ごとの WeakMap）。gint の手綱は包まず、addGint に `_dz` を渡して手綱の中で換算（公開の setPaint と中の paintNow を分けた＝二度換算しない）。素の map は `map[RAW]`（`Symbol.for("ortho-earth.map.raw")`）。Marker の登録簿・geoedit・common/gintView は入口で素へ戻る。
- ⚠層の口（addLayer…・ML 形 gadget・問い合わせの filter）は**素の map でも公開の目盛り**（PUBLIC_DZ）＝内部の呼び手は addLayerAt/addSourceAt/*Native に dz を明示する（`tests/internal-callers.mjs` が見張る）。

## 3. 揃える物（モード無し）

| 項目 | 今 | 段 | 状態 |
|---|---|---|---|
| addLayer の旧式フィルタ・stops・{token} | setStyle 経路だけ読み替え | 1 | **済**（入口 1 本・gadget も） |
| style.json の geojson の層の zoom | ずらさない（mlstyle.js:154） | 1 | **済**（層と source に dz 1） |
| zoom のずらしの往復・入口の一本化（normalizeMLLayer） | 入れ子のまま育つ | 1 | **済**（畳む・metadata["ortho:dz"] で冪等・getStyle→setStyle 三往復で不変） |
| 式の意味（ML 由来だけ MapLibre の意味・ネイティブは今のまま） | 全部 JS の寛容な意味 | 3 | **済**（ctx.origin・層の印 metadata["ortho:origin"]・基図の worker/問い合わせ/gint/記号/集約/押し出し/模様/画像の色調整まで） |
| 同じ source の層（U7）・type とジオメトリ・既定値・fill の輪郭・circle-opacity | 1 枚に畳む・全ジオメトリ・既定色 | 4 | **済**（mltables・連続する層だけ詰める・予約 order 帯・層ごとの問い合わせ） |
| line-dasharray・circle-stroke（gint の線/点） | 実線・縁なし | 4b | **済**（表の第 4 語を型で使い分け・bit1＝中空・両シェーダ） |
| 知らない演算子 | 黙って受け取る | 5 | **済**（KNOWN_OPS・unknownOps＝式の位置だけ見る・公開の口は投げる・style.json の基図は数えて飛ばす） |
| raster の層の minzoom/maxzoom | 無視 | 5 | **済**（表示窓・maxzoom 排他） |
| 層の種類ごとの zoom（symbol・pattern・extrude・cluster） | ばらばら | 5 | **済**（記号＝出しズームも当て直す・押し出し/canvas2D＝止まるたびに鍵を見て描き直す・集約＝層ごとの範囲と層 id・模様/canvas2D の線も問い合わせに出る） |
| 旧式の関数の default（属性の欠損） | 効かない | 5 | **済**（["case", ["has", 属性], 式, default]） |
| raster の url（TileJSON）を addLayer で | 型紙として使う | 6 | **済** |
| geojson の data の相対 URL | バケツ名として引く | 6 | **済**（globe 側で頁から解決・geopbf は触らない） |
| {quadkey}・{ratio}・raster-dem custom・sprite 配列 | 無い | 6 | **済**（{ratio} は常に 1x のまま＝文書） |
| ML 形 source の既定値（tileSize 512・maxzoom 22） | 256・18/14 | 6 | **済**（raster・raster-dem・TileJSON。?dem= と map.raster.add はネイティブの既定のまま） |
| promoteId・generateId・clusterProperties・cluster_id | 無い | 6 | **済**（id＝Feature.id→promoteId→並び順・隠しの属性で写す＝同じ属性の地物も別々・getClusterExpansionZoom） |
| symbol を面・線に置く | 点だけ | 6 | **済**（面＝到達不能極・線＝各部分の最初の頂点＝MapLibre の点置き） |
| 基図の層の実行時変更（visibility・paint・filter・beforeId） | 読むだけ | 7 | **済**（上書きの台帳・visibility は結合で外す・他は建て直し・重ね順は固定＝文書） |
| vector source の fill-extrusion（MVT の 3D 建物・addLayer・style.json） | 不可（style.json は飛ばす・addSource vector は黙って壊れる） | 8① | **済**（gadgets/vtextrude.js・既存の経路は無改修） |
| vector source の fill/line/circle/symbol・基図の source への差し込み | 不可 | 8⑤ | 未（今は名前を挙げて投げる＝黙って壊れない・爪車の既知） |
| vector の押し出しの feature-state | 無い | 8①b | 未（爪車の既知） |

## 4. 文書に書く違い（意図した違い）

- z の目盛り（旗なしの既定）と緯度の差：MapLibre の globe はメルカトル等価（中心緯度の sec φ を含む）＝一律 ±1 は赤道でだけ正確（東京で約 0.3 段・北緯 60° で 1 段）。カメラに cos(lat) を戻さない既存の裁定は守る。
- queryRenderedFeatures は非同期。
- `map.view` は ortho の状態物（pitch/bearing はラジアン・hash はエンジンの z の文字列）。旗つきでは view.zoom だけ公開の目盛り。`map.cam` は内部の生の状態（常にエンジンの z）。
- チルト上限：`maxPitch()` はラジアン（ortho の口）・`getMaxPitch()` は度（MapLibre 同名）。`opts.maxPitch`／`setMaxPitch` は 1.3.0〜度（1.6 以下は従来のラジアン＝非推奨の警告）。
- flyTo・easeTo・fitBounds・addLayer・setStyle は Promise を返す（MapLibre は this）。
- 基図（tile z で焼く）の paint は連続でない（MapLibre はズームに連続）。
- 線幅・点の半径の上限（表の u8：線 約 32px・点 約 64px）。
- 破線は先頭の [線, 間] の対だけ（3 要素以上の模様は近似）。
- 基図の層の重ね順は固定（moveLayer は効かない）・利用者の層は基図の層の間に差し込めない（beforeId に基図の層 id を渡してもよい＝描画の段で決まる）。
- 描き方の違う層の上下は描画の段で決まる（下から 基図→画像→gint→押し出し→ヒートマップ→集約→記号→模様）。
- vector の押し出し（段 8①）：
  - ["zoom"] を含む paint（伸び上がり）は止まった所で評価し直す（MapLibre はズーム中も連続）＝止まった絵は同じ。
  - 光は読まない（style の light・MapLibre の光の式）＝この地図の建物メッシュの陰影。壁の縦の陰影（vertical-gradient）だけ MapLibre の式を頂点色に焼く。
  - 半透明（opacity<1）は裏面を除いて重ねる＝建物どうしが重なる所は濃くなる（MapLibre は層を 1 枚にしてから重ねる）。
  - 地形の上：頂点ごとに地表の標高へ（屋根は斜面に沿う・MapLibre は平らな屋根）。海の上は海面（renderer と同じく負の標高は 0）。
  - 遠景の打ち切り＝最細の z −2 より粗いタイル・48 枚（LOW_MEM 24）・予算 256MB（LOW_MEM 96MB）を超える遠い方は出さない。
  - 基図と同じ source の押し出しはタイルを基図の配管と別に取る（HTTP キャッシュ頼み・PMTiles の範囲取得は重なり得る）。
  - 影を落とさない（keep2d のメッシュ＝既存の押し出しと同じ）。
  - 問い合わせ：タイルをまたぐ地物は複数返り得る（MapLibre の文書どおり）。
  - 未対応：fill-extrusion-pattern/translate（警告して描く）。
  - 地域の基図（日本）の自動の建物（地理院の推定×1.6）は層 "building-extrusion"＝出し入れだけ（色・filter・出しズームは変えられない＝投げる・問い合わせには出ない・PLATEAU は別の口）。
  - source の出典（TileJSON の attribution・無ければホスト名）は押し出しの層がある間だけ出典の欄に出る（基図の出典と同じ文は重ねない）。

## 5. 不整合の台帳（前もって把握する物）

| # | 起き得る食い違い | 手当て | 門 | 状態 |
|---|---|---|---|---|
| R1 | 旗の下で二つの z が同居・分類漏れ | 換算は zoomscale.js の表だけ | `tests/zoomscale.mjs`（d.ts）＋ t-mlcompat の実行時キー＋ `tests/mlfacade.mjs`（表の in/out/io/event を顔が全部換算しているか） | **済**（段 2） |
| R2 | 素の map の漏れ・同一性（連鎖・Promise・イベント・once・off・Marker） | facade が差し替え・handler の WeakMap・once を組み直す・`map[RAW]` | `tests/mlfacade.mjs`（70 項目）＋ t-mlzoom?zs=maplibre|ortho | **済**（段 2） |
| R3 | 二重換算・null+1・包含/排他 | 変換は zoomscale.js の関数だけ・手綱は公開の口と中の口を分ける | `tests/mlfacade.mjs`（null 素通し・二度換算なし）。包含/排他の境は段 5 | 一部済 |
| R4 | 同じ ML の層が経路で違う・二度のずらし | normalizeMLLayer 一本・印・畳み・drawLayerOf・内部は *Native を直に呼ぶ | 爪車 node（shift-roundtrip・normalize-idempotent）＋ style:getstyle-roundtrip-stable | **済**（段 1） |
| R5 | ML の意味がネイティブ gint へ波及・手綱が ML の表を上書き | buildFidStyle 据え置き・手綱に buildTable/zoomKey 注入 | gint-expr.mjs・t-gintlayers（両土台）・core tests/mltables.mjs | **済**（段 4） |
| R6 | 評価器の変更が基図・内製 paint を変える・cache の出自混線 | 出自で分岐（ctx.origin）・cache は出自ごと・子ノードまで同じ出自でコンパイル・既定値へ落とすのは ML の時だけ | `tests/expr-golden.mjs`（534 件不変）＋ 爪車 node（origin-cache-isolation・native-compare-null-kept） | **済**（段 3） |
| R7 | GL2 と WebGPU で違う（U10） | 予約 order 帯（1000＋）・両土台で検定 | t-mlcompat?g=layers を verify:ui（GL2）と verify:webgpu の両方に | **済**（段 4・U10 はネイティブの order 0 に残る） |
| R8 | ML 層の意味の変更が内製の呼び手を変える | 呼び手を固定して人が見る・内部は native の入口（heatmapNative/clusterNative/symbolsNative/extrudeNative・addLayerAt/addSourceAt に dz を明示） | `tests/internal-callers.mjs` | 門あり（段 1 で 10→2） |
| R9 | 文書とコードのずれ | 段ごとに文書を直す | verify:npm・t-start-sync・spec §11 | 未 |
| R10 | gint 層が増える＝GPU メモリ | 連続する層だけ詰める（pass が増えるのは同じ型の重なりだけ）・隠した層は詰め方に残す（出し入れで焼き直さない） | ?hud=1・LOW_MEM（実測は段 4b でまとめて） | 一部 |
| R11 | 共有リンクが旗で変わる | hash/view 文字列は常にエンジン z | t-mlzoom（viewZoom・onceSettle の hash） | **済**（段 2） |
| R12 | 並走ブランチとの衝突 | 段ごとに小さな PR | R1 の実行時キー | — |
| R13 | 地域の語・console の言語 | 地域名なし・英語 | verify:regionless | 門あり |
| R14 | npm の版と公開順 | 本人の号令・core→globe→japan | verify:npm | — |
| R15 | maxPitch の単位（ラジアン→度） | 1.6 超を度と読む移行・getMaxPitch（度） | t-mlzoom（getMaxPitch） | **済**（段 2） |
| R16 | 1 枚の gint 層で部分を消す時の穴（線/点の色 α0＝既定色・縮退 stencil が表を見ない） | 幅/半径 0 に直す・fillMaxEdges:0・zoom 域の境で作り直す（zoomKey） | core mltables.mjs・t-mlcompat（両土台） | **済**（段 4） |
| R17 | 層の種類ごとに zoom の扱いがばらばら | 段 5 | t-mlcompat の行列（記号・集約・押し出し・canvas2D の線） | **済**（段 5） |
| R18 | 公開 map を受け取る部品がエンジン z で計算（geoedit・common/gintView・anno） | 入口で `map[RAW] ?? map`（anno はガジェット＝素の this） | t-mlzoom（marker）・コードの入口 | **済**（段 2） |
| R19 | 変換した旧関数が寛容な欠損に依存 | default へ落ちる形で包む | 爪車 node（legacy-fn-interp-default） | **済**（段 5） |
| R20 | queryRenderedFeatures が ML と違う（filter の意味・層ごとの filter・集約の層 id） | filter は ML の出自（段 3）・層ごとに 1 件（段 4）・集約の層 id＝ML の層 id と層ごとの範囲・canvas2D の線/模様も（段 5）。cluster_id・getClusterExpansionZoom は段 6 | t-mlcompat・t-mllayers | 一部済 |
| R21 | 基図の paint は tile z で焼く | 触らない（§4） | — | — |

段 8①（vector の押し出し）で前もって把握した食い違い：

| # | 食い違い | 手当て | 門 | 状態 |
|---|---|---|---|---|
| V1 | タイルの縁の壁・バッファの二重屋根・切った後の退化 | 枠 [0, extent] で切る・枠の上の辺は壁なし・退化は捨てる | vtextrude.mjs（縁・面積・穴・凹） | **済** |
| V2 | LOD の切り替えで穴かダブり | 子が全部揃うまで祖先（retain）・空も「揃った」 | vtextrude.mjs（retain 5 項目） | **済** |
| V3 | ズームの式が連続でない・止まるたびの上げ直し | 曲線の鍵（止まりの外は一定）・幾何は残して高さと色だけ | vtextrude.mjs＋爪車 zoom-interp-height | **済**（連続でないのは §4） |
| V4 | filter の zoom の目盛り | 過拡大の z＋1（正規化した式の中で MapLibre の z に戻る） | vtextrude.mjs（境ちょうど） | **済** |
| V5 | 基図の source を二度取る | HTTP キャッシュ頼み（§4） | — | 文書 |
| V6 | 光・半透明の重ね | 裏面除去・縦の陰影は MapLibre の式（§4） | 実機で MapLibre 本体と並べた | 文書 |
| V7 | 地域の基図の自動の建物と二重 | 層 "building-extrusion"＝出し入れ（render worker の noBld を実行時に・撮影も同じ・伏せる間は足元の塗りをチルトでも）・案内 1 回 | japan t-bld（伏せる→43% 変わる・戻す→0%・色は投げる・removeLayer） | **済**（2026-09-27・本人「1→2」） |
| V8 | 重さ（1 フレーム 1 件の転送・頂点 28B・GL の呼び出し数・WebGPU の 512） | 予算を見た選び・枚数上限・1 タイル 1 層 1 メッシュ・main で 1 フレーム 1 件・幾何キャッシュ | 実機の数（§7） | 一部（?hud=1 の実測は次） |
| V9〜V10 | 伏せ枠の取り合い・フライト中の詰まり | 伏せ枠は使わない・フライト中は取得と組み立てを止める（出し入れは毎回） | — | **済** |
| V11 | 当たり（立体）・id・promoteId | worker の地物＋屋根と壁の投影 | 爪車（屋根・浮き・継ぎ目・中庭） | **済** |
| V12 | 地形の外で埋まる | drape（どこでも地表へ）・当たりの地面は負の標高を 0 に | 実機（マンハッタン） | **済** |
| V13〜V18 | 既定の挙動の変化・旗の目盛り・両土台・地域の語・transformRequest/独自スキーム/PMTiles・影 | SDK 注記・drawLayerOf・同じメッシュ経路・語なし・requester・§4 | 爪車（GL2/WebGPU・addProtocol・PMTiles）・regionless | **済**（影は文書） |

## 6. 門（互換の爪車ほか）

- **互換の爪車**：`tests/mlcompat.mjs`（node の場面）＋ `tests/t-mlcompat.html?g=layers|style`（描いて確かめる場面・globe verify:ui）。既知の失敗＝`tests/mlcompat-known.json`（値＝直す段と理由）。
  - 一覧に無い失敗＝落ちる（退行）／一覧にあるのに通った＝落ちる（直ったので外す）。**場面を足すのは MapLibre と違うと分かった時**（先に場面を書いて赤を確かめる）。
- `tests/zoomscale.mjs`（分類漏れ）・`tests/internal-callers.mjs`（内製の呼び手）・`tests/expr-golden.mjs`（評価器の黄金の写し）＝globe の `npm test`（ルートの `npm test` に連結）。
- 段の終わりの門：ルート `npm test`・globe `verify`（regionless＋ui＋webgpu）・japan `verify:japan`・census build。worktree は `npm ci` してから。
- **main で既存の失敗（この仕事の外）**：globe verify:webgpu の t-overlaydepth（clearIsOne・main 92420d0e で再現を確認）。t-ao は main の #61（AO の直し）で緑になった（main を取り込んだ 930b7c40 で確認）。段の門では「既存の項目が同じ値で落ちる」ことだけを確かめ、別件として切り出した。
- 揺れの観察：t-linedeco?nomd=1 の videoMoved（段 1 の全頁で 1 回・単独では緑）／verify:ui 側の t-overlaydepth（GL2）の clearIsOne（段 2・段 6 の全頁で各 1 回・単独ではいつも緑＝webgpu 側の既存の失敗と同じ検査項目）／japan の t-print（段 4 の全頁で時間切れ 1 回・単独 2 回とも緑）。

## 7. 段の進み

版の束：段 1〜2 を 1 つの束として公開する予定（SDK @ortho-earth/japan 1.3.0・globe 1.3.0・core 1.4.0＝minor・d.ts の注記は「1.3.0〜」）。版の数は公開の時に上げる（公開は本人の号令）。


- [x] **段 0**（2026-09-26）：台帳・互換の爪車（node 9 場面・browser 17 場面＝known 21・見張り 5）・分類表 `src/zoomscale.js`（データだけ・どこからも import しない）・黄金の写し・内製の呼び手の許可表。挙動の変更なし。
- [x] **段 1**（2026-09-26）：ML の層の入口＝core `normalizeMLLayer`（読み替え＋dz＋冪等の印）・globe の登録簿に dz（層・source）・`drawLayerOf` 1 本・setter/getter は呼び手と層の目盛りの差を埋める・style.json の geojson 層と source は dz 1・問い合わせの filter も入口へ・ML 形 gadget は入口で正規化→中身（*Native）／内部の描き出し・worldcontent・見通し線は中身を直に。公開の口の目盛り `PUBLIC_DZ` は 0 のまま（旗は段 2）。式の検査（知らない演算子で投げる）は段 5。
- [x] **段 2**（2026-09-26）：旗 `zoomScale:"maplibre"`＝起動 opts の換算・外側の顔 `mlfacade.js`・手綱の `_dz`（公開の口と中の paintNow を分けた）・map.raster の表示窓・`RAW`・Marker/geoedit/gintView の入口・maxPitch の度と getMaxPitch・d.ts の旗の表。門＝`tests/mlfacade.mjs`・t-mlzoom（旗あり/なし）。
- [x] **段 3**（2026-09-26）：評価器の出自＝ctx.origin "ml" だけ MapLibre の型の約束（型の合わない比較・真偽でない条件・数でない補間の入力・外れた型の表明＝評価エラー＝undefined／get の欠損＝null／to-number・型の表明の予備）。cache は出自ごと。印は normalizeMLLayer が付ける平の性質（worker へ届く）。新演算子（at・三角関数・to-rgba・cubic-bezier・index-of の開始位置・get/has の object）は両方。isColor（color.js）。ネイティブの結果は黄金の写しで不変を確認。門＝爪車 node 13 場面・browser 2 場面（gint の case・基図の get 欠損）。
- [x] **段 4**（2026-09-26）：fill / line / circle の約束＝core `mltables.js`（packMLLayers・buildMLTable・zoomSensitivity）・手綱の buildTable/zoomKey・全体の詰め方から組み直し（同じ署名は使い回し・隠した層も残す・立て続けは新しい方の完了を待つ・読めない source は巻き添えにしない）・予約 order 帯・interactive:false・fillMaxEdges:0・feature-state は source に住む・問い合わせは層ごと。門＝core mltables.mjs 11 項目・爪車（両土台）で 6 件が直った。
- [x] **段 4b**（2026-09-26）：破線と円の縁＝表の第 4 語（線＝[線, 間] 1/8px u16×2・点＝縁の色）・点では線幅の欄が縁の幅・flags bit1＝塗り無し（中空の円）・縁は半径の外側・GL2（programs.js）と WGSL（gintwgsl.js）の両方で「0 なら従来どおり」。門＝core mltables.mjs・爪車 3 場面（破線・縁・中空）を両土台で。**爪車の既知は 0 件**。GPU メモリの実測は段 7 以降でまとめて。
- [x] **段 5**（2026-09-26）：式の検査（KNOWN_OPS＝build の case と突き合わせる検定つき・unknownOps・公開の口で投げる・基図は数えて飛ばす）・旧関数の default（R19）・種類ごとの zoom（記号の出しズーム・集約の層 id と範囲・押し出しと canvas2D の線の描き直し・raster の表示窓）・canvas2D の線/模様の問い合わせ。門＝爪車 node 3 場面・browser 4 場面の行列。
- [x] **段 6**（2026-09-26）：読めない形式＝相対 URL・TileJSON の raster・{quadkey}・raster-dem custom・複数 sprite・ML の source の既定値・feature の id（promoteId/Feature.id/並び順）・clusterProperties/cluster_id/getClusterExpansionZoom・記号を面と線に。node の既知 0・browser の既知は段 4b の 2 件だけ。
- [x] **段 7**（2026-09-26）：基図の層を実行時に＝上書きの台帳 baseOverrides（paint/layout/filter/出しズーム/削除）→有効な style を建て直し・visibility は baseVis＝結合の添字とラベル（worker のラベルに層の添字 li）で外すだけ・テーマを越えて残し setStyle で捨てる・getLayer/get*Property/getFilter/getStyle も基図の層を返す。門＝爪車 style 群 5 場面（外来 style.json の基図）。**検定の穴**：地域の基図（日本の gsi 等）の上での上書きとテーマ切り替えを越えて残ることは門が無い（仕組みは同じ withBaseOverrides・日本のデータが要る頁は japan 側＝次に足す）。2026-09-26 に dev server（5174）で手で確認済み＝gsi の water を赤→c=dark へ切り替えても赤のまま・road の visibility none。
- [x] **段 8①**（2026-09-26・branch claude/maplibre-vector-extrusion＝#66 と別の PR）：vector source の fill-extrusion＝新しいファイルだけ（`gadgets/vtextrude.js`（選ぶ・取る・置き換え・送る・予算・問い合わせ）・`vtextrude-worker.js`（役 "vtextrude"・解読・枠で切る・評価・幾何キャッシュ）・`vtmesh.js`（純関数））。既存の経路（model.js の押し出し・extrude.js・finishMesh・model-worker・renderworker・renderer・基図の配管・PLATEAU・tiles3d）は無改修。core は口を足すだけ（exports `./expr` `./color`・index に `fetchPMTilesRaw`）。
  - 入口：kindOf（fill-extrusion × vector）・基図の source 名（外来 style＝その名前・地域の基図＝"basemap"）・style.json の vector の押し出しを利用者の層の口へ・setStyle で付け替え・visibility は伏せるだけ・isSourceLoaded は組み上がり待ち（カメラが動いている間と組み直し待ちも false）。
  - 門：`tests/vtextrude.mjs`（node 35 項目＝輪の分類・枠で切る・縁の壁・屋根の面積・外向きの法線・縦の陰影・置き換え・ズームの鍵・filter の zoom）＋爪車 `t-mlcompat.html?g=vector`（17 場面・GL2 と WebGPU・既知 2＝⑤ と ①b）。試料＝`tests/fixtures/mlcompat/make-mvt.mjs`（XYZ・PMTiles・TileJSON）。
  - 実機（OpenFreeMap）：liberty の building-3d（渋谷 12 タイル・約 90MB／マンハッタン 15 タイル・58MB）・MapLibre の例「Display buildings in 3D」をコードそのまま（旗つき）で MapLibre 本体と並べて同じ絵（違いは z の緯度差と伸び上がりの連続性＝§4）。
  - 轍：①`["!", ["get","hide_3d"]]` は属性の無い地物で MapLibre でも評価エラー＝偽（MapLibre の例は `["!=", …, true]`）②setMesh は配列を transfer＝送った後に数えると 0 ③海の上は getHeight が海底（負）＝主スレッドの projectLL はずれる（renderer は 0 に切る・別件）④動的解像度で canvas の実寸が縮む（816×510）＝検定の投影は CSS の大きさ×cam.dpr で組む。
  - 残り：①b feature-state・⑤ 2 本目以降のベクタ source の fill/line/circle/symbol と基図の source への差し込み。
- [x] **段 8① の続き**（2026-09-27・本人「マージを済ませてから 1→2」・branch claude/maplibre-auto-buildings-toggle）：地域の基図の自動の建物＝層 "building-extrusion"（getLayer/getStyle/setLayoutProperty の visibility/getLayoutProperty/removeLayer・他は投げる）・render worker の `noBld` を実行時に（`set` の cmd を 1 つ足す）＋撮影（snapshot）でも伏せる（旧＝画面だけの診断ノブ＝撮影には写っていた）・伏せる間は足元の塗り（bldFill）をチルトでも出す・?nobld=1 の見え方は今のまま。vector source の出典を出典の欄へ（`Source: $1`＝翻訳を増やさない）。門＝japan t-bld に 4 場面・爪車 source-attribution。実機＝日本のアプリで OpenFreeMap の 3D 建物に差し替え（東京駅前）。
- [ ] 段 8②〜⑤：基図のアイコン・線に沿うラベル・hillshade・2 本目以降のベクタ source（着手前にそれぞれ別計画）
