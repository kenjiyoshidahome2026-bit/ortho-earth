# 層の線引き — core は硬く、アプリは柔らかく（2026-09-23 裁定）

このモノレポの部品は四つの層に分かれる。**上ほど硬く（関門・型・版で守る）、下ほど柔らかい（殻＝自由に変えてよい）**。
新しい機能は「どの層か」を先に言ってから書く。

| 層 | 硬さ | 置き場 | 中身 |
|---|---|---|---|
| core | 硬い | `packages/ortho-core`（`@ortho-earth/core`） | 描画・カメラ・投影・gint・overlay 契約。地域を知らない |
| globe | 硬い | 今は `apps/ortho-japan/app.js` の `createGlobe`（→ 段階 2 で `packages/globe`） | 地球儀のホスト＝起動・世界層（ハイプソ／admin0／湖／河川／海洋境界／星）・地域非依存ガジェット（spotlight／outline／symbols／anno／extrude／heatmap／cluster／model／raster／measure／shot／palette…）・SDK の型（d.ts）・i18n は英語基底・関門 |
| region パック | 硬め（データ） | `packages/jp`（`@ortho-earth/jp`）＋日本だけの部品 | 地域の申告（dtm／buildings／basemap／rasters／attribution／view／home／search／poi／rail）と、日本だけの部品（mesh＝PLATEAU・POI・地理院検索・N02・airports・e-Stat＝`map.estat`・jp/codes・層チップ） |
| apps | 柔らかい | `apps/*` | 殻。`japan`＝globe＋jp パック＋日本 UI。`world`／`equal`／`census2020`／`solar`… |

## z の線（本人 2026-09-23）

- **globe は基本 z<8**＝世界データ（Natural Earth 10m・全球ハイプソ・湖・河川・海洋境界）が持つ所まで。これが地球儀の実力であり天井。
- **そこから先は地域パックの拡張**＝japan なら z≥6.5 から地理院ベクタ基図・DEM10B・PLATEAU・POI・地理院検索が入る（入場点は地域の申告 `basemap.tileMinZoom`／`BASEMAP_MINZOOM` が持つ）。両方ある帯（6.5〜8）は地域が勝つ＝世界の色は基図の入場点で退場する。
- ゆえに **japan＝globe＋拡張（z≥6.5）＋日本 UI**。world のような世界のアプリは globe だけを使い、`zoomMax: 8` で天井を明示する。

## 掟

1. **globe と core に地域名を書かない**（JP・日本・地理院・GSI を core/globe のコードに置かない）。地域は宣言（`opts.region`）とパックで足す。
2. **消費者は公開面（`sdk/ortho-japan.d.ts`）だけを使う**。`map.estat` のような地域の口は japan の拡張面であって globe の口ではない。`dbgHost`／`__*` はアプリから触らない。
3. **内製アプリはエンジンを自分の束に焼く**（本番だけ `/japan/lib/` を実行時に食う二重構成はしない）。japan を出さなくても各アプリが自分の deploy で進み、japan を出しても他が変わらない。
4. **core／globe の変更は関門＋d.ts＋版**（verify:webgpu／verify:ui／型の更新／SDK の版上げ）。apps は自由＝各アプリの verify:prod だけ。
5. 地球儀が要るアプリは `createGlobe(opts)` を使う（`orthoJapan()` は「globe＋日本の申告」の薄い包み）。

## 段階（可逆）

- **1（済 2026-09-23）** 文書で線を引く。`createGlobe` を export（region 省略＝地球儀）。world はそれを使う。中身は動かさない。
- **2（進行中）** 「動作を変えない移動」を刻む：
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
- **3** equal の palette／labels を globe の worldpal／labels と一本化（world の色定数の手写しを無くす）。

## 今の「混ざり」の目録（段階 2 の作業表）

（S4 前の記録）`apps/ortho-japan/app.js`（約 3,000 行）に同居していたもの：`REGION_*`／`REGIONLESS` 41 箇所、e-Stat／N02／GSI／地理院 43 箇所、`JAPAN_VIEW`、airports.json、`gadget("japan")`（列島へ戻る）、`gadget("mesh")`（PLATEAU）、`gadget("search")`（地理院）、`gadget("poiedit")`（overlay.js の e-Stat 部は S3 で jp 側へ移設済）。
`gint/layers.js` には世界層（admin0／世界の線）とユーザー層と e-Stat 系が同居。
