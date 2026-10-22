# geojson の層を vector の描き方へ（pattern-2d を GPU へ）・実施計画（2026-10-22 起案）

位置づけ：テキスト GPU 化（`text gpu plan.md`）の後に残った「毎フレームの Canvas2D の重ね描き」のうち、MapLibre の層を受ける **pattern-2d** を GPU に移す計画。
基図と利用者の vector の層（vtdraw）は、style 互換の波 1〜4 で fill-pattern・line-offset・破線・cap/join を GL2 と WebGPU の両方で描けるようになった（`globe/maplibre-compat.md` §6）。
geojson の層（gint）はその描き方を持たないので、該当する層だけ別の canvas2D（pattern-2d）で描いている。ここを **geojson を vector のタイルに切って vtdraw に流す**（MapLibre の geojson-vt と同じ考え方）ことで埋める。
掟は `perf plan.md` と同じ：①URL の逃げ道 ②既存の関門を緑のまま＋絵の一致 ③両バックエンド 1:1。並走との取り決めは §6。

## 0. 現状（main 124539fd）

| 層（geojson source） | 今の描き方 | 欠け |
|---|---|---|
| fill・line・circle（下以外） | gint（stencil-then-cover・カプセル線・地物ごとの表） | 無し |
| fill-pattern・line-pattern | **pattern-2d**（`kindOf`＝"pattern"・`addPattern` が地物を評価して経緯度列を送る・毎フレーム投影して `ctx.fill`／`stroke`） | CPU で毎フレーム全頂点を投影・WebGPU でも Canvas2D・地形に乗らない・層の位置でなく最前面の手前 |
| line-offset ≠ 0・line-gradient | 同上（`offsetPolyline`・`gradStops`） | 同上 |

問い合わせは `patItems`（画面の px で当てる）。vtdraw 側は fill-pattern・line-offset・破線・translate・blur を GPU で描く（line-pattern と line-gradient は未対応＝警告して色で描く）。

## 1. 設計

### G-1 geojson の切り分け（core・純関数）
- `geojsonvt.ts`（新・**済**）：`createGeojsonIndex(fc, { extent, buffer, layer })` → `tile(z, x, y)` が `DecodedTile`（source-layer は 1 つ＝`GEOJSON_LAYER`＝"_geojson"）を返す。
  - 地物の外接矩形で候補を引き（初版は素朴な走査・大きい source が来たら格子）、タイルの枠（＋buffer 64）で切る：線＝線分ごとに Liang–Barsky でつなぐ、面＝Sutherland–Hodgman（輪ごと・穴も・外周 > 0／穴 < 0 に揃える）。点は枠の中だけ。
  - 座標はタイルの extent（4096）に量子化。`id`＝数の Feature.id だけ（MVT と同じ・promoteId は G-2 で vtdraw が属性から引く）。式の `["geometry-type"]` は元の型（`gt`＝§4g と同じ）。
  - 日付変更線＝geojson-vt と同じく座標をそのまま読む（170→−170 は西回り）。またぐ地物は ±180 を越えた経度（190 など）で書き、世界の外にはみ出す分を ±1 周ずらして切る。
  - 簡略化はしない（初版）。maxzoom 既定＝MapLibre の geojson source の 18（エンジンの z へ換算・G-2 で記述子に）。それより上は過拡大（vtdraw の既存の扱い）。
- 検定：`tests/geojsonvt.mjs`（ortho-core の npm test）＝面積の保存・枠の外に出ない・穴と向き・日付変更線・タイルをまたぐ線の本数と切れ目・覆う面＝タイルの四角。

### G-2 vtdraw に「手元のタイル」の source（**済**・2026-10-22）
- 実装：記述子の `local`（data そのもの）＝取得の段が無い。main は data を版つきで組み役の worker へ 1 回ずつ送り（`gj`・build より先に postMessage の順で届く）、worker は `createGeojsonIndex` を預かって build で `index.tile(z,x,y)` を読む。層は `source-layer`＝`GEOJSON_LAYER` の vector の層として組む。setData は版を上げて送り直す（出しているタイルは組み直すまで残す）。
- 問い合わせは今までの模様の口（patItems＝画面の px）を使い続ける（隠した層・zoom 域の外は当てない）。
- **線のずらし（line-offset）は既定で vtdraw**。**面の模様（fill-pattern）は `?gjvt=2` の時だけ**（名前が定数の層）：core の模様の塗りは地形ありの 3D で地面アトラスに焼かない（vector の層も同じ穴・互換の台帳 §6「塗りの模様」の「次の段」）＝既定で移すと地形のある地図で模様の面が消える。名前は層で一度＝属性で模様を変える層も canvas2D のまま。地面アトラスの模様が入ったら既定に替える（1 行）。
- 門の実績：t-fillpattern（`?gjvt=2` で geojson の 3 場面＋pattern-2d を作らない・既定と両方で問い合わせ・隠す・setData）・t-linedeco ③（合成の絵で +15px）・t-linedeco?gjvt=0・t-mlcompat?g=layers（pattern-minzoom-and-query）。公式例の比べ（add-a-pattern-to-a-polygon）は外の取得が要る＝クラウドでは回していない。
- main：geojson source を vtdraw の記述子に `local: true` で登録（タイルの選び方・LRU・層の順の鍵は vector source と同じ）。取得の段で fetch せず、worker に「切って」と頼む。
- vtdraw-worker：`putGeojson(sid, fc, opts)` で index を作って預かる（setData＝作り直し・updateData＝差分で作り直し）。`build` の入口で生バイトの代わりに `index.tile(z,x,y)` を読む。以降の filter・buildTileDrawList・labels は vector と同じ。
- `kindOf`：geojson source の "pattern" の層を "vtdraw" へ（`?gjvt=0` で今の pattern-2d に戻す）。gint の層は**今のまま**（gint の方が速い所＝大きな面の stencil・地物ごとの表の書き換え）。例外＝後ろに基図の層がある geojson の fill／line／circle の層（基図の層の間に描く・S-P2・2026-10-22 Kenji 裁定）は vtdraw へ（`api/style.ts` の kindOfV）。
- 問い合わせ：queryRenderedFeatures は vtdraw の当たり（vector の層と同じ）。querySourceFeatures は今どおり data を返す。feature-state は vtdraw の fs の口。

### G-3 line-gradient（lineMetrics）
- MapLibre の line-gradient は geojson source の `lineMetrics: true` だけ。`["line-progress"]` は地物の線の頭からの長さの割合。
- G-1 の切り分けで、線の各部分に「元の線の全長」と「部分の頭の進み」を属性で持たせ、build.ts が頂点の進みを焼く。
- 色は進みの見本（64 段）を表に焼いて、シェーダが進みで引く（paint 表の (b) 類の行と同じ置き場が候補）。**線分レコード（8×u32）に語を足すかどうかは統合ロードマップと擦り合わせ**（§5 裁定待ち 2）。

### G-4 line-pattern
- vector の層でも未対応＝G-2 の後に、fill-pattern の記号帳（アトラス）を線方向に敷く形で両方まとめて。style 互換の線の側と一緒に設計する。

## 2. 順番と門

| 段 | 中身 | 門 | 逃げ道 |
|---|---|---|---|
| G-1 | 切り分け（core）＝**済** | Node の検定（面積・枠・穴・日付変更線）`tests/geojsonvt.mjs` 12 項 | — |
| G-2 | 手元のタイル＋line-offset を vtdraw へ（**済**・fill-pattern は `?gjvt=2`） | t-mlcompat `pattern-minzoom-and-query`・t-fillpattern・t-linedeco（offset の場面）・公式例 add-a-pattern-to-a-polygon が今と同じ以上・pattern-2d のオーバーレイが作られない | `?gjvt=0` |
| G-3 | line-gradient | 公式例 create-a-gradient-line-using-an-expression・create-a-gradient-dashed-line-using-an-expression・t-linedeco（gradient） | `?gjvt=0` |
| G-4 | line-pattern（vector と geojson） | t-linedeco・公式例の line-pattern の場面 | `?gjvt=0` |

見立て：G-1 1 日・G-2 2〜3 日・G-3 2 日（裁定次第）・G-4 2 日。G-2 だけでも fill-pattern と line-offset の geojson 層は Canvas2D を離れる。

## 3. 期待
- pattern-2d の毎フレームの投影と塗りが消える（大きな面の模様・ずらした線の多い層で CPU が軽くなる）。
- 模様と飾りの層が**層の位置**で描かれ、地形に乗る（今は最前面の手前の canvas）。WebGPU でも同じ絵。
- geojson の層が vector の層と同じ部品に乗る＝style 互換で足した描き方（cap/join・破線・translate・blur）が geojson の飾りの層にも自動で効く。

## 4. 残る Canvas2D（この計画の外）
anno-draw・imagequad-draw（MapLibre の層ではない自前の口・geoedit と描く道具を共有）。`map.gadget.cluster`（cluster-2d）は集約の source と層へ（#572・text gpu plan §4j）、画面格子は WebGL2 の screengrid-gl へ（#573）、CZML・GPX の czml-draw も WebGL2 へ（2026-10-22）。

## 5. 裁定（2026-10-22 Kenji＝3 つとも推奨通り）
1. **対象**：G-2 は pattern の層だけを vtdraw へ（推奨・gint の速さを保つ）か、geojson の層を全部 vtdraw へ（描き方が 1 本になるが、大きな面の stencil の速さを失う）。
2. **line-gradient の進み**：線分レコードに語を足すか（8×u32 の約束を変える）、既存の語 6（距離）と地物ごとの全長の表から割合を出すか（推奨・語を足さない）。統合ロードマップ thread と擦り合わせる。
3. **geojson の maxzoom**：MapLibre の既定 18 に合わせるか（推奨）、層ごとに source の `maxzoom` を読むか（両方＝source に書いてあれば読む）。

## 6. 並走との取り決め
- style 互換（paint 表 (b) 類・線の側）：G-2 は vtdraw-worker の入口と記述子だけを触り、build.ts は触らない。G-3／G-4 は build.ts と線分レコードに触る＝着手前に統合ロードマップ thread と擦り合わせる。
- テキスト GPU 化：geojson の symbol 層は §4g の gjlabels のまま（この計画では動かさない）。
