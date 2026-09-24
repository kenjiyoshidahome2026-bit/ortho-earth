# 層の線引き — core は硬く、アプリは柔らかく（2026-09-23 裁定）

このモノレポの部品は四つの層に分かれる。**上ほど硬く（関門・型・版で守る）、下ほど柔らかい（殻＝自由に変えてよい）**。
新しい機能は「どの層か」を先に言ってから書く。

| 層 | 硬さ | 置き場 | 中身 |
|---|---|---|---|
| core | 硬い | `packages/ortho-core`（`@ortho-earth/core`） | 描画・カメラ・投影・gint・overlay 契約。地域を知らない |
| globe | 硬い | `packages/globe`（`@ortho-earth/globe`） | 地球儀のホスト＝起動・世界層（ハイプソ／admin0／湖／河川／海洋境界／星）・地域非依存ガジェット（spotlight／outline／symbols／anno／extrude／heatmap／cluster／model／raster／measure／shot／palette…）・SDK の型（d.ts）・i18n は英語基底・関門 |
| region パック | 硬め（データ） | `packages/jp`（`@ortho-earth/jp`）＋日本だけの部品 | 地域の申告（dtm／buildings／basemap／rasters／attribution／view／home／search／poi／rail）と、日本だけの部品（mesh＝PLATEAU・POI・地理院検索・N02・airports・e-Stat＝`map.estat`・jp/codes・層チップ） |
| apps | 柔らかい | `apps/*` | 殻。`japan`＝globe＋jp パック＋日本 UI。`world`／`equal`／`census2020`／`solar`… |

## z の線（本人 2026-09-23）

- **globe は基本 z<8**＝世界データ（Natural Earth 10m・全球ハイプソ・湖・河川・海洋境界）が持つ所まで。これが地球儀の実力であり天井。
- **そこから先は地域パックの拡張**＝japan なら z≥6.5 から地理院ベクタ基図・DEM10B・PLATEAU・POI・地理院検索が入る（入場点は地域の申告 `basemap.tileMinZoom`／`BASEMAP_MINZOOM` が持つ）。両方ある帯（6.5〜8）は地域が勝つ＝世界の色は基図の入場点で退場する。
- ゆえに **japan＝globe＋拡張（z≥6.5）＋日本 UI**。world のような世界のアプリは globe だけを使い、`zoomMax: 8` で天井を明示する。

## 掟

1. **globe と core に地域名を書かない**（JP・日本・地理院・GSI を core/globe のコードに置かない）。地域は宣言（`opts.region`）とパックで足す。
   **機械の門（2026-09-24）**：`packages/globe` の `verify:regionless`＝コードと文字列（コメントは除く）の地域の語をファイルごとに数える爪車。
   許可表 `packages/globe/scripts/regionless-allow.json`（凍結・互換・負債の別と理由つき）を超えたら落ち、減ったら `--ratchet` で枠を下げる（上げない）。globe の `verify` と japan の deploy の頭で回る。
2. **消費者は公開面（`sdk/ortho-japan.d.ts`）だけを使う**。`map.estat` のような地域の口は japan の拡張面であって globe の口ではない。`dbgHost`／`__*` はアプリから触らない。
3. **内製アプリはエンジンを自分の束に焼く**（本番だけ `/japan/lib/` を実行時に食う二重構成はしない）。japan を出さなくても各アプリが自分の deploy で進み、japan を出しても他が変わらない。
4. **core／globe の変更は関門＋d.ts＋版**（verify:webgpu／verify:ui／型の更新／SDK の版上げ）。apps は自由＝各アプリの verify:prod だけ。
5. 地球儀が要るアプリは `createGlobe(opts)` を使う（`orthoJapan()` は「globe＋日本の申告」の薄い包み）。

## mesh（3D メッシュ）の線引き — 2026-09-23

`packages/globe/src/mesh*` は **PLATEAU の実装ではない**。b3dm/Draco→ECEF→ortho 球→重複面 dedup→接地→LOD→RTE→被覆マスクの
「大量の 3D メッシュを流す核」であり、現時点で**消費者は 4 つ**：

| 消費者 | 入口 | 地域の持ち物 |
|---|---|---|
| PLATEAU（日本） | `meshworker` の区ロード | `packages/jp/src/region.js` の `buildings`（catalog／exclude／landmarks／bakeBase／group／icon） |
| 3DBAG（オランダ） | 同上（同じ関数） | `apps/ortho-japan/nl/region.js` の `buildings.sets`（base／bbox／tilesetUrl／clip） |
| 任意の 3D Tiles（#41） | `tiles3d-decode.js` → `decodeModel` | — |
| I3S（#48）／glb 模型 | `i3s-decode.js` → `finishMesh` | — |

**掟**：核は地域を知らない。地域が持つのは*データの在り処*だけ（上の表の右列）。
`meshq.js` の地域痕跡は 0 件、他も残るのは名前だけ＝**凍結**する：IDB 名 `GIS/plateau`（利用者の端末に残る）・
DOM id `plateau-toast`（利用者 CSS が当てる公開面）・台本の `plateau:` キー（共有 URL に残る）。改名しない。

**依存の向き**：jp／nl は核を *参照しない*。両者は宣言を渡すだけで、核を使うのはホスト（globe）。
「jp と nl が参照する共有ライブラリ」ではなく「globe が依存する 3D メッシュ核」＝切り出すなら `@ortho-earth/mesh`（`mesh`
であって `plateau` ではない）。切る線は**純関数だけ**（meshdecode／meshq／decoder／tiles3d-decode／i3s-decode ≈ 1,600 行）＝
worker 入口・IDB/OPFS・予算とヒステリシスは地球儀のロード政策なので globe に残す（worker 入口 1 本の掟・パッケージ跨ぎの
`new Worker(new URL())` は vite の静的検出を壊す）。**時期＝公開の版を切る時**（本人裁定 2026-09-23：まず B＝申告と文書だけ）。

**2026-09-23 に直した一点（B）**：R2 焼きの置き場が worker に直書き（`BAKE_URL_DEFAULT`＝日本のバケツ）で、
`clip`／`tilesetUrl` が無い区を「PLATEAU らしい」と推量して引いていた＝エンジンが一国のデータを既定に抱えていた。
いまは `buildings.bakeBase` の申告＝globe が台帳の各 set に刻み、load メッセージで worker へ渡す。
宣言しない地域は焼きを引かない（生経路のみ）。`?bake=URL` は全区に効く上書き（宣言より優先）・`?nobake=1` は封印。

## 段階（可逆）

- **1（済 2026-09-23）** 文書で線を引く。`createGlobe` を export（region 省略＝地球儀）。world はそれを使う。中身は動かさない。
- **2（済 2026-09-23）** 「動作を変えない移動」を刻む：
  - S1 済：地域の選び方（URL→JP/NL）をホストから包み `orthoJapan` へ。ホスト `createGlobe` は `opts.region` しか見ない・既定の視点は世界
  - S2 済：airports.json＝地域の申告（`JP_REGION.airports`）
  - S3 済：e-Stat（overlay.js の estat 部）を jp 側へ（`packages/jp/src/estat.js`・`estat-worker.js`・`install.js`）。overlay.js は地球儀の臓器（identify／mask／hover 輪郭／`use(ext)`）だけ。ホストは**拡張面** `hostEnv`＝`{ opts, renderer, cam, size, dpr, requestDraw, overlay, spawnWorker, ownTip, hooks.hover[], t, dbg, onDestroy }` を出し、地域宣言の `install(map, hostEnv)` が `map.estat` を生やす（`map.overlay` への同名 alias は census2020 互換）。轍：install の dynamic import は verify:ui（仮想時間）で解決しない＝region.js から静的 import
  - S3b 済：残っていた地域の露出を申告へ。`gadget("home")`（顔・札・DOM id は `home` 宣言＝日本は列島ブロック図・"Show all of Japan"・#japan-btn／`japan` は非推奨の別名）・`extTipOwn`（拡張が tip を握る合図の一般名・旧 estatTipOwn）・`__tokyo` は jp の install が生やす
  - S3c 済：app.js を二分＝`globe.js`（ホスト＝createGlobe・地域の import ゼロ）と `app.js`（包み＝orthoJapan・URL で JP/NL を選ぶ・SDK の公開面は据え置き）。S4 は globe.js 一式の git mv だけになる
  - S3d 済（①〜③′）：①POI 台帳の実装は `poi.create(env)`（宣言が動的 import を握る＝ホストは @ortho-earth/jp/poi を知らない） ②出典の圏名 "jp"→"region"（attrRegionHTML） ③′建物データ管理モーダルの並び/見出し（都道府県）は `buildings.group(set)`＝meshdb.js は地域を知らない（門＝t-mesh dbGroups）
  - S3d ④ 済：worker の入口は 1 本のまま（複製を断つ設計は据え置き）、地域の役は `worker-roles-extra.js`（今は estat）へ。S4 では globe 側の既定を `{}` にし、japan／census2020 の vite が その相対 import を @ortho-earth/jp の役表へ alias で差し替える（部品の builtinWorkers を「作らない版」へ差し替えるのと同じ作法）。ホストの各 spawn（render/mesh/gintbake/parquet/model/imagequad/rastertiles）は静的な `new Worker(new URL("./worker.js"))` のまま＝vite の静的検出を壊さない
  - S3d ③ 残（裁定待ち）：basemap の語彙＝themes.js（bvmap の vt_code 分類・CHOME/RAILTR の z 閾・layerState の鍵）・style-mono/dark/sepia/gsi.js（bvmap の層→描画規則）・mergeChome（丁目の畳み）・chips（層の切替 UI）。案 a＝`basemap` 宣言が語彙・テーマ・ラベル規則を持参し、globe は「層の鍵の集合」と「切替の口」だけを持つ／案 b＝themes/style/chips は japan の殻（UI）に残し、globe は基図なしの地球儀＝world 帯とガジェットだけ（basemap 圏の UI は地域側の責務）
  - S4 済（2026-09-23・案 b＝本人裁定「themes/style/chips は当面 globe が抱える」）：ホストの閉包 132 ファイル（globe.js・gadgets 62・gint・sky・scenes・boot・mesh・demo/scene-adapter・i18n.js＋本体の訳 i18n/ui.json＋lang/<code>.json・style.scss・themes/style-*/palettes・worker 一式）を `packages/globe/src` へ git mv（相対構造そのまま）。`@ortho-earth/globe`＝exports "."（createGlobe）＋"./*"。japan の殻に残る物＝app.js（包み）・index.html/site.js・頁（quakes/sats/tellus/models/scene/geoedit）・demo（editor/scenes）・nl・i18n/pages（頁の辞書）・public・scripts・tests・sdk
    - worker の入口は globe の worker.js 1 本。地域の役は `#extra-roles`（package.json imports・既定 {}）を japan／census2020 の vite alias が `@ortho-earth/jp/worker-roles`（estat）へ差し替える
    - ortho-core の公開面に `./workers/gintbake` を追加（gintbakeworker.js が相対で内部を掴んでいた）
    - i18n の道具：本体の走査は APP＋HOST（rel は "globe/…"・contexts/pages の鍵も同表記）・正本 ui.json／焼き先 lang／langs.js は HOST・頁の辞書は APP
    - 掟の現状：globe に残る bvmap の語彙（themes.js・style-gsi.js・mergeChome・chips）＝案 b で受け入れた負債。第二の基図が来た時に `basemap` 宣言へ
  - S5 済：関門の頁集合を二分（verify-ui.mjs／verify-webgpu.mjs の `JP_PAGES`＝japan に依る頁・`--globe`／`--japan` で選ぶ）。`npm run verify:globe`（UI 19＋WebGPU 17）／`verify:japan`。packages/globe の `npm run verify` は japan の殻で globe の集合を走らせる委譲（globe は殻＝HTML/検定頁を持たない）
  - S6 済：**世界のアプリは globe 側**（本人 2026-09-23）＝sats／quakes は `createGlobe({ zoomMax: 8 })`（申告なし・z<8）・GeoPBF デモは `createGlobe`（落とした地物を寄って見るので z の上限は既定）。**tellus は japan 側**（本人 9/23「tellus は japan かも」＝東京へ寄って見る画像の頁）。models（PLATEAU LOD3）／scene／census2020／gishub-jp は japan 側。equal は段階 3 で色・ラベルを一本化
- **3 済（2026-09-23）** 世界の地図面の配色＝`packages/ortho-core/src/worldstyle.js`（`WORLD_STYLE_THEMES`＝旧 equal themes.js の表を正本に引き上げ＋`capital`・`css()`／`hex()`／`normWorldTheme`）。equal の themes.js は同じ名前で再輸出（表は持たない）・首都の点は正本の capital（world の国の地図と同じ赤）。world の worldlayers.js の色定数は正本から導出（手写し廃止）。globe は世界線（河川・海洋境界線）の色とテーマ列の名札/スウォッチを正本から引き、テーマ切替で世界線を塗り直す（gint.repaintWorldLines）。i18n の生存判定は ortho-core/src も文字列の根に含める（"Blank map" 等）。全球ハイプソは従来どおり worldpal.js

## 段階 4（2026-09-24）＝門の住所：globe の門は globe が持つ

**なぜ**：9/24 まで「globe の関門」は apps/ortho-japan（日本の殻）に住み、`packages/globe` の `verify` はそこへ
委譲していた＝**一番硬い層の検定を、一番柔らかい層が宿していた**。エンジンを単体で名乗る（版を切る）なら、
自分の門を自分で持てなければ筋が通らない。

- **器**：`packages/globe/vite.config.js`（COOP/COEP を middleware で全リクエストに刻む・`worker.format="es"`・
  builtinWorkers は「作らない版」へ）。`#extra-roles` は**差し替えない**＝globe 既定の `{}` のまま＝地域を知らない器であることの実地確認。
- **頁**：`packages/globe/tests/*.html`（25 枚＋`t-nocoi`）。どれも**公開面 `@ortho-earth/globe` の `createGlobe`** で起動する
  （旧＝`../app.js` 経由＝日本の包みを通っていた）。`orthoJapan` で起動していた 6 枚（t-backfill／t-anchorfill／t-rectlook／
  t-qr／t-spotlight／t-anno）は、視点が z<6.5 の世界＝地域が効かない頁だったので `createGlobe` に直した。
- **仕掛け**：`packages/globe/scripts/lib/ui-runner.mjs`（仮想時間／実時間・頁ごとに Chrome・ドラッグ駆動・実 GPU の旗）を
  **japan と共有**＝走らせ方の複製を作らない。`packages/globe/scripts/verify-{ui,webgpu,nocoi}.mjs` が頁の一覧を持つ。
- **japan に残る頁＝「日本を試料に使う検定」**（間借りではない・地域パックの検定）：①地域の機能そのもの
  （t-gadgets／t-newgadgets／t-providers／t-raster／t-demo／t-scene／t-mesh／t-meshfs／t-bld／t-baselane）
  ②globe の機能だが**見るものが要る**頁＝z≥6.5 の東京で基図・注記・印刷・計測・RTL・面の焼き・押し出しを画素で見る
  （t-print／t-shot／t-measure／t-profile／t-palette-live／t-input／t-narrow／t-rtl／t-model／t-opts／t-gndfaces／
  t-zoomfill／t-aatrans／t-gintlayers／t-extrude-drape／t-webgpu）。日本の基図が無いと画面に何も無い＝地域パックがあって初めて成立する。
- **委譲の向きが反転**：japan の `verify:globe` は `npm --prefix ../../packages/globe run verify`／`verify:nocoi` も globe へ。
  deploy の速い関門は二手（japan＝t-import・globe＝t-backfill/t-rectlook 2 変種）を**並行**で回す。
- 数：globe＝UI 17＋WebGPU 9（＋nocoi 5）／japan＝UI 18＋WebGPU 14＋editor 3。
- ortho-core に `./workers/gint` を追加（検定の worker 入口が相対で内部を掴んでいた）。

## 依存の向きと入口（2026-09-24 実測）

- **向き**：japan → globe → core → ephem／japan → jp → core。**globe と jp は互いを import しない**（出会うのは japan が渡す申告 `opts.region` と、ビルド時に worker の空き枠 `#extra-roles` を jp の役表へ差し替える所だけ）。
  モノレポ全体をパッケージ単位で機械検査して**出荷物に循環なし**（輪は scripts・tests が他アプリのデータを読む所だけ）。
- **入口**：地域なしの地球儀は `@ortho-earth/globe` から直に取る＝ortho-globe（下の「globe の家」）・world（国の地図パネル）・GeoPBF デモ（9/24 に japan の殻経由から直へ＝束から日本／NL の申告が消えた）・equal（ガジェットと i18n だけ）。
  日本／NL の申告が要るアプリは japan の殻（`apps/ortho-japan/app.js`＝`orthoJapan`）＝census2020・gishub-jp・ortho-nl。
- **誰が何を持つか**：
  - 世界帯の中身（国・州・都市・道路・鉄道とその名前）＝規則は core の `worldcontent.js`・データは bucket `GIS/world/`＝equal／globe／world が同じ URL・同じキャッシュ名で引く（japan は通らない）。
  - 楕円体（`?ell=1`）＝ノブは core の `camera.js`（setEllipsoid）・**決めるのは globe.js の 1 行（URL だけ・opts には無い）**・各 worker へは globe が init で運ぶ。既定は全端末で球（2026-08-19 裁定）。
  - UI の訳の道具（走査器・頁の辞書・表の焼き＝`i18n-scan`／`i18n-pages`／`i18n-tables`）＝globe の `scripts/lib`（本体の訳の持ち主）。japan と ortho-globe が共有する。地域パックの文字列の在り処（japan なら `packages/jp/src`）は殻が `i18n/pages.json` の `literalRoots` で申告する。
- **globe の家（2026-09-24・本人裁定「B」「/globe/」）**：地域の申告を持たない頁は `apps/ortho-globe`（`www.ortho-earth.com/globe/`・自前の Worker）に住む＝
  `/globe/`（Globe ⇄ Equal Earth の往復）・`/globe/quakes`（世界の地震）・`/globe/sats`（人工衛星）。各頁は `@ortho-earth/globe` を自分の束に焼く（japan の SDK も app.js も読まない）。
  旧 `/japan/earth`・`/japan/quakes`・`/japan/sats` は japan の Worker が 301 で送る（query は運ぶ）。頁の辞書（quakes／sats）と OG 画像も一緒に移した。
  この家の頁は `persistView: false`（同じオリジンの /japan/ が残した「前回の視点」を読まない・書かない）。
- **残る結び目**：
  1. **実行時アセットの持ち主**：地域なしの消費者（ortho-globe・world・GeoPBF デモ）は globe の家（`/globe/`）から読む（`__GLOBE_ASSETS__`）。ただし `koppen-clim.png` は japan の public にも同じ物が残る（japan の頁と SDK 用）＝本当の持ち主は `packages/globe`（npm の globe にも載せ、両方の家はそこから焼く）＝globe の版を切る時に。
  2. **globe に残る地域の語**＝許可表（2026-09-24 夜に 112 → 54 語）。9/24 に消した負債＝鉄道層の口 `n02` → `rail`（core の GL/GPU renderer・globe・jp の口）／
     法務省地図の開発用の手（`__moj`・`__sapporo`・`__arakawaFit`）→ jp の `moj-dbg.js`／スクショと印刷の出典の日本固定 → 宣言（`attribution`・`basemap.printAttribution`）と圏から／
     建物 UI の「(PLATEAU)」→ 宣言 `buildings.labels`（無ければ汎用の文言・オランダは 3DBAG なのに PLATEAU と出ていた）。
     残る負債＝ログと計器の表示名の「PLATEAU」（globe.js・mesh/manager.js・meshdecode.js・renderworker.js）。
     凍結（利用者の端末・共有 URL に残る名）＝`ortho-japan.cam256`・`ortho-japan-edit`・`GIS/plateau`・OPFS `plateau`・`#plateau-btn`・`plateau-toast`。
     互換・形式・案 b＝`opts.plateau` 等の旧名・`gadget("japan")`・`encoding:"gsi"`・`c=gsi`・基図の語彙（style-gsi／style-mono）。

## 今の「混ざり」の目録（段階 2 の作業表）

（S4 前の記録）`apps/ortho-japan/app.js`（約 3,000 行）に同居していたもの：`REGION_*`／`REGIONLESS` 41 箇所、e-Stat／N02／GSI／地理院 43 箇所、`JAPAN_VIEW`、airports.json、`gadget("japan")`（列島へ戻る）、`gadget("mesh")`（PLATEAU）、`gadget("search")`（地理院）、`gadget("poiedit")`（overlay.js の e-Stat 部は S3 で jp 側へ移設済）。
`gint/layers.js` には世界層（admin0／世界の線）とユーザー層と e-Stat 系が同居。
