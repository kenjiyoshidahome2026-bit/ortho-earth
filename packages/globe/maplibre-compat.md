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
| vector source の fill/line/circle/symbol・基図の source への差し込み | 不可 | 8⑤ | **済**（2026-09-27・本人裁定「別の流れ・基図の上」＝gadgets/vtdraw.js・renderer の "user" の枠・基図の配管は無改修） |
| vector の描く層の feature-state | 無い（状態は置き場に残るが絵は既定） | 8⑤b（#109） | **済**（2026-09-29・paint だけが読む・変わった地物を含むタイルだけ組み直す・問い合わせに state・core の組み立てに省略できる stateOf＝基図は渡さない） |
| vector の描く層を基図の層の間へ差し込む（beforeId が基図の層を指す・style の 2 本目の source の層の順） | 基図の上（近似） | #123 | **済**（2026-09-29・描く時のアンカー表＝タイルは組み直さない・任意の層の間・3D の塗りは基図の線より下・geojson の層は基図の上のまま） |
| vector の押し出しの feature-state | 無い | 8①b | **済**（2026-09-27・sourceLayer 必須・getFeatureState・変わった地物のタイルだけ組み直す・問い合わせに state） |
| MLT（MapLibre Tile）の vector source（`"encoding":"mlt"`・PMTiles tileType 6） | 未対応（unknown＝空） | #88 | **済**（2026-09-27・core の登録簿 `tileformat.js`＝MVT も同じ差し込み口・プラグイン `@ortho-earth/tile-formats`＝`#tile-formats` の alias・解読器は最初の MLT タイルで動的 import・爪車 `t-mlcompat?g=mlt`＝MVT と同じ絵と答え） |
| geojson の押し出しの ["zoom"] の式（伸び上がり）の描き直し | どこに ["zoom"] があっても 0.25 刻みごとに全体を評価し直して上げ直す（止まりの外でも） | 5b | **済**（曲線の鍵・R22） |
| queryRenderedFeatures の geojson の押し出し | 地面の足跡で当てる（傾けて屋根を押すと外れる） | 5b | **済**（立体＝屋根と壁・近い順・R23） |
| color-relief の層（`["elevation"]` で段彩） | 無い（style は知らない演算子で層を落とす・addLayer は投げる） | #114 | **済**（2026-09-29・core の式 elevation・globe `colorrelief.js`＝画像タイル層・DEM の在庫は source ごとに共有・門 add-a-color-relief-layer 2→3） |

## 4. 文書に書く違い（意図した違い）

- z の目盛り（旗なしの既定）と緯度の差：MapLibre の globe はメルカトル等価（中心緯度の sec φ を含む）＝一律 ±1 は赤道でだけ正確（東京で約 0.3 段・北緯 60° で 1 段）。カメラに cos(lat) を戻さない既存の裁定は守る。
- queryRenderedFeatures は非同期。当たり方は MapLibre と同じ（2026-09-27・§8 B：線は線幅の半分＋|ずらし|・円は半径＋縁・面は内側・既定の許し 0）。`tolerance`（足す px）は拡張。GeoJSON（gint）の線の当たりは南北に 1/cos(緯度) だけ広い（識別が度の空間の円＝東西を取りこぼさない側に寄せた・点は画面の距離で締め直す）。単一スロットの user 層（内製）は従来の 3px。
- getStyle は外来 style の全ての層を元の順で返す（§8 A）。描かない層（線に沿う注記・アイコン・hillshade・塗りより下の画像・知らない型）は `metadata["ortho:drawn"]:false`。set 系は記録だけ（絵は変わらない）。利用者の層の beforeId が style の層を指す時は getStyle の順だけその前（描く段は基図の上）。
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
  - feature-state は paint だけが読む（filter は読まない＝MapLibre と同じ）。状態が変わると、その地物を含むタイルの色と高さを組み直して上げ直す（1 棟で約 0.16 秒・実機の GPU）＝MapLibre のように即座ではない。
  - 地域の基図（日本）の自動の建物（地理院の推定×1.6）は層 "building-extrusion"＝出し入れだけ（色・filter・出しズームは変えられない＝投げる・問い合わせには出ない・PLATEAU は別の口）。
  - source の出典（TileJSON の attribution・無ければホスト名）は押し出しの層がある間だけ出典の欄に出る（基図の出典と同じ文は重ねない）。
- vector の描く層（fill／line／circle／symbol・段 8⑤）：
  - 描く場所：beforeId（の鎖の先）が基図の層を指せばその層の直前（#123・MapLibre と同じ）・指さなければ基図の塗りと線の上。注記は常に一番上（注記は別の canvas）。style の 2 本目以降の source の層は style の順。利用者の層どうしの順は正確（source をまたいでも）。
  - 差し込みの違い（#123）：①3D（地形あり）では塗りが地面へ焼かれる＝利用者の塗りは基図の塗りの間には入るが、基図の線より常に下（基図自身と同じ規則）。線どうしは正確 ②差し込むのは最後に描く基図の枠（main）＝ズーム中に出る粗い下地（base）の上の層の下には入らない（下地が見える間だけ・下地の上に載る）③geojson の層（gint）は基図の上のまま（別のパス）④基図の層どうしの順は固定（moveLayer は効かない）。
  - 3D（地形あり）では塗りを地面に焼く（アトラス）＝基図の線の下・2D では上（基図自身も 3D では「塗りは全部線の下」）。gint（geojson の層）より下。
  - paint／layout の ["zoom"] は止まった所で評価し直す（0.25 刻みの z で組む＝隣り合うタイルの線幅は揃う）。filter の ["zoom"] はタイルの（過拡大の）z。
  - circle：画面に向いた円（MapLibre の既定 circle-pitch-scale "map" の遠近の縮みは無い）・circle-pitch-alignment "map"・blur・translate は未対応。塗りの透ける円の縁は止まった所のズームで合わせた輪（動いている間は地図と一緒に伸び縮みする）。
  - symbol：点と面（到達不能極）の注記（基図と同じ部品＝text-font は段 2 から読む）・記号（icon-image）は段 3 から基図と同じ注記層で（sprite／addImage の記号帳・icon-size/-anchor/-offset/-rotate/-padding/-allow-overlap/-ignore-placement/-optional・text-optional・icon-text-fit・icon-color（SDF）・icon-opacity）。線に沿う注記（symbol-placement line／line-center・symbol-spacing・max-angle・keep-upright）は段 4 から基図と同じ注記層で（字を 1 字ずつ線に沿わせる）。
  - 線の端と継ぎは常に丸（基図と同じ）。タイルの枠で切る＝半透明の塗りに継ぎ目の濃い帯は出ない（線の丸い端だけ枠で重なる）。
  - 未対応（警告して描く）：fill-pattern・fill-translate・line-pattern・line-gradient・line-blur・line-gap-width・line-translate。fill-outline-color は明示された時だけ 1px の縁。
  - 基図の source の層はタイルを基図の配管と別に取る（HTTP キャッシュ頼み・押し出しとも別）。低ズームのタイルは線の細分をタイルの幅の 1/64 までに抑える（基図は 700m 固定）。
  - feature-state（#109）は paint だけが読む（filter・layout・sort-key は読まない＝MapLibre と同じ）。状態が変わると、その地物を含むタイルを組み直して user の枠を結合し直す＝MapLibre のように即座ではない（実測：OpenFreeMap の渋谷 z16・4 枚で状態→描く側 中央 40〜55ms・最悪 76ms・?hud=1 の vector layers の行）。タイルは source ごとに全部の描く層を一度に組む＝読まない層も一緒に組み直す。
  - 問い合わせは基図と同じ当て方（面の中・線幅/2＋許し・円の半径＋縁・sourceLayer・id（promoteId）・source）・地物に state（無ければ {}・基図の地物も）。
- geojson の押し出し（段 5b）：
  - ["zoom"] の式は止まった所で評価し直す（MapLibre はズーム中も連続）＝止まった絵は同じ。止まりの外（一番外の interpolate/step の範囲の外）では評価し直さない。
  - 問い合わせの結果の中で押し出し（geojson と vector）は一塊（上の段の順の中の「押し出し」の位置）で、その中が近い順。MapLibre は 3D の地物を 2D の層の間へ層の順で差し込む（押し出しの層の上にある 2D の層の地物が先）＝ここは描画の段の順（§4 の上の項）。
  - 壁は元の頂点どうしを結ぶ四角で当てる（描画は長い辺を刻む＝地形に沿わせる広い面の壁の上端は起伏の分だけずれ得る）。屋根は光線を屋根の高さで受ける＝平らな屋根は厳密。
  - 地面：床の平面（統計の既定）は持ち上げない・drape はどこでも地表・接地（建物らしい面）は renderer の接地リフトの規則の写し（DTM の申告域 ∩ R01 の窓）。標高は届くまで 0m（projectLL と同じ）。

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
| R22 | geojson の押し出しが止まるたびに全体を上げ直す（伸び上がりの式が一つでもあると、範囲の外でも 0.25 刻みごと） | 押し出しの鍵は曲線を見る（`src/extrude-ml.js` の curveZoomKey）：一番外の interpolate（-hcl/-lab も）/step の入力が ["zoom"] 由来なら止まりの外は "lo"/"hi"・中は 0.25 刻み／段の番号・それ以外の所の ["zoom"] は 0.25 刻みのまま。模様（canvas2D）の鍵は従来どおり | 爪車 node（extrude-zkey-* 7 場面）＋ t-mlcompat?g=extrude（押し出しの呼び出しを数える：範囲の外 4 回止めて 0 回・中 2 回・段） | **済**（段 5b） |
| R23 | geojson の押し出しの問い合わせが足跡だけ（傾けると屋根・壁が当たらず、足元の地面が当たる・浮いた箱の下が当たる） | 立体（`src/extrude-ml.js` の hitExtrusion＝MapLibre の queryIntersectsFeature と同じく屋根と壁）・地物ごとの外接球で下ごしらえ・当たった所の奥行きで近い順・描いた地面と同じ所（model.js の mode） | 爪車 node（extrude-hit-* 5 場面）＋ t-mlcompat?g=extrude（屋根・壁・近い順・浮き・箱・見えている色＝先頭・中庭・目の後ろへ回る広い面）両土台 | **済**（段 5b） |

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
| V8 | 重さ（1 フレーム 1 件の転送・頂点 28B・GL の呼び出し数・WebGPU の 512） | 予算を見た選び・枚数上限・1 タイル 1 層 1 メッシュ・幾何キャッシュ・**専用の meshPort で背圧**（render worker の受け取りの印＝送り中 2 件まで・isSourceLoaded は描画側に載るまで） | 実機の数（§7）・爪車（外した層の取り残しが出ない） | **済**（2026-09-27・?hud=1 の実測は次） |
| V9〜V10 | 伏せ枠の取り合い・フライト中の詰まり | 伏せ枠は使わない・フライト中は取得と組み立てを止める（出し入れは毎回） | — | **済** |
| V11 | 当たり（立体）・id・promoteId | worker の地物＋屋根と壁（段 5b から geojson の押し出しと同じ hitExtrusion・近い順は一つの列） | 爪車（屋根・浮き・継ぎ目・中庭） | **済** |
| V12 | 地形の外で埋まる | drape（どこでも地表へ）・当たりの地面は負の標高を 0 に | 実機（マンハッタン） | **済** |
| V13〜V18 | 既定の挙動の変化・旗の目盛り・両土台・地域の語・transformRequest/独自スキーム/PMTiles・影 | SDK 注記・drawLayerOf・同じメッシュ経路・語なし・requester・§4 | 爪車（GL2/WebGPU・addProtocol・PMTiles）・regionless | **済**（影は文書） |

段 8⑤（vector の描く層）で前もって把握した食い違い：

| # | 食い違い | 手当て | 門 | 状態 |
|---|---|---|---|---|
| W1 | 基図との順番（beforeId が基図の層を指しても基図の上） | #123＝描く時のアンカー表（globe の styleOrder→renderer の userAnchor・GL2 classic／multi_draw・WebGPU・地面アトラス） | 爪車 `?g=before`（両土台・md／nomd）・vector-beforeid-base-layer | **済** |
| W2 | 3D の塗りはアトラス＝基図の線の下（2D は上） | 基図と同じ規則・§4 | 実機（ツェルマットの森を 65° で） | 文書 |
| W3 | 利用者の層どうしの順番 | li＝層の順の鍵（小数＝間に差し込んでも他の source は組み直さない・外した鍵は使い回さず常に隠す） | 爪車 vector-layer-order（別の source どうし・moveLayer）・vtdraw.mjs（li の順） | **済** |
| W4 | paint のズームが連続でない | 曲線の鍵（layout も）・0.25 刻みの z で組む | vtdraw.mjs（置き換え・線幅）・爪車 | **済**（文書） |
| W5 | filter のズーム | filterZoom（段 8①と同じ） | — | **済** |
| W6 | circle（画面に向く・遠近の縮みなし・中空の縁） | 長さ 0 の線＝カプセル・中空は輪 | vtdraw.mjs（丸点・輪）・爪車 vector-circle-draws | **済**（文書） |
| W7 | symbol は点と面だけ | 基図と同じ buildLabels・面は極・記号は段 3・線に沿う注記は段 4 から（同じ注記層） | vtdraw.mjs（極・タイルの中）・爪車 vector-symbol-label・symbol-icon-*（段 3）・symbol-line-*（段 4） | **済** |
| W8 | タイルの縁の二重（半透明） | 枠で切る（面は Sutherland–Hodgman・線は Liang–Barsky・円と注記は中の点だけ） | vtdraw.mjs（面積の和）・実機（本初子午線の縁で色が一様） | **済** |
| W9 | 基図の source を二度取る | HTTP キャッシュ・§4 | — | 文書 |
| W10 | 重さ（CPU 結合で user の scene を上げ直す） | 間引き 120ms（状態の変化を待つ間は 32ms・#109）・結合 1 本ずつ・予算 128MB（LOW_MEM 48MB）・枚数上限・フライト中は取得と組み立てを止める・低ズームの細分を抑える | 実機（demotiles z2 10 枚＝7.5MB・細分を抑える前は 32MB／渋谷 OpenFreeMap 3 層 2 枚＝1.1MB）・?hud=1 の vector layers（組み立て・解読・結合・状態の反映） | **済** |
| W11 | 注記の二重（MVT のバッファ） | 点がタイルの中の物だけ | vtdraw.mjs | **済** |
| W12 | li が基図の門（海・建物の塗り・図郭外の水域）に掛かる | 2^20 の帯 | vtdraw.mjs（帯） | **済** |
| W13 | 問い合わせ | core queryTiles（source・promoteId・circle の分岐を足した）・解読の組ごとのキャッシュ | 爪車 vector-query（fill／line／circle） | **済** |
| W14 | feature-state が絵に効かない | #109＝押し出しの作法（touchFS・ids・fsDirty・loaded）＋core の stateOf（A1） | 爪車 vector-{fill,line,circle,symbol}-feature-state・vector-feature-state-query（両土台）・vtdraw.mjs（ids・色・main の配管）・core featurestate.mjs | **済** |
| W15 | 利用者の注記が山で浮く・沈む | render worker の vtLabels が標高を付ける（基図の applyLabels と同じ） | 目視 | **済** |
| W16〜W18 | 両土台・地域の語・読まない paint | 同じ scene の枠（GL2/WebGPU）・語なし・警告 1 回 | 爪車を両土台で・regionless | **済** |

## 6. 門（互換の爪車ほか）

- **互換の爪車**：`tests/mlcompat.mjs`（node の場面）＋ `tests/t-mlcompat.html?g=layers|style|vector|extrude|mlt`（描いて確かめる場面・globe verify:ui は 5 群すべて／verify:webgpu は style 以外）。既知の失敗＝`tests/mlcompat-known.json`（値＝直す段と理由）。
  - 一覧に無い失敗＝落ちる（退行）／一覧にあるのに通った＝落ちる（直ったので外す）。**場面を足すのは MapLibre と違うと分かった時**（先に場面を書いて赤を確かめる）。
- `tests/zoomscale.mjs`（分類漏れ）・`tests/internal-callers.mjs`（内製の呼び手）・`tests/expr-golden.mjs`（評価器の黄金の写し）・`tests/vtextrude.mjs`／`tests/vtdraw.mjs`（vector source の押し出しと描く層の純関数）＝globe の `npm test`（ルートの `npm test` に連結）。
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
- [x] **段 8①b**（2026-09-27・本人「1→2」の 2・branch claude/maplibre-extrusion-feature-state）：vector の押し出しの feature-state＝setFeatureState/removeFeatureState/getFeatureState（MapLibre 同名・vector は sourceLayer 必須・置き場は globe＝層より先でも残る）・build の結果に地物の id＝状態が変わった地物を含むタイルだけ印（組み立て中なら着いた後にもう一度）・問い合わせの地物に state。
  - 轍：**描画側の反映の遅れ**＝render worker はメッシュを 1 フレーム 1 件しか載せない（SwiftShader では 1 件 1 秒超）のに main は毎フレーム送っていた＝列が溜まり、外した層の解放も後ろで待たされて「取り残し」に見えた（漏れではない）。PLATEAU と同じ専用の meshPort に替え、受け取りの印で送る量を絞る（背圧）＋isSourceLoaded は描画側に載るまで false。render worker は無改修（既存の meshPort の口）。
  - 門：爪車 feature-state-color（両土台・既知から外した）＝色・他の棟・getFeatureState・問い合わせの state・外すと戻る・sourceLayer 無しは投げる。実機：渋谷の OpenFreeMap で 1 棟の状態を変えて 0.16 秒。
- [x] **段 8⑤**（2026-09-27・本人「⑤ 2 本目以降のベクタ」＋裁定「別の流れ・基図の上」・branch claude/maplibre-vector-draw）：vector source の fill／line／circle／symbol＝新しいファイル（`gadgets/vtdraw.js`（選ぶ・取る・置き換え・結合の指図・注記・予算）・`vtdraw-worker.js`（役 "vtdraw"・解読・filter・枠で切る・core の buildTileDrawList／buildLabels）・`vtops.js`（純関数））。結合は core の scene worker をもう 1 本（md:false＝CPU 結合）・main はポートの端を持って render worker の `set("scene", …, "user")`（既存の口）へ中継するだけ。
  - core は足し算だけ：renderer の "user" の枠（GL2・WebGPU＝空なら slots に入らない＝既存の絵もアトラスの鍵も今と同じ・基図の濃さとラスタ基図の hideFills に従わない）・exports `./build` `./tilelabels`・buildTileDrawList の `subLenM`（既定 700＝基図は今のまま）・queryTiles の `source`／`promoteId`／circle。render worker は `vtLabels` の命令を 1 つ（標高を付けて setUserLabels・gintLabels は触らない）。
  - 入口：kindOf（vector × fill/line/circle/symbol）・基図の source 名への差し込みも同じ口・style.json の 2 本目以降の vector source の層と基図の source の circle を利用者の層の口へ（console の「描かない層」からも外す）・visibility は結合で隠すだけ・setPaintProperty/setFilter/出しズームはその source を組み直す・moveLayer は動いた層の鍵だけ振り直す・setStyle で付け替え・isSourceLoaded は結合が載るまで false。
  - 門：`tests/vtdraw.mjs`（node 36 項目＝置き換え・枠で切る（面積の和）・円＝長さ 0 の線・極・li の帯・worker の組み立て）＋爪車 `?g=vector` に 13 場面（計 29・両土台・既知 1＝⑤b の feature-state）。試料に landuse／road／poi を足した（建物の層のバイトは不変）。
  - 実機：MapLibre の demotiles（国の面・境界・国名）を全球ビューで・本初子午線のタイルの縁で半透明の塗りが一様・OpenFreeMap liberty の基図の source に道路の強調・POI の円・建物の半透明の塗り（渋谷）・ツェルマットを 65° で森の塗りが地形に沿う。
  - 轍：①問い合わせのキャッシュは「解読した source-layer の組」ごと（queryTiles は要る層だけ解く＝層を絞った最初の問い合わせのタイルを別の層が読むと空）②core の線の細分（700m・1 本 24 分割まで）は z2 のタイルで 4 倍に膨れた（demotiles 32MB→7.5MB）③プレビューの枠が隠れていると rAF が止まる（選びは rAF）。
- [x] **段 5b**（2026-09-27）：geojson の押し出し（model.js の経路）の 2 件＝①描き直しの鍵を曲線で（R22）②問い合わせを立体で（R23）。純関数は `src/extrude-ml.js`（node で確かめる）・globe.js は視点の口（地面・投影・外接球の下ごしらえ）だけ。model.js は立てた地物に base とスロットの地面（mode・床の高さ）を持たせた（extrudeSets）。門＝爪車 node 12 場面・t-mlcompat?g=extrude 11 場面（GL2・WebGPU。旧コードで 7 場面が赤＝足跡の当て方・0.25 刻みの鍵、見張り 4 場面は両方で緑を確かめた）。
  - **段 8①（vector の押し出し）と一本に**（main へ入った後に揃えた）：鍵＝vtmesh.paintZoomKey は extrude-ml.js の exprZoomKey を使う（書式は同じ "名前:lo|hi|s<段>|<z>"・interpolate-hcl/-lab も曲線に）。当たり＝vtextrude の query も hitExtrusion（旧＝屋根の頂点の投影＋重心の中ほどまでの距離）・口は globe.js の extView（hitEnv＝vtxGround の地面）・query は [{ d, f }] を返し、問い合わせが geojson の押し出しと一つの列にして近い順（MapLibre と同じく 3D の地物は奥行きで並ぶ）。vtxGround は ?noterr=1 で持ち上げない（描く側と同じ）。projectorH・distanceOf の口は要らなくなったので外した。
- [x] **段 8②＝文字を測るの段 3**（2026-09-28・claude/text-stage-3）：基図と vector source の symbol 層の記号（icon-image）＝§8 の段 3 に記録。
- [x] **段 8③＝文字を測るの段 4**（2026-09-28・claude/text-stage-4）：線に沿う注記＝§8 の段 4 に記録。
- [x] **段 8⑤b＝#109**（2026-09-29・裁定＝タイルの組み直し・A1・beforeId は #123 へ）：vector の描く層（fill／line／circle／symbol）の feature-state。
  - 段 0＝場面（爪車 5 場面を既知で先に・両土台で赤）・段 1＝配管（押し出しの部品を写す：createVTDraw に置き場・set/removeFeatureState が vtdraw にも印・worker が読む層の地物の id を source-layer ごとに返す・添える状態はそのタイルが含む地物の分だけ・isSourceLoaded は組み直しが済むまで false）・段 2＝core の `buildTileDrawList`・`buildLabels` に省略できる `stateOf(f)`（filter の後に ctx.state＝paint だけが読む・基図は渡さない＝黄金の写しは不変・sort-key の順も崩れない）・段 3＝問い合わせの地物に state・段 4＝?hud=1 の計器と間引き・段 5＝台帳と d.ts。
  - 実測（段 4・WebGPU の実機・OpenFreeMap liberty の渋谷 z16・4 枚 3.5MB）：worker の往復 26ms（解読 6〜10ms・組み立て 13ms）・結合 1.6ms。外れ値 150〜190ms＝前と次の地物が別のタイルで 2 枚目の結合が間引き 120ms を待っていた→状態を待つ間は 32ms（最悪 76ms・中央 40〜55ms・20 回の連打の後 50ms）。解読は主因でない＝「解読を覚える」手当ては入れない。
  - 門：爪車（両土台・既知は空）・`tests/vtdraw.mjs` 50・core `tests/featurestate.mjs`。
  - 轍：①OpenMapTiles の building は 1 つの地物が多数の棟の MultiPolygon のことがある（渋谷で 28〜219 片）＝1 つの id に置くと街区ごと色が変わる（MapLibre も同じ）②真上から見ると style の 3D の建物（fill-extrusion）が平らな塗りを覆う（検分の画素は 3D を伏せて取る）。
- [x] **#123 基図の層の間への差し込み**（2026-09-29・裁定＝持つ・任意の層の間・vector の描く層だけ）：
  - 段 0＝爪車 `?g=before`（7 場面を既知で先に）・段 1＝globe の styleOrder（getStyle と共有・beforeId の鎖を辿る＝getStyle の鎖の順も直した）と sendUserAnchors（vtdraw の層ごとに「直後の基図の層」の li を renderer.set("userAnchor")・vtdraw の層の足し引き／順／基図の再ビルド（setPipelineStyle を包む）／style の層の振り分けの後に配る・起動の途中は何もしない）・段 2＝描画器（GL2 は枠の描き方を drawSlot(slot, lo, hi, pick) に・classic の線の項にも li・WebGPU は drawOne）＝最後に描く基図の枠を境で分けて間に利用者の群・段 3＝地面アトラス（GL2 drawFillsInto に範囲・WebGPU は焼く順を範囲つきの列に・鍵に userAnchor.rev）・段 4＝台帳・d.ts。
  - 表が空（beforeId が基図を指さない）なら描く順は今と同じ。基図の sea／bldFill と同じ「li の表」の作法＝タイルも結合もやり直さない。
  - 門：爪車 `?g=before`（GL2 md／nomd・WebGPU・既知は空）・全頁（globe の verify:ui／verify:webgpu）＋japan の基図とアトラスの頁。
  - 轍：①style 由来の層は addLayer の時点ではまだ style 由来と分からない（extExtras.layers は足した後に積む）＝振り分けの後にも配る ②面の輪を線で描く基図の層は、タイルのバッファの縁（継ぎ目の ±33m）にも線を引く＝検定の画素は継ぎ目から離す ③WebGPU のフェード中は新しいシーンのパスにだけ差し込む（旧シーンは全部を先に敷く）。
- [ ] 段 8④：hillshade（着手前に別計画）。

## 8. 公式例の門（2026-09-27 起票）

- **なぜ**：§6 の爪車は**自分で書いた場面**を**自分で決めた期待色**と比べる＝分母を自分で選んでいる。外から来た分母＝MapLibre 公式の例で「同じコードで同じ絵」を数える。
- **形**：MapLibre GL JS の公式例（`test/examples/*.html`・BSD-3-Clause）は全部 `import * as maplibregl from '../../dist/maplibre-gl-dev.mjs'`＝**その道に本物か通訳を置くだけ**で差し替える（例の本文は一文字も変えない）。本物とこちらを同じ録りの網で走らせ、比べる。
- **段**（こちらの段は本物の段を超えない・本物が落ちる例は分母の外）：
  - 0 動かない（load に届かない・起動で例外・既定の基図に落ちた・何も描かない）
  - 1 動く（load に届き、捕まらない例外が無い）
  - 2 同じ答え（意味の unsupported 0・層の id と順・標本点の問い合わせの集合・見えている範囲・Marker/Popup の位置）
  - 3 同じ絵（地理で合わせた色の標本＝本物の `unproject`→こちらの `projectLL`・「例が足した層に当たる点」と「基図の点」を別々に）
- **出る物**：段ごとの本数（全体と「鍵も外部ライブラリも custom も無い」例の 2 本立て）・**足りない口の順位表**（口 → 落としている例の数）・見比べ帳（手元だけ）。
- **本人の裁定（2026-09-27）**：
  1. 通訳（`maplibregl` の名前空間）は**製品の口**として `src/maplibre/` に置く（npm 公開と d.ts は点数を見てから）。
  2. 網は**録り置きして再生**（`<repo>/.cache/mlexamples/net/`・`--record` で録り直し）。
  3. `verify:examples` は**手で／節目に**回す（常設の `verify` の外＝`verify:net` と同じ扱い）。
  4. MapLibre の口から起こした地図は**夜面・星空・自前の地形を出さない**（地形は setTerrain／style の terrain の時だけ）。旗で on にできる。内製アプリの既定は今のまま。
     - **表示の形は球**（2026-09-28 本人裁定・#43）：楕円体は通常・HI のデスクトップの既定になったが、MapLibre の地球儀は球＝「同じ絵」が物差しの口は `ellipsoid: false` で起こす。`options.ortho.ellipsoid` で変えられる・URL の `?ell=1` が勝つ。
- **約束（通訳だけ）**：通訳はエンジンに機能を足さない。同じ働きがあれば言い換え、無ければ投げずに `[mlshim] unsupported: <口>` を記録して何もしない（見た目／意味に分ける）。通訳で辻褄を合わせない＝点数を正直に保つ。エンジンの足し算は `idle` 事象と起動オプション `night`／`sky`／`terrain:false`（既定は不変）だけ。
- **目録**（`tests/mlexamples/corpus.mjs`・`corpus.json`）：MapLibre GL JS **6.11.2**（`acb7b722`）・例 139・素材 30・本物の dist 14（`npm pack`＝lock を触らない）。取り置き＝`<repo>/.cache/mlexamples/6.11.2/`（sha256 で照合・壊れていれば取り直す）。
  - 見立て（正規表現・走らせる前の予想）：鍵も外部ライブラリも custom も無い 111／外部ライブラリ 23／custom 9／API キー 3／import map 6／globe 10／terrain 11／入力待ち 43／動き 12／乱数・日付 6／位置情報 1／地図 2 枚以上 1。
- **走らせ方**（`npm run verify:examples`＝`scripts/verify-examples.mjs`）：
  - 器＝`tests/mlexamples/vite.config.mjs`（root は globe のまま）。`/{ref,ortho}/test/examples/*.html` は取り置きの**バイトをそのまま**（vite の HTML 変換を通さない＝import map の例も壊れない）。`/ref/dist/_real/**`＝本物の dist を静的に・`/ref/dist/maplibre-gl-dev.mjs`＝Map を継ぐ包み・`/ref/**` は COOP/COEP を外す。`/ortho/dist/maplibre-gl-dev.mjs`＝`tests/mlexamples/ortho-entry.js`（通訳を再公開し Map を継ぐ・時計を止める・pinRes）。
  - 例ごとに Chrome（`scripts/lib/cdp.mjs`＝runRealtime から切り出した部品）・800×600・dpr 1・実 GPU・UA は普通の Chrome・Math.random に種・位置情報は固定。
  - **描き終わり**＝load（事象／`map.loaded()`／style.load から 15 秒）→その側の `idle`（来なければ load から 10 秒）→取得が 1 秒止まる→canvas だけの写しが 500ms 空けて 2 回同じ。動き続ける例は `moving`（取得が止まっても写しが 4 秒違う）・`animated`（見立て＝load から 6 秒）。上限 45 秒。
  - **網**（`tests/mlexamples/netstore.mjs`）：頁の session の `Fetch.enable`（`https://*`）で 頁・専用 worker・入れ子の worker・module worker・blob worker・preflight まで全部捕まる（2026-09-27 の試し・worker の session には Fetch が無い）。録るのは Chrome 自身（continueRequest(interceptResponse)→getResponseBody）＝Node の fetch は ows.terrestris.de に繋がらなかった。鍵＝method＋URL（走るたびに変わる印＝`_t=`・`nocache=`・値が 10〜13 桁の時刻の項を除く＝エンジンの `v=<時刻>` も）＋Range・再生の Range は 206。**録る応答は 2xx/3xx/401/403/404 だけ**（429 を録ると再生でも「多すぎる」が返り、MapLibre の load が来ない＝踏んだ）。録る走りは `--jobs 1`（相手の鯖に優しく）。
  - **標本**：本物の 16×10 の格子（縁 48px を除く）→`unproject`（|lat|≤85.051・project で戻る点）→こちらの `projectLL`（front>0・画面の内側・unproject で標本の間隔の 1/4 以内に戻る点）。⚠ `projectLL` の front は「高さ／半径」の量＝高ズームでは見えている点でも 1e-4 程度（閾値 0.05 を置いて高ズームの例の標本を全部落とした＝最初の走り o1 の轍）。問い合わせは点ごと（こちらは非同期）。例が `addLayer` した層は両側の包みが記録（`added`）。
  - 揺れ（本物どうし・同じ録りの再生 2 回）：139 本中 125 本は答えも色も同じ（r3/r4）。残りは動く例と、録りの初回だけ時間切れの地形の例。
- **エンジンの足し算**（段 2・既定は不変）：`map.on("idle")`（動いていない・飛んでいない・描き直し待ち無し・基図が覆って載った・標高と建物と利用者の source の読み込み無し、が 100ms 続いたら 1 回・起動直後も来る）／`night:false`／`sky:false`（星空劇場と太陽系圏）／`coastline:false`（世界の海岸線＝NE admin0 の gint 層・z<9・どの基図の上にも重なっていた＝最初の走りで見つけた・裁定 4 と同じ種類＝MapLibre の口の既定に足した）／`terrain:false`（setTerrain まで平ら＝render worker は DEM が来た時に地形を作る・その後の setTerrain(null) は DEM を外すだけ＝既定の標高に戻る）。門＝`t-mlboot?v=default|ml`（両土台）。
  - `idle`／`isSourceLoaded` は **画像タイル層（raster／raster-dem→hillshade／image／video）の未着も見る**（2026-09-28・core 1.6.1／globe 1.5.1）＝raster.js が「開く途中＋見えている選抜の queued/loading の枚数」を `rasterPending` として main へ申告（変わった時だけ）。それまでは hillshade/raster の例で画像が降っている途中に idle が来て、門は 10 秒の timeout で撮っていた（速さの外れ値の正体）。
- **通訳**（段 3・`src/maplibre/`）：`Map`（同期のコンストラクタ→裏で createGlobe・準備までの呼び出しは列・事象の言い換え＝move→zoom/rotate/pitch と start/end・settle→moveend・素の DOM の事象は容れ物から・層の事象はエンジンの口）・`Marker`/`Popup`・`LngLat`/`LngLatBounds`/`MercatorCoordinate`（MapLibre の実装どおり＝西＞東の contains も同じ答え）・操作部品（MapLibre の CSS の class 名）。無い口は `[mlshim] unsupported: <口> (semantic|cosmetic)` を 1 回。`queryRenderedFeatures` は同期で返せない＝空で返して記録（隠さない）。2 枚目の Map は何もしない実体。検定＝`tests/mlshim.mjs`（import は ../globe.js と同じ家だけ・RAW 無し）。
- **採点**（段 4・`tests/mlexamples/compare.mjs` の `grade`）：本物が落ちる例＝分母の外。こちらの段は本物を超えない（止まって撮れた例は 3 まで・動く例は 2 まで）。段 2＝意味の unsupported 0・層の id と順・問い合わせの集合（symbol を除く）≥0.9・Marker/Popup の数・カメラ（緯度の差 |log2 cos φ|＋0.1 は許す）。段 3＝色の一致（RGB 距離 ≤40）が足した層の点 ≥0.85・基図の点 ≥0.8（比べられる点が 30% 未満なら段 2 止まり）。閾値は段 5 で本人が見比べ帳（`<repo>/.cache/mlexamples/report/<label>/index.html`）を見て決める。
- **進み**：
  - [x] 段 0（2026-09-27）：この節・目録。エンジン無改修。
  - [x] 段 1（2026-09-27）：走らせ台と本物（網の試し→録り置き・描き終わりの判定・本物どうしの揺れ 125/139 が同じ）
  - [x] 段 2（2026-09-27）：エンジンの足し算（`idle`・`night`／`sky`／`terrain:false`・`t-mlboot`）
  - [x] 段 3（2026-09-27）：通訳（`src/maplibre/`）
  - [x] 段 4（2026-09-27）：採点・見比べ帳・順位表（`--grade`）
  - [ ] 段 5 目合わせ（閾値は本人の目で）と爪車（`tests/mlexamples/known.json`）
- **最初の点数**（2026-09-27・本物 r6 × こちら o2・初期の閾値・WebGPU 実 GPU）：分母 137（本物も落ちる 2＝地図 3 枚の例・deck.gl の鍵）
  - 0 動かない 4／1 動く 132／2 同じ答え 1／3 同じ絵 0。**絵だけ見れば同じ（段 2 に依らない）62/120**（両側とも止まって撮れた例）
  - 足りない口の順位表（上位）：getStyle が symbol の層を落とす 110／問い合わせが線に余計に当たる 83（エンジンの既定の許し 3px・MapLibre は線幅ちょうど）／getStyle が raster の層を落とす 23／面を取りこぼす 20／カメラ 18／面に余計に当たる 14／getStyle が hillshade の層を落とす 9／通訳の穴（GeoJSONSource.updateData・ImageSource.updateImage・touchZoomRotate.disableRotation）各 1
  - 読み：**動くことはほぼ並んだ（132/137）。答えは getStyle の一覧と問い合わせの許しの 2 点で塞がれ、絵は半分が同じ**。直す順は順位表の上から（別計画）。
  - 問い合わせの鍵から id を外した：OpenMapTiles の地物の id はタイルのズームごとに違う＝タイルの詳しさの選び方で変わる（答えの差ではない）。id の無い GeoJSON にこちらが並び順の id を返す差は残る（MapLibre は undefined）
- **順位表の 1・2 位の直し（2026-09-27 本人「1・2位の直しを計画して進めて」）**：
  - **A. getStyle は描かない層も返す**（外来 style の地図だけ・地域の基図は今のまま）：
    - A1 `getStyle().layers`＝元の style の順（描く基図の層・画像として載せた raster・style の vector/geojson の層・**描かない層**＝線に沿う注記・アイコン・hillshade・塗りより下の raster・知らない型）。描かない層は `metadata["ortho:drawn"]:false` を付ける。利用者の層は beforeId の層の前・無ければ末尾。
    - A2 `getLayer`・`get*Property`・`getFilter` が描かない層も返す。A3 `set*Property`・`setFilter`・`setLayerZoomRange`・`removeLayer` は描かない層でも投げない（記録だけ＝getStyle に出る・絵は変わらない）。画像の raster の visibility は画像層の出し入れへ。
    - A4 `addLayer`／`moveLayer` の beforeId が style の層を指す時は `before` を記録＝getStyle の順が MapLibre と同じ（描く順も #123 から同じ・vector の描く層）。鎖（c0→c1→基図の層）も辿る（#123）。
  - **B. 問い合わせの許しは既定 0**（MapLibre と同じ＝線は線幅の半分・円は半径＋縁・面は内側）：`tolerance` は拡張として残す。GeoJSON（gint）の線と点は線幅の半分・円の半径＋縁を足して当てる（旧＝許し 3px と点の +6px だけ）。単一スロットの user 層（内製）は従来の 3px。内製アプリは問い合わせも層の事象も使っていない（grep で確かめた）。
  - **C. 採点**：通訳が捕まえたエンジンのエラー（`[mlshim] <口>:`＝MapLibre なら投げない所でエンジンが投げた）を段 2 の塞ぎに数える（o2 で 20 本＝custom 層の addLayer 12・知らない演算子 3 など・これまで数えていなかった）。
  - **D. 門を回し直して点数を比べる**（本物 r6 × こちら o3）。門＝t-mlcompat（style 群に A の場面・layers 群に B の場面）・t-mllayers・t-mlstyle・globe verify。
  - **結果（2026-09-27・同じ物差し＝C を入れた採点で o2 を付け直して比べた）**：分母 137・下がった例なし
    | 段 | 直す前（o2） | 直した後（o3） |
    |---|---|---|
    | 0 動かない | 4 | 4 |
    | 1 動く | 132 | 55 |
    | 2 同じ答え | 1 | 33 |
    | 3 同じ絵 | 0 | **45** |
    | 鍵・外部ライブラリ・custom 無しの例で同じ絵 | 0/111 | **43/111** |
  - 次の順位表（上位）：カメラ 18／線に余計に当たる 18／足した層の色 15／基図の色 14／面を取りこぼす 14／線を取りこぼす 14／custom 層の addLayer（source 無し）11／面に余計に当たる 10。getStyle の残り＝style 無しで作って setStyle する 2 例（エンジンは起動時の style が要る＝通訳は空の style で起こせば済む）・知らない演算子で足せなかった層・custom 層。
  - 轍：identifyAt は許しの半径を度の空間の円で探す＝この地図（同じ z＝同じ倍率）では東西が cos(緯度) で縮む（旧来の +6px と許し 3px で隠れていた）。
- **2 巡目（2026-09-27 本人「もう一回、改良しながら回して」）**：
  - エンジン（MapLibre 同名の口を足す・既定の挙動は不変）：GeoJSONSource.updateData・ImageSource.updateImage／setCoordinates・getStyle の根の視点・setStyle の transformStyle・addLayer の source に object＝層の id で source を足す・独自の protocol へ頼む型を資源で選ぶ（JSON＝"json"・画像タイル＝"image"）・足している途中の画像を待ってから層を載せる（MapLibre の addImage は同期）。core：text-variable-anchor-offset のリテラルを式と読まない。
  - 通訳：style 無しの Map は空の style で起こす・style の根の視点は「コンストラクタで視点を変えていない時だけ」（MapLibre の transform.unmodified）・custom 層は unsupported として記録・操作ハンドラはどの口も受ける。
  - 採点：MapLibre のメルカトルのズームの下限（世界の高さ＝600px で z0.2288）に本物が居る時はカメラを比べない。
  - 走らせ台の不具合：こちらの写しで重ね描きの canvas（.overlay-gl＝記号・ヒートマップ・集約）まで隠していた＝絵の一致が低く出ていた。canvas は全部残す形へ。
  - **残る差の正体**：問い合わせと色だけで止まる例（o3 で 39 本）の 36 本が |緯度|≥35°＝**同じズームの数でも縮尺が緯度で違う**（§4 の緯度の差・ワシントン 38.9° でこちらが 1.29 倍広い＝同じ px の道路が地面では太い・タイルの詳しさも粗い）。実験の旗 `--mllat`（検定の包みだけ・起動の視点に log2(sec φ)）で「合わせたら何本上がるか」を数える。
  - **2 巡目の結果（o5・下がった例なし）**：0 動かない 1／1 動く 47／2 同じ答え 41／3 同じ絵 48（素の例 46/111）・絵だけ見れば同じ 65/121。3 巡の推移：同じ絵 0→45→48・同じ答え 1→33→41・動かない 4→4→1。
  - **緯度の縮尺の実験（o5lat）は悪くなった**（同じ絵 48→30）：カメラのズームを log2(sec φ) 上げると、こちらでは style の式（線幅・出しズーム・filter の zoom）も上げたズームの数で評価される（ワシントン 38.9° で 11.15 のはずが 11.51）。MapLibre は**ズームの数（style の評価）はそのまま・縮尺だけが緯度で変わる**。こちらは「同じ z＝同じ倍率＝同じ style」＝縮尺だけ合わせることはできない。揃えるなら「style を評価するズーム」と「カメラの縮尺」を切り離す（中心緯度で style の z を log2(sec φ) 下げる等）＝z の定義に踏み込む＝本人裁定の領分。
  - 次の順位表（o5）：基図の色 23／足した層の色 15／線に余計 13／面・線の取りこぼし 12・12／面に余計 11／custom 層 10／カメラ 7。
- **3 巡目（2026-09-27 本人「いいですね、もう一度」）**：
  - **hillshade の層**（`src/hillshade.js`）：この地図の陰影は傾けた時の地形面だけ（真俯瞰は平面）＝MapLibre の hillshade（真俯瞰でも陰影の画像）が無く、北緯 47° の地形の例（10 本）の基図が白かった。MapLibre の式（hillshade_prepare＋fragment・standard）を画素で写し、raster-dem のタイルから陰影の画像タイルを作る **port プロバイダ**（画像タイル層の契約）として載せる＝エンジンの描く経路は無改修。端の勾配は隣のタイル・緯度の縮み・色 3 種・exaggeration。addLayer と外来 style の両方（getStyle では描く層）。他の method（basic/combined/igor/multidirectional）は standard で描く（警告）。
  - **querySourceFeatures**（同期・MapLibre 同名）：集約の source＝今の段の丸と単点（画面の内側＋余白 1/4）・geojson＝全部（上位互換）・vector＝[]（未対応・警告）。HTML の集約の例（Marker を丸の位置に置く）が動く。
  - 直し：removeLayer した style 由来の層を getStyle の「その他の層」として復活させない／型紙の `%7B` を読む（`new URL().href` で括弧が化ける）。
  - 門：t-mlcompat の layers 群に hillshade-layer（北西の斜面が明るく南東が暗い・外すと戻る）と query-source-features。GL2・WebGPU 全緑。
  - **3 巡目の結果（o7・下がった例なし）**：0 動かない 1／1 動く 45／2 同じ答え 43／3 同じ絵 48・絵だけ見れば同じ 65/121。4 巡の推移：同じ絵 0→45→48→48・同じ答え 1→33→41→43。hillshade の例は白から本物と同じ滑らかな陰影になったが、同じ z でこちらは緯度で粗いタイル（z9 対 z10）を使い exaggeration の式が変わる＝平均の明るさが 150 対 177＝「同じ絵」には届かない（z の定義の裁定待ちの側）。残る順位表は全部その緯度の差か、エンジンに無い機能（custom 層 10・動く画像 2・無い画像の後付け 2）。
- **z の定義と段 5 の閾値（2026-09-27 本人「z の定義と段 5 の閾値の目合わせを詰めて」）**：
  - **目盛り "mercator"**（`zoomScale:"mercator"`・MapLibre の口の既定）＝dz＝1＋log2(sec φ0)（φ0＝起動の視点の中心緯度・地図ごとに固定）。数の zoom は全部この dz で往復＝**style の式は MapLibre の z で評価され、カメラだけ緯度の分だけ寄る**。前回の実験（カメラだけ上げる）が悪化した正体＝style も一緒に上がっていた。
    - **タイルの z も MapLibre と同じに**（TILE_BIAS＝分割の閾を 2^(dz−1) 倍＝基図・vector source・画像タイル）。⚠これが無いと一段細かいタイルを選び、問い合わせの答え（地物の集合）が MapLibre と違う（o8 で同じ答え 43→30）。
    - 端＝φ0 で固定＝南北に離れるほど MapLibre との差が戻る（MapLibre は中心の移動に連れて縮尺が変わる・こちらは変えない）。"maplibre"（一律 +1）は残す（内製・URL・.scenes は "ortho" のまま無傷）。
    - 集約の段（clusterMaxZoom）は整数へ丸める（小数の dz で new Array が投げた）。
  - **問い合わせの幅**＝MapLibre の getLineWidth（隙間があれば 隙間＋2×幅・幅 0 の線は当たらない＝旧は 0 を 1px と見て余計に当たった）。残る食い違い＝線の縁の 0.5px 未満（画面→タイル単位の量子化）＝許し 0 が最善（0.25/0.5 は余計な当たりが増えて悪化・実測 3 例）。
  - **段 5 の閾値（決めた）**：色の許し 40（RGB 距離）／基図の点 ≥0.8／足した層の点 ≥0.85・ただし標本 ≤6 点は 1 点のはずれを許す（細い線の 5×5 中央値は 1 点外れ得る＝add-a-geojson-line 5/6 は目で見て同じ絵）／問い合わせ ≥0.85（上の量子化＝同じ式でも 0.89〜0.75）／比べられる点 <30%＝絵は比べない。世界全図の例（メルカトルが画面を埋め、球は小さく写る）は基図の一致が 0.6〜0.8 に留まる＝意図した差＝段 2 止まりでよい。
  - **結果（o10・"mercator"＋幅の直し＋段 5 の閾値）**：0 動かない 1／1 動く 47／2 同じ答え 34／3 同じ絵 **55**（素の例 51/111）・絵だけ見れば同じ **77/120**。5 巡の推移＝同じ絵 0→45→48→48→55・段 2 以上 1→78→89→91→89。上がった 9（fly-to・fit-a-map・時間スライダー・ベクタタイル・全画面…）・下がった 4（勾配の線 2・3D 建物 2＝密な線の所で問い合わせの一致が 0.79＝量子化の 0.5px に多くの点が掛かる＝旧の目盛りでは縮尺の差が偶然に隠していた）＝目盛りが変わった＝新しい基準として known.json を書き換えた。
- **custom 層（2026-09-28 本人「custom 層やってみますか？」）**＝`src/gadgets/customgl.js`：MapLibre の CustomLayerInterface（onAdd/render/onRemove・renderingMode）を **main の透明な WebGL2 canvas**（注記の下）で受け、`args.defaultProjectionData.mainMatrix`（メルカトル [0..1]・z はメルカトル単位 → クリップ・**Float64Array**）を毎フレーム渡す。行列＝この地図の mvp × [メルカトル → 東北上 [m] → 単位球]（起動の中心で局所線形化）。`getProjectionData({tileID})`（タイル 0..8192 → メルカトル）・`shaderData`（mercator の prelude＝projectTile）も。MapLibre の口は `setCustomLayerHost(this)` で onAdd/render の map を自分に・`getCanvas()` はこの canvas（three.js の `new WebGLRenderer({ canvas: map.getCanvas(), context: gl })` が同じ canvas と文脈を受ける）。getStyle は custom 層を書き出さない（MapLibre の serialize と同じ）。
  - **限界（文書）**：この地図の描画は worker（OffscreenCanvas）＝地図と同じ GL の文脈も深度も渡せない＝模型は建物・地形に隠れない（常に上）。行列は中心の局所線形化＝狭い範囲（模型・3D Tiles・z≥8）は画素の内で合い、大陸大の図形（z3 の三角形）は球との差の分だけ違う。globe の variant（球の prelude・`applyGlobeMatrix`）は無い＝mercator の variant として答える。
  - 結果（o11・下がった例なし）：0 動かない 1／1 動く 38／2 同じ答え 36／3 同じ絵 **62**（素の例 51/111）・絵だけ見れば同じ 77/121。custom 層の例 10 本＝同じ絵 7（three.js の模型 3・babylon・純 WebGL の三角形・globe の単純な層・360° 写真）・同じ答え 2（3D Tiles・タイルの層）・残り 1 は別の口（queryTerrainElevation の同期）。6 巡の推移＝同じ絵 0→45→48→48→55→62。
  - 見送り（記録）：styleimagemissing／setMissingStyleImageResolver（無い画像を後から足す）・動く画像（StyleImageInterface の render）・calculateCameraOptionsFromTo・custom 層（WebGL の文脈を渡さない）・color-relief 層・MapLibre のズームの下限より引く例（z −2）・世界全図の例＝メルカトルが画面を埋めるのに球は小さく写る（意図した差）。
- **文字を測る（2026-09-28 本人「テキストの表示の互換性を向上したい」→調査→計画→裁定「(b) で統一・0→5 の順」）**：門は文字を測っていなかった（問い合わせの集合から symbol を外し・5×5 の中央値は字画を拾わない＝順位表に text が 0 件なのはそのため）。計画＝段 0 測る→段 1 経路を 1 本に＋layout（anchor/offset/折り返し/justify/letter-spacing/transform/format の区間/opacity/halo-blur）＋衝突判定 1 つ→段 2 書体（**(b)＝Canvas2D＋CSS/システムフォントに `text-font` のフォントスタック名を family/weight/style で写す・glyph PBF は描かない＝CJK の質はこちらの強み**）→段 3 基図のアイコン（sprite・icon+text・icon-text-fit・9 分割）→段 4 線沿い（line/line-center・spacing・max-angle・keep-upright）→段 5 向き（rotation/pitch-alignment・text-rotate）。配置の規則は 1 本に統一（内製の基図も style で書く）。
  - **段 0（この日）＝文字の「同じ答え」と「そこに文字がある」**：本物＝symbol 層の `queryRenderedFeatures({layers})`（衝突で置けた記号だけ返る）→点の記号は錨の画面位置・線/面の記号は数えるだけ（`symbols`）。こちら＝`__placed()`（debugGlobals・labels2d の当選集合＋symbols overlay の直近フレーム＝層 id・中心・箱）と、本物の錨をこちらの画面へ写した `refSym`（projectLL・表なら ok）、注記と記号を隠した写し（`.notext.png`）との差分＝錨の周り ±24×±10px に閾 24 を超える画素が 4 以上＝**インク**（`ink`）。`textMatch`＝同じ層の記号/ラベルを許し（16px か 箱の w/2+h）の内に置いた数 **hit**／本物にもある層でこちらだけが置いた **extra**／**ink**／本物の線沿い **line**（段 4 の分母）。文字の中身は比べない（同じ地物＝同じ式＝expr-golden の領分）。
  - **閾値**：`textMin 0.6`（hit/n・5 個以上の例）＝**測るだけ（`textGate:false`）**＝段は動かさない。数字が落ち着いたら本人の目で決めて gate に。結果は `--grade` の「文字」の行・見比べ帳の各例・`grades.json` の `text`。本物の記録に `symbols` が要る＝r6 では取れない＝**本物を録り直す（r7）**。
  - **結果（o19・2026-09-28）**：0 動かない 1／1 動く 38／2 同じ答え 35／3 同じ絵 **63**（measure-distances 2→3・下がった例なし）。**文字＝点の記号 95 例・2418 個・hit 1476→1765（61→73%）・インク 1839/2175・こちらだけ 582・線沿い 714・0.6 未満 26→14 例**。最初の直し＝**基図の symbol 層が layer の minzoom/maxzoom を見ていなかった**（OpenFreeMap の label_state（minzoom 5）が z3 に 53 個出て city/country 名を押し出す）→ labels.js が minZ/maxZ（エンジン z）をラベルに焼き、labels2d の collide が地図 z で裁く（±1e-3＝整数の境の換算誤差）。⚠タイル z で裁くと粗いタイルで全滅（demotiles 46→0）。診断窓 `__placedDebug()`。cluster の件数の文字も申告（cluster-2d）。網の鍵＝小数 7 桁以上を 3 桁に丸める（WMS の bbox の末尾の揺れで 12 枚が外れ 3→2 になった）。
  - **残り（段 1 の入口）**：demotiles の countries-label 46/81（同じ層の記号が近くに無い＝衝突の勝ち負け・錨の位置）・icon+text 0.49／icon 0.41（基図のアイコン＝段 3）・線沿い 714（段 4）・`filter-layer-symbols-using-global-state` 0/5（global-state 演算子）・rich-text の format 区間。
  - **demotiles countries-label（46/81）の正体**：layout＝text-size 10（z2）・text-field {ABBREV}・max-width 10・allow-overlap 無し＝MapLibre は 87 個置くのにこちらは 48 個＝**こちらの衝突の箱が大きい**（pad 5 固定＝MapLibre の text-padding 既定 2・箱は measureText の幅×size）。段 1 の最初の直し＝text-padding を style から読み既定 2・箱を MapLibre の形（行の高さ・max-width の折り返し）に。
- **段 1（2026-09-28・claude/text-stage-1）＝基図/vector の注記経路に MapLibre の layout を通す**：labels.js が層の layout を評価してラベルに焼く（text-anchor／offset／radial-offset／variable-anchor・max-width（em・折り返し）・letter-spacing・line-height・justify・transform・padding・allow-overlap／ignore-placement・text-opacity／halo-blur）。labels2d の collide が箱を組む（`textLayout`＝"\n" と max-width で行に割る＝語で区切れる物は語ごと・CJK は字ごと／`anchorCands`＝anchor＋offset・variable-anchor は候補を順に／padding は判定だけ／allow-overlap は判定を飛ばす・ignore-placement は他を押しのけない）。優先順＝**MapLibre の層は後の層が先に置く（li 降順）→ 層の中は sort-key**。描く側は箱の左上を「ライブ投影の錨＋衝突判定時の相対位置」で置き、行ごとに justify で寄せる。
  - **既定は由来で分ける**（ネイティブの基図・gint の見た目を変えない）：MapLibre 由来＝padding 2・max-width 10・line-height 1.2／ネイティブ＝padding 5・折り返し無し・行高 1・優先順は sort だけ（従来）。
  - 結果（o20s・低い 28 例）：hit 771→**927**・rich-text 39→57・言語切替 37→49・cog 51→64・jump 20→31・fallback 31→45・locate 45→56。下がった段なし。
  - 近似（記録）：layout の式はタイルの z で評価（worker は地図の z を持たない）＝demotiles の text-transform stops [0 uppercase・2 none] が z2 の絵で uppercase になる（タイルが z1 の時）。`format` は文字を連結するだけ（区間ごとの font-scale／色は段 2 の書体と一緒に）。geojson の symbol（symbols-2d）は別経路のまま（同じ意味論・統合は残件）。
  - **結果（o21・全 139）**：hit **1765→2045／2418（73→85%）**・インク 1996/2175・0.6 未満 **14→10**・同じ絵 63（下がった例なし）。残りの低い例＝global-state（演算子）・stretchable image・geojson-line／buildings-in-3d（基図のアイコン＋POI＝段 3）・game-like-controls・nominatim。update-geojson-polygons の 5→0 は setData で動く例＝撮る時刻の差（文字が "5.0"→"Zoom: 5" に変わる）＝物差しの外。
- **段 2（2026-09-28・claude/text-stage-2）＝書体**：`text-font`（フォントスタック名の列）を **CSS の family／weight／style へ写す**（`ortho-core/src/fontstack.js`＝末尾の語 Bold/Semibold/Light/Italic… を weight/style に・残りを family に・複数の名前は family の列・Condensed 等の幅の語は捨てる）。基図/vector（labels.js→labels2d）と geojson（symbols-core→symbols-2d）の両経路で据える。無い書体はブラウザが落とす＝末尾にエンジンの既定の束（Noto Sans JP…＝CJK の質）。ネイティブ層は従来の束のまま。
  - **Web フォントを差す口**＝`map.addFontFace(family, source, descriptors)`（globe 1.6.0〜）＝main（DOM）と render worker（注記・記号・集約の canvas＝`self.fonts`）の両方に同じ FontFace を載せる。URL は先に取れるか確かめて HTTP の理由で reject。`style.glyphs`（glyph PBF）は読まない（裁定 (b)）。
  - 検定：`fontstack.mjs`（node）・t-mlcompat g=vector `symbol-text-font`（700／italic／family の順・太字は広い）・`add-font-face-api`。`__placed` は据えた font を返す。
  - 見送り（記録）：`format` の区間ごとの text-font／font-scale（連結のまま）・text-font の名前の重複解決（"Noto Sans Regular" と "Noto Sans Bold" を同じ family の別 weight として同時に読む＝descriptors で載せれば効く）。
  - 結果（o22s・低い 28 例＋Web フォントの例 3 本）：hit は段 1 と同じ（±1＝太字の幅の分）＝**書体は位置と有無の物差しを動かさない**（意図どおり：段 0 の裁定＝文字は形でなく位置と有無で測る）。style-labels-with-web-fonts／local-fonts／font-faces は 段 3 のまま。

- **段 3（2026-09-28・claude/text-stage-3）＝基図のアイコン**：記号帳を render worker の注記層（`labels2d`）にも写す＝main の記号帳（`gadgets/symbols.js`＝addImage／loadSprite）が `onImage`／`onImageRemoved` で globe に知らせ、globe が `set("labelImage", { name, bitmap, pixelRatio, sdf })`（ImageBitmap の写しを転送・null＝外す）。style の sprite は **どの経路の symbol 層でも icon-image があれば読む**（旧＝geojson の層だけ）。
  - `labels.js`（core）：`icon-image` を評価して**名前だけ**焼く（`icon`・記号帳は描く側が持つ＝sprite が後から届いても名前で引ける）＋ icon-size（`isz`）／-anchor（`ian`）／-offset（`ioff`＝px×size）／-rotate（`irot`）／-padding（`ipad` 既定 2）／-allow-overlap（`iov`）／-ignore-placement（`iig`）／-optional（`iopt`）・text-optional（`topt`）・icon-text-fit（`ifit`・none は焼かない）＋padding（`ifp`）・icon-color（`icol`・SDF）・icon-opacity（`iop`）。文字の無い層（icon-image だけ）もラベルになる（text ""）。重複排除の鍵に icon を足した（同じ点の文字と記号は別のラベル）。
  - `labels2d.js`（core）：`setImage`／`removeImage`（届いたら衝突判定をやり直す）・箱＝自然（size 倍・anchor／offset）か icon-text-fit（文字の箱＋上右下左の余白・width/height は片方だけ）・**裁き＝MapLibre の placement と同じ**（既定＝文字と記号のどちらかが置けなければ両方出さない／text-optional＝記号だけでも／icon-optional＝文字だけでも）・variable-anchor の候補ごとに記号（fit）も動く・icon-padding は判定だけ・記号帳に無い名前＝記号を描かず文字だけ（MapLibre の styleimagemissing 相当＝事象は鳴らさない）・SDF は icon-color で焼いて名前×色で覚える（symbols-2d と同式）・icon-rotate は箱の中心で・icon-opacity。`placed()` に `icon`（置いた記号の名前）と `ibox`（[中心 x, 中心 y, w, h]）・文字を置かなかったラベルは text null。当選の箱は配列から object（`{ sx, sy, tw, h, dx, dy, tl, an, txt, ib }`）へ。
  - globe：`__placed` に icon／ibox・VTD_UNSUPPORTED の symbol から icon-image を外した・render worker の `set` に `labelImage` を 1 つ。
  - 検定：core `tests/labels.mjs`（node＝焼く性質・出ない層）・t-mlcompat g=vector に `symbol-icon-base-layer`（style の層＝labels.js の経路・sprite・赤いインク）／`symbol-icon-anchor-offset-size`／`symbol-icon-text-fit`／`symbol-icon-text-optional`（既定 0・text-optional で記号だけ・icon-optional だけは 0）。試料＝style に `sprite: fixtures/mlcompat/sprite-a`＋基図の層 `poi-ico`。
  - 見送り（記録）：symbols-2d（geojson の記号）との部品の共通化（箱・候補・描画）＝overlay は依存ゼロの契約＝写しのまま／`styleimagemissing` 事象／icon-halo-*／icon-translate／icon-rotation-alignment／text-variable-anchor-offset の記号側。
  - **結果（o23・この機械＝自宅・r7 は録り直し）**：記号つきの層が当たるようになった＝poi_r1 0/3→3/3・5/13→11/13・11/15→15/15・1/3→3/3／places 0/8→8/8／poi-theatre・bar・music・bicycle 0→全／airport 0/1→1/1／drone・water-name-other 0→1。全体＝hit 1720/2139（80%）・0.6 未満 10・同じ絵 55。
  - **機械差の切り分け（轍）**：この機械の r7 は事務所の r7 と別の記録（timeout の例・網の取りこぼしが違う）＝known.json との「下がった」16 例は**変更なしでも同じ**（`git stash` して同じ r7 に対し o22m を回すと 14 例が同じ顔ぶれ・「query: missed fill/line」＝衛星タイルや AW3D30 が replay に無く失敗→被覆が揃わない）。**別の機械で門を回す時は、まず変更なしで oNNm を取り、oNN と例ごとに突き合わせる**（levels と text.hit/n・layers）。o22m→o23 で下がった display-a-hybrid-satellite-map-with-terrain-elevation（26→15）は probe で変更あり／なしとも 14/3＝環境の揺れ。o23 の no-map 3 例も再走で 2 に戻った（揺れ）。known.json は**更新しない**（この機械の r7 で書くと事務所の基準を壊す）。
  - ついでの根治：注記が地形より先に届くと標高 0 のまま置かれる（DEM の生き替わりで付け直さなかった）＝labels2d に `setElev`・render worker の "dem" で基図と利用者層の注記へ標高を付け直す。mountExtExtras は terrain を sprite より先に（sprite は大きいと数秒）。
  - main の既存の失敗（この仕事の外・origin/main 803a35bd・自宅の機械）：globe `tests/expr-golden.mjs` が road-face／road-hi-face の line-width で 6 件落ちる（style-*.js の変更に黄金の写しが追随していない）／t-mlcompat g=layers の fill-layer-draws-only-polygons（point Δ96 line Δ105）・fill-no-outline・circle-opacity が GL2・WebGPU とも同じ値で落ちる。**どちらも変更を stash しても同じ**＝段 3 の門では「同じ値で落ちる」ことだけ確かめた。他＝g=style／vector／extrude／mlt（GL2）と g=vector（WebGPU）は全部緑・core と globe の node 検定は expr-golden 以外緑。
- **段 4（2026-09-28・claude/text-stage-4）＝線に沿う注記**（symbol-placement "line"／"line-center"）：基図（mlstyle の振り分けが基図へ通す＝旧「line labels」の描かない層を廃止）と vector source（vtdraw＝枠で切った線を渡す）の両経路で、core の `labels.js` が線の**錨の候補と折れ線**を焼き、`labels2d` が**字を 1 字ずつ線に沿わせて**描く。
  - `labels.js`：`lineAnchors`＝線の部分ごとに、文字が収まる範囲（最初＝文字の半分＋2 字分・終わり＝文字の半分手前＝MapLibre の getAnchors）に候補を step＝max(文字の長さ, spacing/4) で置く（錨はタイルの中だけ＝隣のタイルのバッファと二重に出さない）。line-center＝中心 1 つ。**短い部分（枠で切った線・過拡大）で最初の余白が取れない時は、文字が収まるなら中心に 1 つ**（MapLibre は過拡大のタイルで間隔が縮む＝その近似）。記録＝`lp`・`path`（Float64Array 経緯度・錨の前後＝文字の長さ×0.75＋2 字分）・`ai`・`sp`（symbol-spacing px）・`ma`（text-max-angle）・`ku`（keep-upright）・`mw:0`。文字の長さは字数×size×0.7 の見積もり（本物の幅は描く側）。線の記号（icon）は出さない・面の輪郭には置かない（記録）。
  - `labels2d.js`：`lineLayout`＝折れ線を毎フレーム画面へ投影（錨の標高を全頂点に）→ 弧長 → 字送り（measureText を font×字で覚える＋letter-spacing）→ 錨を中心に字を並べる。窓に収まらない・裏・隣の字との角が max-angle 超＝置かない。keep-upright＝並びが右→左なら逆順（字は常に正立）。text-offset の y＝線と直角（em）。衝突＝字ごとの箱（padding 込み）・**symbol-spacing は描く側が同じ群（層＋文字）に画面 px で課す**（候補はタイルが細かく焼く＝表示 z に追随・継ぎ目の二重もこれで抑える）。描画＝字ごとに translate/rotate して halo＋fill。`placed()` に `line:true`（x,y＝錨の字・w＝字送りの和）。診断＝`__placedDebug().line`（n/layout/off/overlap/spacing/ok）。
  - 門：`compare.mjs` の textMatch に線沿いの物差し＝本物は線の記号の位置を返さない（線の幾何だけ）ので**層ごとの本数**で測る（`lineHit`＝層ごとの min(本物, こちら) の和・`linePlaced`・`lineLayers`）。こちらの線の注記は extra に数えない。`--grade` の文字の行に「線沿い 本物／こちら／重なり」。
  - 検定：core `tests/labels.mjs`（候補の間隔・中心・短い線・path/ai/sp）・`tests/mlstyle.mjs`（rd が基図へ）・t-mlcompat g=vector `symbol-line-base-layer`（style の層＝tile worker・y＝道路・インク）／`symbol-line-offset-and-center`（vtdraw・直角の offset 16px・中心 2）・g=style の描かない層の見本を rd-lbl から heatmap（hm）へ。
  - 門の順位表から足した口（同日）：①`symbol-placement` が式（road_shield_us＝`["step",["zoom"],"point",11,"line"]`）＝地物ごとに評価 ②**線の錨に回さず置く**＝text-rotation-alignment（記号だけなら icon-rotation-alignment）が viewport ＝点の注記として錨へ（`lp` 無し・`sp` だけ課す・記号＋文字＝道路の盾）③**線に沿う記号**（road_oneway の矢印）＝錨で線の向きに回す（`ira` auto/map＋icon-rotate・viewport なら正立・SDF は icon-color）・箱は回した記号を囲む矩形・文字と一緒に裁く。
  - 轍：①vtdraw の worker で `clipLineGeom` が null（枠の外の線）を返すのを見ていなかった＝contours の source の組み立てが丸ごと落ち「query: missing line」（add-a-vector-tile-source 3→1）＝o24 で発覚・直した ②**px→タイル単位は extent/256**（このエンジンのタイルは 256px 世界＝タイル z＝エンジン z で 16 単位/px。最初 extent/512 にしていて窓が半分＝1:1 の例で字が収まらず「fit」で全滅）③錨が頂点と一致すると長さ 0 の線分ができ角度が跳ぶ＝投影で重なる点を捨てる ④字の向きは微小線分でなく **字の中心を挟む弦（max(字送り, 1.5 字)）**（小川のジグザグ＝タイル z が MapLibre より細かい分だけ折れ線が粗い）⑤zoom 式で "point" になる盾は MapLibre だと線の各部分の先頭の頂点に置く＝点の注記も線を受ける（Polygon は vtdraw の極だけ）。診断＝`__placedDebug().line`（n/layout/off/overlap/spacing/ok＋layout の内訳 back/fit/angle/empty・fitEg/angEg）。
  - 過拡大の近似：候補の間隔と最初の余白はタイル z の目盛り（表示 z を知らない）＝短い部分は「線が文字長の半分以上なら中心に 1 つ」（収まりは描く側が画面の字送りで裁く）。深い過拡大では候補が疎になる（記録・MapLibre は過拡大のタイルごとに組み直す）。
  - 近似（記録）：symbol-spacing の候補間隔と最初の余白はタイル z の目盛り・text-pitch-alignment は viewport（字は画面に正立・傾けても潰れない＝段 5）・line-center は枠で切った部分ごと（vtdraw）／バッファ込みの部分ごと（基図）・線の記号と文字は両方置けなければ出さない（optional は読まない）・面の輪郭・geojson（symbols-2d）の線置きは未対応。
  - 結果（自宅の r7・o23→o26）：線沿い＝本物 706／こちら 261→430→**471**／層ごとの重なり 196→310→**350**。点の hit 1720→1728（変わらず＝線の注記が点の注記を押しのけていない）。contour-labels 0→42（本物 11）・highway-name-major 22/23・road_shield_us（盾）0→10（本物 7）。**最終 o27＝本物 706／こちら 583／重なり 435（62%）**・点の hit 1725（不変）・同じ絵 54。まだ 0 の層（本物 5 以上）＝geolines-label（30）・highway-name-major（5）＝次に拾う（geolines-label＝MapLibre の例 "geolines" の線の注記＝要調査・highway-name-major 5＝1 例の取りこぼし）。o25 で 0 だった盾（highway-shield・road_shield_us）と矢印（road_oneway）は o27 で数えられている。known.json は未更新（機械差）。
- **段 5（2026-09-28・claude/text-stage-5）＝向き**：`text-rotate`・`text-rotation-alignment`（map＝地図の回転に追随／viewport／viewport-glyph＝線の上で字だけ正立）・`text-pitch-alignment`（map＝傾けた地面に寝かせる）・`icon-rotation-alignment`／`icon-pitch-alignment`（点の記号も map なら地面に）。labels.js は既定（auto・0）を焼かない（`rot`・`ra`・`pa`・`ipa`）。
  - `labels2d.js`：**錨での地面の基底**（`groundBasis`＝東と南へ画面 20px 相当だけ進めた点を投影した画面ベクトル＝bearing・pitch の縮み・遠近が入る）から Canvas の transform を組む（`orient`）＝pitch map は基底を一番伸びている向き（σmax）で正規化（傾けた直角方向だけ縮む・距離で大きさは変えない＝近くの注記が巨大化しない）・rotation map＋pitch viewport は東の向きへ回すだけ・text-rotate はその上で回す。点の注記は錨を原点に transform して描き、衝突の箱は transform した矩形を囲む箱（`aabb`）。記号は自分の map 指定があればそれ・無ければ文字と同じ transform（icon-rotate だけなら従来どおり箱の中心で回す）。線の字は上向きを「地面で線と直角」（M⁻¹ で地面の向きを取り rot90 して M で画面へ）＝既定（auto→map）で傾けると字が地面に寝る。viewport-glyph＝字は正立のまま線に沿って並ぶ。`placed()` の w/h＝画面の箱（transform 込み）。
  - 検定：core `labels.mjs`（焼く性質）・t-mlcompat g=vector `symbol-text-rotate`（w/h 入れ替わり）／`symbol-rotation-alignment-map`（bearing 90 で縦）／`symbol-pitch-alignment-map`（pitch 60 で高さが縮む・線の字も）。
  - 近似（記録）：pitch map の大きさは距離で変えない（MapLibre は遠近で縮む）・地面の基底は錨 1 点（線の注記も錨の基底を全部の字に）・icon-rotate だけの記号の衝突箱は回さない・text-rotate は線の注記には効かせない。
  - 結果（o28）：点の hit 1724／2139（不変）・線沿い 本物 706／こちら 570／重なり 427（o27 と同じ水準）・同じ絵 54＝**向きは位置と有無の物差しを動かさない**（意図どおり・段 2 の書体と同じ）。効き目は傾けた絵と回した絵（実機で見る物）。
- **残件 ①（2026-09-28・claude/text-followup-1）＝geolines-label 0/30**：全球ビュー（z1）の赤道・回帰線の注記。原因 2 つ＝(a) 折れ線の窓の端が地球の裏に届くと丸ごと却下していた → **錨を含む表側の連続区間だけ使う** (b) 錨が窓の端（縁で切れた所・短い窓）に近いと文字が収まらず「fit」で落ちた → **錨の弧長を、文字が収まる範囲へ寄せる**（候補はタイルの目盛りで疎＝寄せて拾う・spacing は寄せた後の位置で裁く）。display-a-map の geolines 0→3（本物 5・残り 2 は極圏の線が縁で 50px しか見えない）。門 o29＝線沿い 本物 706／こちら 604／重なり **454**（o28 570／427）・点の hit 1779／2204（89 例）。
- **残件 ②（2026-09-28・同 branch）＝poi_transit 0/25（3 例）と線沿いの取りこぼし（highway-name-minor 52/89）**：(a) **層をまたぐ重複排除**＝同じ点・同じ文字・同じ記号の注記を labels.js の `seen` と tilemanager の `labels()`（近景タイルの結合）が 1 つに畳んでいた＝poi_r1 が先に出すと poi_transit が消える。MapLibre は両方置いて後の層が勝つ → **MapLibre 由来の層は層ごと**（鍵に li・記号だけの注記は記号名も）。ネイティブの基図は従来どおり層またぎで 1 つ。display-buildings-in-3d の poi_transit 0→14（本物 10）。(b) **symbol-spacing の群**＝「層＋文字」で全地物にまたいで課していた → MapLibre と同じく **1 本の線（タイル・層・地物・部分＝`lg`）の中だけ**（隣の区間の同名の道は両方出る・重なりは衝突が裁く）。同例の線の注記 ok 74→154。門 o30＝点の hit 1794／2204・0.6 未満 9→7・同じ絵 55・線沿い 本物 706／こちら 909／重なり 471（こちらの本数が本物を超えた＝線ごとの spacing で同名が増えた・線の extra は物差しに無い＝記録）。診断＝`__placedDebug().pt`（点の注記の層ごとの n/noimg/text/icon/off/spacing/ok）。
  - 観察（別件・自宅の機械）：change-a-maps-language（国名 4/52）は注記の問題でない＝この機械では main の結合 order が 1 枚（3/2/2＝アメリカ側）のまま・cache は 11 枚 ready・coverOk が永遠に false（idle は timeout）＝globe の低 z（ML 2.9・緯度 48）でタイルの選抜が止まっている。事務所（o21）では段 3 だった＝機械差か揺れ。変更なし（o22m）でも同じ。国名の注記そのものは front の 19 個中 7 個を置いている。
- **残件 ③（2026-09-28・claude/text-followup-2）＝出しズームの外の注記を送らない**：display-buildings-in-3d で main が worker へ送る注記 19173 個のうち poi_r20（minzoom 18）が 15753＝描く側が zoom 域で捨てるだけの物を毎回 structured clone で送り、150ms ごとの衝突判定も全件走査していた。タイルは z ごとに 1 度しか組まない（過拡大で使い回す）ので**タイル側では飛ばせない**＝main の `rebuildLabels` が `minZ/maxZ`（エンジン z）でこの整数 z の間に出得る物だけ送り、`labelGate` に "Z"＋整数 z を足して整数 z を跨いだら拾い直す（sig 不変でもラベルだけ作り直す既存の仕組み）。19173→2505。検定＝t-mlcompat g=vector `symbol-zoom-gate-crossing`（poi-lbl を z19〜にして restyle なしのズームだけで出る・戻すと消える。z19 では poi-ico が同じ点に先に置かれ文字を押しのける＝MapLibre と同じ＝検定の間だけ外す）。ネイティブの基図も同じ道（minZ を持つ層は同じ裁き・整数 z 跨ぎの作り直しが増える＝軽い）。
- **残件 ④（2026-09-28・claude/text-followup-2）＝`styleimagemissing`**：記号帳に無い名前を MapLibre 同名の事象（`{ id }`・名前ごとに 1 回）で知らせる＝聞き手が `addImage` すれば出る。名前の出所は 2 つ＝基図/vector の注記（labels2d の `iconImg` が集め `takeMissing` で render worker が `labelImageMissing` を main へ）と geojson の記号（symbols-core の `missing`→symbols.js の `onMissing`）。main の `imageMissing(name)`（鳴らした名前の集合・記号帳にあれば鳴らさない）→ `mapOn.styleimagemissing`。symbols.js は addImage の時に「その名前が missing だった層」も評価し直す（式で組んだ名前は layout の文字列に無い）。通訳＝`ENGINE_EVENTS` に足し `setMissingStyleImageResolver(fn)`（MapLibre 6 の省略形）を `on("styleimagemissing", e => fn(e.id))` に。検定＝t-mlcompat g=vector `styleimagemissing-event`（両経路・1 回ずつ・addImage で出る）。d.ts に一行。門 o32＝generate-and-add-a-missing-icon-to-the-map の unsupported が消え文字 0/3→3/3（段は下の行のとおり）・全体は o31 と同じ水準。
- **残件 ⑤（2026-09-28・同 branch）＝過拡大での線の候補の疎さ**：display-buildings-in-3d（z15.5・pitch 45・z14 タイル＝過拡大 2.8 倍）で highway-name-minor の候補 86 のうち画面内 24・置けた 13（本物 24）。タイル側の「最初の錨＝文字の半分＋2 字分」「短い部分＝文字の半分以上で中心」がタイル z の目盛り＝画面では 280px 以上の区間にしか候補が無かった。**最初の余白を 1 字分に・短い部分の予備を文字の 1/4 以上に**（収まりは描く側が画面の字送りで裁く）→ minor 13→26・major 16→23・path 2→6。送る注記は 2505→3491。門 o33＝線沿いの重なり 471→**512**（こちら 974）・点の hit 1741（不変）・こちらだけ 487→474。層ごとの診断＝`__placedDebug().lineBy`。
- **記号の残件 ①（2026-09-28・claude/icon-anim）＝動く記号（StyleImageInterface）**：通訳の `addImage` が `render()`（または `data.renderWithWebGL`）を持つ画像を受ける＝`onAdd` → 毎フレーム `render()`（true＝変わった）→ 画素を差し替える。`data` が画素列ならそのまま・`renderWithWebGL` は画面外の WebGL2 に描かせて `readPixels`（行は上から＝MapLibre の atlas と同じ向き）。差し替えはエンジンに足した **`map.updateImage`**（MapLibre 同名）＝層を評価し直さない軽い口（gadget の記号帳の絵だけ替えて overlay と注記層へ写す）。labels2d は箱の大きさが変わる時だけ衝突判定をやり直す（毎フレームの全件の再衝突をしない）・受け手は古い絵を close。差し替えの途中は次のフレームを飛ばす（溜めない）・最初の登録が済むまで差し替えない。`removeImage`／`remove()` で止めて `onRemove`。ついで＝記号の層の source が素の Geometry（Feature で包まない）でも受ける（MapLibre は受ける）。
  - 轍：①通訳のモジュールの中の `Map` は地図のクラス（`new Map()`＝地図を作ろうとして "Container 'undefined'"）＝`globalThis.Map` ②最初の addImage（非同期）の前に来た updateImage が「無い名前」として pixelRatio 無しで足していた＝幅 2 倍 → エンジンの updateImage は足している途中の画像を待つ。
  - 検定：t-mlcompat g=vector `update-image-repaints`（注記の canvas の色が赤→緑・箱は不変）。通訳の本体は門で＝o34 で add-an-animated-icon-to-the-map・animate-an-icon-on-the-gpu が段 1→2（動く例の上限）・unsupported から消えた。
- **記号の残件 ②（2026-09-28・claude/icon-stretch）＝伸びる記号・overlap・geojson の記号の文字の組み**：`stretchX`／`stretchY`／`content`（addImage の opts と sprite の JSON）を記号帳に持たせ overlay と注記層へ写す・icon-text-fit の時は `stretchFit`＝伸びる区間だけ同じ倍率で伸ばし content を文字の箱＋余白に重ねる・`drawStretched`＝区間の組ごとに drawImage（9 分割の一般形）。symbols-2d と labels2d に同じ式（overlay は依存ゼロ）。`text-overlap`／`icon-overlap`（MapLibre 新・allow-overlap に勝つ・cooperative は always 扱い＝近似）を両経路で。geojson の記号（symbols-2d）に `layoutText`＝`\n`・text-max-width（ML 既定 10em・ネイティブ 0）・行高・字間・justify・text-transform（worldcontent 等のネイティブは従来どおり 1 行・左寄せ）。overlay の `placed()` に ibox。
  - 轍：行末コメントが同じ行の続きを飲み込む（overlay の image の行・labels2d の iconFit の行で 2 回）＝置き換えで行を足す時は改行を入れる。symbols-2d の frame 内は字下げ 3 タブ。
  - 検定：t-mlcompat g=vector `symbol-stretch-fit`（両経路・箱＝文字＋伸びない縁）／`symbol-geojson-newline-and-wrap`／`symbol-text-overlap-always`＝GL2 緑（2026-09-28 自宅）。その後（同日）＝GL2 style 群・WebGPU vector 群 緑・GL2 layers 群は main と同じ既存の 3 件だけ（updateImage を zoomscale.js の分類表に載せ忘れて 1 件落ちた＝直した）。門 o35＝点の hit 1721／2139・線沿いの重なり 507・同じ絵 55・**0 動かない 4**（o34 は 1）＝揺れか退行か未確認＝次に o35 と o34 を例ごとに突き合わせる。
  - **o35 の「0 動かない 4」の確認（2026-09-28 夜・自宅の機械）**：同じ枝で全 139 を回し直した o40（本物 r7＝この機械の録り）＝**0 動かない 1**（display-performance-metrics の no load＝いつもの 1 本）・動く 34／同じ答え 39／同じ絵 63・下がった例なし＝o35 の 4 は揺れ（会社の機械の負荷）。上がった 4 本（add-an-animated-icon-to-the-map・animate-an-icon-on-the-gpu・display-a-remote-svg-symbol・generate-and-add-a-missing-icon-to-the-map＝段 1→2）を known.json へ。文字＝点の記号 hit 2086/2418（86%）・インク 2065/2173・線沿い 本物 714／こちら 1008・層ごとの重なり 521・0.6 未満 2 例。regionless の許可を 279→278 に下げた（symbols-2d の "jp" 2→1＝良い知らせ）。
- **記号の残件 ③（2026-09-28 夜・自宅・claude/global-state＝#107 の上）＝global-state**（MapLibre v5 の `setGlobalStateProperty`／`getGlobalState`・式 `["global-state", 鍵]`）：
  - **core `expr.js`**：モジュール（＝スレッド）の状態 `GS`・`setGlobalState(obj)`／`getGlobalState()`・演算子 `global-state`（鍵は文字列の定数・無い鍵は null＝MapLibre と同じ）を KNOWN_OPS と build に・`usesGlobalState(x)`（層がそれを読むか）。
  - **globe `map.setGlobalStateProperty(k, v)`／`map.getGlobalState()`**（globe 1.7.0〜・MAP_MEMBERS・d.ts）＝状態を変え、**それを読む層だけ**評価し直す：geojson の fill/line/circle＝gint の表（main の buildMLTable・`e.h.setPaint({}, null)`）／記号・集約・模様・押し出し＝`relayer`（main）／vector の描く層・押し出し＝層の `metadata["ortho:gs"]` の版を上げて `relayer`（組み立ての署名が変わる）＋vtdraw の build の rpc に `gs`（worker で `setGlobalState`）／基図の層＝`restyleBase`（style に `globalState`＝tile worker が init/setStyle で `setGlobalState`）。
  - **style の root の `state`**（`{ 鍵: { default } }`）＝`loadExtStyle` で既定値に（新しい style は状態を入れ替える）。
  - **通訳**：`setGlobalStateProperty`／`getGlobalState` を `ask` で渡す（unsupported から外れる）。
  - 結果：公式例 **filter-layer-symbols-using-global-state 段 1→3**（同じ絵・文字 5/5・unsupported なし）。検定＝t-mlcompat g=layers **`global-state-filter`**（公式例の形そのまま＝geojson の円＋記号・空/a/b/空）・g=vector **`global-state-vector`**（vtdraw＝worker で評価）＝GL2/WebGPU 緑。
  - 門 o42（全 139・本物 r7）＝0 動かない 1／動く 34／同じ答え 39／同じ絵 63・上がった＝filter-layer-symbols-using-global-state 1→3。下がった jump-to-a-series-of-locations 3→1 は**揺れ**（読み込み後 2 秒ごとに 10 秒カメラを跳ばす例＝撮る時刻で絵が変わる・global-state は使っていない）＝単独で 2 回回して 2 回とも 3（o43s1/o43s2）。known.json は上がった 1 本だけ手で反映（`--update` は揺れも書き込むので使わない）。
  - 物差しの限界（記録）：この例の文字は text-offset [0,1]・anchor top＝錨の 1em 下に描く＝インクの箱（錨の ±24×±10px）の外＝ink 0/5（hit は 5/5）。インクの箱を text-offset で寄せるのは次の物差しの改良。
- **color-relief（#114・2026-09-29 段 0）＝本物 6.11.2 の振る舞いを dist で読んだ**（`ColorReliefStyleLayer._createColorRamp`・`colorRelief` のシェーダ）：
  - 色の段は **`interpolate` の時だけ**＝段の標高（labels）で色を評価して 1×N のテクスチャへ（事前乗算）・画素は DEM の標高で段を二分探索し、隣の 2 段の間を **LINEAR の標本で線形**＝曲線（exponential・cubic-bezier）も色空間（hcl・lab）も段の間は線形になる。
  - `step`・`match`・定数色は Interpolate でない＝段の表が空→**[0: 透明]＝全部透明**（裁定「本物に合わせる」）。範囲の外は CLAMP_TO_EDGE＝**端の色**。段は最大 MAX_TEXTURE_SIZE（超えたら間引き）・段の標高は DEM の符号に詰める（terrarium なら 1/256 m 刻み）。
  - `color-relief-opacity`（既定 1・遷移あり）は色に掛ける・`resampling`（linear／nearest）は DEM の標本。source は raster-dem 必須（検証で落とす）。
  - 検定（段 0）：node `mlcompat.mjs` の `elevation-op`・`style-color-relief-routed`・`color-relief-ramp-*`（段の表の口＝globe `src/colorrelief.js` の `reliefRamp`／`reliefAt`＝事前乗算の 0〜1）・t-mlcompat `?g=relief`（style で起動・円錐の頂＝赤・中腹＝紫・裾＝青・step は透明・不透明度 0.5・外す・addLayer）。全部既知（段 1＝core・段 2＝globe）。
  - **段 1〜4（同日）**：段 1＝core `expr.js` に `elevation`（`ctx.vars.elevation`）・`mlstyle.js` が raster-dem の color-relief を利用者の層の口へ（hillshade と同じ行）。段 2＝globe `src/colorrelief.js`（`reliefRamp`／`reliefAt`／`reliefTile`／port プロバイダ）・kind `colorrelief`・`color-relief-opacity` は画像タイル層の不透明度（作り直さない・`["zoom"]` の式は settle で見直す）・色を変えたら載せ直す。段 3＝`src/demtiles.js`＝raster-dem のタイルの在庫を source ごとに 1 つ（hillshade と共有・使う層が居なくなったら捨てる）＝同じ source に 2 層で 26 本中 12 本の二重取得→0。段 4＝関門・門・d.ts（`MapLibreLayer.type` に hillshade／color-relief）・版上げ（core 1.9.0・globe 1.8.0）。
  - **門 ocr1（本物 r7・2 本だけ）**：add-a-color-relief-layer **2→3**（同じ絵・目で見ても同じ）。add-3d-terrain-from-quantized-mesh-tiles は 2 のまま（例は第三者のプラグインで quantized-mesh を raster-dem に変える形＝#110 の口は通らない・「基図が違う」＝OSM の raster）。
  - 残す違い（文書）：`resampling`（nearest）は読まない＝画素ごとに色を引いて画像タイル層の標本に任せる。段の標高を DEM の符号に詰める量子化（terrarium で 1/256 m）はしない。段の数の上限（MAX_TEXTURE_SIZE）は無い。
- **タイルの z（2026-09-29・claude/mlcompat-tile-cover）＝MapLibre の coveringTiles と同じ規則**：門 o44 の順位表の塊「OpenFreeMap bright・ワシントン z11.15 の問い合わせが揃って 121/160」（popup・filter-symbols・variable-label の 6 例）の原因＝**本物は z11 のタイル、こちらは z12**（`12/1171/1566`）。TILE_BIAS（画面 px の閾×sec φ0）は z の小数部が約 0.13 を超えると一段細かく、さらに静止時の手前詳細化（IDLE_TILE_PX 384・gpuFast の機械だけ＝機械差の一因）で一段細かかった。
  - core `src/mlcover.js`（新）：`mlTileZoomOf(cam, Hcss, { dz, fovDeg?, terrain? }, { tileSize, round })`＝MapLibre 6.11.2 の dist を写した。傾き ≤ clamp(78.5−fov/2, 0, 60)° かつ地形なし＝一定の floor(MapLibre の z＋log2(512/tileSize))（raster は round）／それ以外＝`mlCalculateTileZoom`（defaultCalculateTileZoom＝距離と見込み角・メルカトル単位・MapLibre のカメラ fov 36.87° と画面の高さ CSS px で組む＝エンジンの fovy に依らない）。`selectLOD` に `zOf`（渡すと画面 px の閾・sticky・floorZ を使わず「望む z まで割る」・可視判定はそのまま）・`tilemanager.update` が主層にだけ通す（下地・毛布は従来）。
  - globe：`ML_COVER`（目盛り mercator／maplibre の時だけ・ortho は null＝内製アプリは無改修）・`mlZoomOf(tileSize, round)`＝基図（tiles.update）・vector の描く層（vtdraw）・押し出し（vtextrude）に渡す。terrain＝`!noTerr`（MapLibre の setTerrain で地形が出ている）。ML の目盛りでは keepFine（ズームアウトの子孫代打）も切る（細かい子孫が残ると本物と違うタイルを問い合わせる）。
  - 轍：①**整数の z の換算の誤差**＝公開 9 が 8.9999999996 になり切り捨てで z8（網に無いタイル＝答えが空・fly-to 系 4 例が 3→1）→ `ZEPS` 1e-6 ②**通訳の `viewOf` が起動の z を `toFixed(5)` で丸めていた**＝getZoom が 10 でなく 9.9999953（z13 で 1.5e-6・z7 で 4e-6＝ZEPS を超える）→ 丸めない（getZoom も本物と同じ 10 になる）。
  - 検定：core `tests/mlcover.mjs`（10 件・npm test に連結）・globe `tests/mlshim.mjs`（viewOf は丸めない）・t-mlcompat **`?g=cover`**（新群・zoomScale "mercator"＋試料 optbv＝公開 13.6 は z13（旧は z14＝無いタイルで答えが空＝直しを外して赤を確認）・ちょうど 10 は z10）＝verify:ui・verify:webgpu に登録。関門＝ルート npm test・globe verify:ui 58／webgpu 50・japan verify:japan 22＋17 全緑。
  - **門 o47（本物 r7・この機械）**：o44 比＝動く 34→28・**同じ答え 38→44**・同じ絵 64（据え置き）・下がった例は既知の揺れ（jump-to-a-series-of-locations）だけ。上がった 6 例（display-a-popup-on-click／hover・filter-symbols-by-text-input／toggling-a-list・variable-label-placement（-with-offset））を known.json へ手で。順位表＝query: missed line 19→13・missed fill 14→7・extra line 12→5・extra fill 12→4。文字 hit 2057→2067（不変）。
  - 近似（記録）：MapLibre の globe 投影の例（globe は z>4 で距離式）もメルカトルの規則で選ぶ・raster（画像タイル層）は worker の中の選びでまだ従来の閾（`round` の口は用意済み＝次）。
### 8.x 再開の手引き（2026-09-28 夜・別の機械から続ける時に読む所）
**最新（2026-09-29 夜）＝ここから読む**：#107・#132 はマージ済（9/29）。門 o44（main e592b06b）＝同じ絵 64・同じ答え 38。タイルの z を MapLibre の規則に（上の「タイルの z」）＝o47 で同じ答え 44。次の順位表＝basemap looks different 23・added layers look different 13・query: missed line 13・camera differs 7（padding＝消失点のずれ＝core camera.js の投影行列に手が入る＝本人裁定）・engine error 3（canvas source・COG・setLayoutProperty の無い層＝MapLibre は error 事象で投げない）。

**旧・最新（2026-09-29 朝・自宅）**：
- main＝文字の段 0〜5・注記の残件①〜⑤（#98〜#106）＋他の流れ（#112 影・#43 楕円体・版上げ core 1.8.0／globe 1.7.0＝**globe 1.7.0 は未公開**＝npm の最新は 1.6.0）。
- **#107（記号の残件①②・claude/icon-stretch）＝開いたまま**。門 o35 の「0 動かない 4」は揺れと確認済（o40＝1・PR 本文に記録）。⚠ 別のセッションが 2026-09-29 04:17 に main を取り込んで push している（efd07e13）＝この枝は並行して触られうる。取り込む時は `git fetch` してリモートの上に積む（強制 push しない）。
- **#132（記号の残件③ global-state・claude/global-state）＝#107 の上**。リモートの #107＋main（#131 まで）を取り込み済・node／regionless／t-mlcompat＋t-mlboot（GL2 8 頁・WebGPU 2 頁）緑・門 o42＝filter-layer-symbols-using-global-state 1→3。#107 を先にマージすれば #132 の差分は global-state だけ。
- **版の書き方**：未公開の新しい口は「globe 1.7.0〜」（次に publish される版）。1.5.2 は出していない（1.6.0 に吸収）。
- **次の候補**：門の順位表の上から（`--grade` の「足りない口の順位表」）・インクの箱を text-offset で寄せる（物差しの改良）・deploy／publish（号令待ち）。

**ここまで**：#97 idle×画像タイル層／#98 段 0（文字を測る）／#99 段 1（layout）／#100 段 2（書体）＝全部 main。**段 3（基図のアイコン）＝2026-09-28 自宅で実装（branch claude/text-stage-3・上の「段 3」に記録）**。文字の物差し（本物 r7 × こちら）＝hit 61→85%・0.6 未満 26→10・同じ絵 63。deploy／npm publish は**未**（core 1.6.1・globe 1.5.1・japan 1.5.1 は版だけ上げ済＝publish するなら `addFontFace` を含めて globe 1.5.2 に上げてから）。

**この文書が正典**：機械ごとの記憶（Claude の memory）は同期されない。判断・数字・轍は §8 に全部ある。次の人（自分）は「§8 の段 3 から」で始められる。

**段 4（線沿い）＝PR #103・段 5（向き）＝2026-09-28 自宅で実装（branch claude/text-stage-5・上の「段 5」に記録）＝文字を測る計画 0〜5 は一巡**。**次**＝残件を門の順位表から拾う：geolines-label 0/30（線の注記・要調査）・symbols-2d（geojson の記号）との部品の共通化と線置き・`styleimagemissing`・icon-halo・icon-translate・面の輪郭の注記・過拡大で候補が疎（線）・`format` の区間ごとの書体。

**済＝段 3（基図のアイコン＝台帳 §8 の段 8②と同じ）**（当時の計画・実装は上の「段 3」）：
1. sprite は今 geojson の symbol に icon-image がある時だけ読む（`src/globe.js` `mountExtExtras` の `ext.split.geojson.some(icon-image)`）→ 基図の symbol 層（`ext.split.base`）にも icon-image があれば読む。
2. 記号帳（名前→ImageBitmap・pixelRatio・sdf）を render worker の注記 canvas（`labels2d`）へ渡す口（`renderer.set("labelImages", …)` か symbols overlay と同じ `image` 通信）。
3. `labels.js`：icon-image（式を評価）・icon-size／anchor／offset・icon-allow-overlap／ignore-placement・icon-optional／text-optional・icon-text-fit（＋padding）をラベルに焼く（`layoutOf` に足す）。M2 の「アイコンだけの層は skip」を外す。
4. `labels2d`：箱＝icon と text の合成（symbols-2d の `textBox`／`iconFor`／SDF の色焼き `sdfTint` と同じ意味論）。ここで **symbols-2d と共通の部品**（箱・候補・描画）を ortho-core へ切り出せば 2 経路が 1 本になる（段 1 の残件）。
5. 検定＝t-mlcompat g=vector に `symbol-icon-*`（記号帳は fixtures/mlcompat/sprite-a）＋門 o23（icon+text 0.49／icon 0.41 が上がるか＝`grades.json` の text.layers を poi_* で見る）。

**段 4（線沿い）・段 5（向き）**は §8「文字を測る」の計画どおり。線沿いは `symbols` の `placement:"line"` の数（714）が分母＝位置の物差しは別途（本物の記号は線の幾何しか返さない＝錨の画面位置が無い）。

**道具**：
- 門：`npm run verify:examples -- --side ortho --ref r7 --label oNN`（採点まで）／`--only a,b`（部分）／`--grade --ref r7 --ortho oNN [--update]`／見比べ帳 `.cache/mlexamples/report/oNN/index.html`（launch.json `mlexamples-report`）。**`.cache/mlexamples/`（網の録り置き `net/`・本物 `runs/r7/`）は機械ごと**＝無い機械では `--side ref --label r7 --record-missing`（網に出る・139 本・10〜20 分）を先に。r6 以前の本物の記録には `symbols` が無い（段 0 以降は r7 以降を使う）。
- 切り分け：`node tests/mlexamples/probe.mjs <例> '<式>' [秒]`（例の頁で式を評価＝`__placed()`／`__placedDebug()`／`__idleWhy()`／`__labelsMain()`）／`node scripts/probe-page.mjs <group> '<式>' [秒]`（t-mlcompat の頁）。
- 関門：`npm test`（globe・core）・`npm run verify:regionless`・`VGU_PORT=52xx npm run verify:ui`・`VGW_PORT=52xx npm run verify:webgpu`。**verify:ui と verify:webgpu を同時に走らせない**（t-mlcompat の色の標本・hillshade の「前」の写しが負荷で揺れる）。関門の中は既定で 4 本ずつ並べる（2026-09-29・`VG_JOBS`・6 本は揺れた・1 で直列）＝verify:ui 約 4.5 分・verify:webgpu 約 2.5 分（直列の約 16 分・9 分から）。worktree は `npm ci` から。
- 轍（今日）：runner の素通り判定は表題の /skip/＝場面の文言に "zoomSkipped" 等を載せない／`map.xxx =` は `const map` より後／`setLayerZoomRange` の引数は公開の z（旗なし＝ML＋1）／`decodePng` は `{w,h,rgba}`／関門の出力を `cut` で切ると場面の理由が消える。
