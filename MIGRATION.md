# 1.x から 2.0 への移行

> Migration guide from 1.x to 2.0, in Japanese. The old → new tables below are code and can be read as they are.

2.0 は、ライブラリを TypeScript に移したのに合わせて、1.x が互換のために残していた別名・古い口・内部への入口を外す大版です。
この文書は **package ごとに「1.x の書き方 → 2.0 の書き方」** を並べます。表に無い API は 1.x と同じです。

## 0. 先に読むこと

### 版

2.0 は 2026-10-17 に npm へ公開しました。その後 `geopbf` 2.1.0（10-19）、`@ortho-earth/globe`・`@ortho-earth/core` 2.1.0（10-23）が出ています。2.1 は 2.0 と同じ API で、2.0 向けのコードはそのまま動きます（下の「2.1 での名前の変更」を除く）。

| package | 1.x の最後 | 2.0 で |
|---|---|---|
| `@ortho-earth/globe` | 1.16.0 | **2.0.0**（この文書の §1） |
| `@ortho-earth/core` | 1.15.0 | **2.0.0**（§3） |
| `geopbf` | 1.19.0 | **2.0.0**（§4） |
| `@ortho-earth/japan` | 1.14.0 | **2.0.0**（§2） |
| `altpbf`・`@ortho-earth/ephem`・`native-bucket`・`geoedit`・`@ortho-earth/h3`・`@ortho-earth/tile-formats`・`glbconv` | 1.1.2・1.2.0・1.0.2・0.3.3・0.1.0・0.1.0・0.1.0 | minor を上げた：1.2.0・1.3.0・1.1.0・0.4.0・0.2.0・0.2.0・0.2.0（口は同じ。出荷の形が TypeScript から作った JS と `.d.ts` になるだけ。tile-formats はリポジトリが先に 0.2.0 になっていた） |
| `@ortho-earth/react`・`google-tiles`・`ktx2`・`plugin-scene`・`plugin-splat` | 未公開 | 0.1.0 で初公開（`plugin-splat` はその後 0.5.0） |
| `quiet-mono` | 1.0.1 | 変更なし（scss だけで、1.0.1 から中身が変わっていない） |

依存の変更：`@ortho-earth/globe` 2.0 は `@ortho-earth/tile-formats`（^0.2.0）に依存します（点群の LAS/COPC の形を読む部分が tile-formats にあるため。LAZ の解読器は今までどおり `#pointcloud-formats` の差し替えで足す物で、既定では束ねられません）。`@ortho-earth/react` は `react-dom`（>=18）を peer に挙げました（`createPortal` を使っているため）。

### 2.1 での名前の変更

`map.gadget.cluster` が MapLibre と同じく cluster の source と層を中で作るようになり、`queryRenderedFeatures` が返す層の名前が `clusters`／`unclustered-point` から `gadget-cluster-clusters`／`gadget-cluster-unclustered` に変わりました。直すのはこの層の名前で問い合わせていたコードだけです。MapLibre の書き方（`cluster: true` の `addSource` と `addLayer`）で作った cluster は、付けた層の名前のままです。

### 1.x を使い続けるには

- npm：`latest` は 2.0 です。1.x は版の範囲で指定します（`npm i geopbf@1`・`npm i @ortho-earth/globe@1`。`@v1` と書いても semver の範囲 `>=1.0.0 <2.0.0` として同じ物が入る）。1.x の最後の版は geopbf 1.19.0・@ortho-earth/globe 1.16.0・@ortho-earth/core 1.15.0・@ortho-earth/japan 1.14.0。dist-tag `v1` は npm が「semver の範囲と同じ名前」として受け付けないので付けていません。
- GitHub：1.x のソースはブランチ `v1` に残してあります。

### 全体に共通の変更

- **`internal/*` は閉じた。公開のサブパスを使う。** 移植の間、globe・core・geopbf はリポジトリの中の検査と道具のために `…/internal/*`（`src/` をそのまま出す口）を開けていましたが、2.0 では閉じます。公開の口は各 package の `package.json` の `exports` に名前で並んでいる物だけです。
- **ソースは TypeScript（`strict`）。** 型は源から作ります。1.x の手書きの `types/*.d.ts` と実体のずれ（型にあって実体に無い名前、その逆）は、実体に合わせて直しました。import の書き方は変わりません。
- **公開の型に出ない物は API ではない。** `@internal` の欄（geopbf の `fmap`・`_name` など）は、出荷する `.d.ts` から消えます。

---

## 1. @ortho-earth/globe

### 1.1 import の口

1.x（npm の 1.16.0）は `"./*": "./src/*"` で `src/` の全ファイルを出していました。2.0 は名前を挙げたサブパスだけを出します。

| 1.x | 2.0 |
|---|---|
| `@ortho-earth/globe/<src の任意のファイル>` | `exports` にある口だけ：`.`・`./maplibre`・`./page.js`・`./wiki.js`・`./i18n.js`・`./i18n/*`・`./themes.js`・`./style-*.js`・`./boot/tier.js`・`./demo/scene-adapter.js`・`./worker.js`・`./renderworker.js`・`./mesh-loaders.js`・`./meshdecode.js`・`./meshq.js`・`./columnar/sources/builtin.js`・`./gadgets/{anno,anno-draw,cloud,compose,dropfile,footprint,searchbox,tellus-api}.js`・`./html-safe.js` |
| `@ortho-earth/globe/internal/*`（リポジトリの中だけ） | 閉じた。上の口を使う |
| `import { mercatorDz } from "@ortho-earth/globe"` | 根からは出さない（MapLibre の口 `@ortho-earth/globe/maplibre` の中の部品） |
| `./*` 経由で読めた内部の名前：`page.js` の `preparePage`、`boot/tier.js` の `FX_NAMES`、`meshq.js` の `prismDebug`・`extractPrisms`、`gadgets/searchbox.js` の `searchProviders`、`gadgets/tellus-api.js` の `bboxPoly`・`pointPoly` | 出さない（ファイルの中だけで使う） |

### 1.2 自作ガジェットの登録

1.x の `map.gadget(name, function () { … })` は、本体の `this` が map でした。2.0 では登録口を 1 つにし、本体は map を**第 1 引数**で受けます（`this` は使いません）。

```js
// 1.x
map.gadget("myGadget", function (opts) { const map = this; /* … */ return handle; });
map.gadget.myGadget({ zoom: [5, 12] });

// 2.0
map.registry.gadgets.add("myGadget", (map, opts) => { /* … */ return handle; });
map.gadget.myGadget({ zoom: [5, 12] });   // 呼び方は同じ（opts.zoom／narrow の表示の門も同じ）
```

| 1.x | 2.0 |
|---|---|
| `map.gadget(name, function () { this … })` | `map.registry.gadgets.add(name, (map, ...args) => handle)` |
| MapLibre の口（`@ortho-earth/globe/maplibre` や `zoomScale: "maplibre"` の顔）で `map.gadget(name, fn)` | 同じく `map.registry.gadgets.add(name, (map, ...args) => handle)`。本体が受ける `map` は**素の map**（エンジンの z）で、plugin の `install(map)` と同じ約束。`map.gadget.<name>()` の戻りは今までどおり顔の側で返る |
| `map.gadget` は関数でもあった | `map.gadget` は名前ごとの呼び口の表だけ（`map.gadget.<name>(…)`）。関数として呼べない |
| plugin の中の `map.registry.gadgets.add(name, function () { this … })`（1.x はここも `map.gadget(name, fn)` に回していたので、本体の `this` が map） | `map.registry.gadgets.add(name, (map, ...args) => handle)`（本体の第 1 引数が map） |

TypeScript で自作ガジェットに型を付けるには `Gadgets` を拡張します：`declare module "@ortho-earth/globe" { interface Gadgets { myGadget(opts?: …): MyHandle } }`。

### 1.3 外した別名

| 1.x | 2.0 | 古い書き方のままだと |
|---|---|---|
| `createGlobe({ plateau })`／`orthoJapan({ plateau })` | `{ mesh }` | 効かない（`mesh` の既定 `true` のまま） |
| `map.on("plateau", cb)` | `map.on("mesh", cb)` | 何も来ない（知らない名前の合図と同じ） |
| 型 `PlateauEvent` | `MeshEvent` | 型エラー |
| `maxPitch`／`setMaxPitch` に 1.6 以下を渡すとラジアンと読んだ | 常に**度**（MapLibre と同じ）。`maxPitch: 1.2` は 1.2° になる | 0.5〜1.6 のラジアンを渡していた所は度に直す。`map.maxPitch()`（ラジアン）と `map.getMaxPitch()`（度）は 1.x と同じ |
| `chips: ["place", "rail"]`（配列で一部だけ出す） | `chips: true | false`。個々の層の固定は `layers: { place: true, road: false, … }` | 警告を 1 回出して、全部のチップを出す |
| `layers` のローマ字キー `chimei`／`chikei`／`shisetsu` | `place`／`terrain`／`facility` | 知らないキーとして警告し、無視する |
| `map.addCOPC(…)`／`map.removeCOPC(…)` | `map.addPointCloud(…)`／`map.removePointCloud(…)` | 関数が無い |
| `map.gadget.plateau()`／`map.gadget.japan()` | `map.gadget.mesh()`／`map.gadget.home()` | 関数が無い |
| 開発用の手 `window.__parquet` | `window.__columnar` | 無い |

### 1.4 日本の地域パック（`@ortho-earth/jp`。`@ortho-earth/japan` と census2020 が載せる物）

| 1.x | 2.0 |
|---|---|
| `map.overlay.loadEstat(…)`・`highlightKey`・`hoverAt`・`isEstatActive`・`setIdentifyHandler` | `map.estat.loadEstat(…)`・`map.estat.highlightKey`・`map.estat.hoverAt`・`map.estat.isEstatActive`・`map.estat.setIdentifyHandler` |

### 1.5 残した物（変更は要らない）

- 型 `OrthoJapanMap`（`GlobeMap` の別名）と `OrthoJapanOptions`（`GlobeOptions` も同じ物）は 2.0 の間は残します。新しく書くなら `GlobeMap`／`GlobeOptions` を使ってください。
- 配った URL・QR を壊さないため、URL の互換は残します：`l=` のローマ字キー、旧 `c`（等高線）トークン、`c=gsi`→topo・`c=night`→dark、`lang=jp`、台本の `jp:`。
- 保存された作図データの `@cap0`／`@cap1`（`@start`／`@end` の旧名）は読み続けます。
- MapLibre 互換の口（`@ortho-earth/globe/maplibre`・旧式フィルタ・`Marker(el, options)` など）は製品の機能で、1.x の互換ではありません。そのままです。

### 1.6 型だけの変更（TypeScript の利用者向け）

- `map.cam`・`map.pinRes` を公開の型に足しました（実体は 1.x からありました）。
- `globe.d.ts` の `GeoPBF` は geopbf の `GeoPBF` と同じ形にしました（地物の `properties` は `null` がありうる、`*File()` は `Promise<File | Blob | null>`、`bbox` は geopbf の `BBox`）。
- 組み込みガジェットの戻りの型を実体に合わせました（`measure`／`profile` など）。

---

## 2. @ortho-earth/japan（SDK）

`orthoJapan(opts)` の戻りの `map` は globe の map です。§1 の変更がそのまま当たります。SDK の利用者が気にする物は次のとおりです。

| 1.x | 2.0 |
|---|---|
| `orthoJapan({ plateau: false })` | `orthoJapan({ mesh: false })` |
| `map.on("plateau", e => …)` | `map.on("mesh", e => …)`（型 `MeshEvent`） |
| `maxPitch` を「ラジアン」として渡していた（1.x の README・llms.txt の記載） | 度で渡す（既定 75°）。README と llms.txt の記載も直した |
| `map.gadget("myGadget", function () { /* this = map */ })` | `map.registry.gadgets.add("myGadget", (map, opts) => handle)` → `map.gadget.myGadget(opts)` |
| `chips: [ … ]` | `chips: true | false`＋`layers` |
| `layers: { chimei: true }` | `layers: { place: true }` |

---

## 3. @ortho-earth/core

| 1.x | 2.0 |
|---|---|
| `@ortho-earth/core/workers/gint`（独立の gint worker） | 無い。gint の層は描画 worker の中で描く（globe の `map.addGint`／`map.applyGintData`） |
| 根の `ORIGIN_KEY` | `@ortho-earth/core/expr` の `ORIGIN_KEY` |
| 根の `wmtsTemplate` | `@ortho-earth/core/raster-src` の `wmtsTemplate` |
| 根の `flyPlan`・`glidePlan`・`glidePathPlan`・`isPMTiles`・`createTileManager`・`mergeTiles`・`decodeQuantizedMesh`・`parseQuantizedMeshLayer`・`vectorLayersOf`・`ML_DEFAULTS`・`featureGeomLL`・`withinGeom`・`distanceGeom` | 出さない（エンジンの中の部品。誰も import していなかった）。カメラの飛行は `createFlight` か globe の `map.flyTo` |
| 根の `buildExtrudedParcels` | 消した |
| `./expr` の `lerpColorLab`・`lerpColorHcl`・`originOfCtx` | 出さない（式の `["interpolate-lab"]`／`["interpolate-hcl"]` は今までどおり評価する） |
| `./depthout` の `DEPTH_EPS`、`./build` の `extendToPole`、`./worldcontent` の `WORLD_GIS`・`loadNames`、`./worldstyle` の `WORLD_THEME_NAMES` | 出さない |
| 型 `DtmSpec`（`./elevation`・1.15 の名前） | `DtmDecl` |
| `@ortho-earth/core/internal/*`（リポジトリの中だけ） | 閉じた。公開のサブパスを使う |

---

## 4. geopbf

| 1.x | 2.0 | 古い書き方のままだと |
|---|---|---|
| `geopbf(x, { noeval: false })`（FUNC 値を `new Function` で関数に戻す） | オプションは無い。FUNC 値は常にソース文字列（CSP の下でも動く・知らないファイルのコードを実行しない） | 無視される（文字列のまま） |
| `pbf.noeval` | 無い | `undefined` |
| `new GeoPBF({ validate: "legacy" })`（1.19 の挙動：`NaN` → 0、`Point` の `[]` → (0,0)） | `"lenient"`（既定）か `"strict"` | `"lenient"` として動く |
| `pbf.closeFilter(f)` | `pbf.cloneMap({ filter: f })` | 関数が無い |
| `GeoPBF.concatinate([a, b])`（1.x でも呼べなかった） | `await a.concat(b, …)`（精度が違えば `null`） | 関数が無い |
| `import { GeoPBF } from "geopbf/pbf-base"`（器のクラス） | `import { GeoPBFBase } from "geopbf/pbf-base"` | import で失敗する（その名前の export が無い） |
| `import { GeoPBF } from "geopbf/core"`（器のクラス） | `import { GeoPBFBase } from "geopbf/core"` | 同上 |
| `import { GeoPBF } from "geopbf"` | 同じ（拡張メソッドつきのクラス）。2.0 では `GeoPBF` は常にこれを指す | — |
| `pbf.fmap.length`・`pbf.fmap?.length` | `pbf.length` | 動くが、型に無い（`@internal`） |
| `pbf.fmap` を回す | `pbf.each((i) => …)`／`pbf.forEach((i) => …)` | 同上 |
| `pbf._name`・`pbf._description` | `pbf.name()`・`pbf.description()` | 同上 |
| その他の `@internal` の欄（`pbf`・`props`・`bufs`・`init` など） | 公開の型には出ない。使わない | 同上 |
| `import { readPosition } from "geopbf/czml"` | 出さない（CZML の読み書きは `geopbf()` と `pbf.czmlFile()`） | import で失敗する |
| `geopbf/internal/convert/mvt-decode` の `decodeTile`（リポジトリの中だけ） | `import { decodeTile } from "geopbf/convert"` | — |
| `geopbf/internal/*`（リポジトリの中だけ） | 閉じた。公開のサブパスを使う | — |

挙動が変わる所（入口の不具合を直した）：

- `geopbf([feature, …])`（Feature の配列）は FeatureCollection として読みます。1.x は空の GeoPBF になっていました。
- 名前の無い `Blob` は GeoPBF のバイト列として読みます（`ArrayBuffer` と同じ）。1.x は空の GeoPBF になっていました。
- `pbf.mesh()`（`{ arc: true }` なし）は落ちなくなりました。

型だけの変更（TypeScript の利用者向け）：`clone()`・`cloneHead()`・`concat()` は `Promise` を返す（実体は 1.x から非同期）。`set()` が受けるのは FeatureCollection・`ArrayBuffer`・`ArrayBufferView` だけ。`classify()` は配列を返す。`ValidateMode` は `"lenient" | "strict"`。

---

## 5. sdk の plugin

| package | 1.x（0.x） | 2.0 |
|---|---|---|
| `@ortho-earth/plugin-scene` | `map.addData(d, { kind: "instanced", mesh: "cone" })` | `{ kind: "instanced", shape: "cone" }` |
| `@ortho-earth/google-tiles`・`ktx2`・`plugin-splat`・`react` | — | 利用者から見た変更は無い（中の型を `GlobeMap` に揃えただけ） |

---

## 6. このリポジトリで開発する人へ

- **アプリ（`apps/*`）は JavaScript のまま**です。2.0 で TypeScript にしたのはライブラリ（`packages/*` と `sdk/*`）だけで、`npm run typecheck` が見るのもそこだけです。
- アプリは package の公開の口だけを読みます（`internal/*` や `../../packages/*/src` の相対 import をしない）。globe の中身の単体テストは `packages/globe/tests` に置きます。
- `apps/world`（npm の `ortho-world`）と `apps/himekuri/lib`（npm の `himekuri`）は 2.0 の版の組に入りません。版は独立のままです。
