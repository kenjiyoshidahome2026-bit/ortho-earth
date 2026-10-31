> [English](Packages) · **日本語**

# パッケージ

2026-10-31 時点の版（`main` の各 `package.json` より）。「private」は npm に出していない物です。

## エンジンと共有部品（`packages/*`）

| パッケージ | 版 | ライセンス | 内容 |
|---|---|---|---|
| `@ortho-earth/core` | 2.2.0 | GPL-3.0-or-later | 球面のベクタタイル描画・カメラ・投影・Gint・overlay 契約 |
| `@ortho-earth/globe` | 2.2.0 | GPL-3.0-or-later | 3D 地球儀：`createGlobe()`、MapLibre 形の API、プラグイン、データ層、解析 |
| `@ortho-earth/tile-formats` | 0.2.0 | GPL-3.0-or-later | 必要な時だけ読む復号器：MLT タイル、COPC の LAZ |
| `@ortho-earth/h3` | 0.2.0 | GPL-3.0-or-later | H3 のセル、集計、`map.addH3()` |
| `@ortho-earth/ephem` | 1.3.0 | GPL-3.0-or-later | 太陽系の暦、共通の時計、SGP4/SDP4 の人工衛星 |
| `geopbf` | 2.1.0 | MIT | GeoPBF の容器と Gint の位相。ブラウザで 18 形式を読み 14 形式に書く |
| `geoedit` | 0.4.0 | MIT | 球面上の位相つき GeoPBF エディタ（地図のガジェット） |
| `altpbf` | 1.2.0 | MIT | 標高タイルのバイナリ形式。そのまま `Int16Array` に復号 |
| `native-bucket` | 1.1.0 | MIT | Cloudflare R2 ⇄ ブラウザの IndexedDB の橋 |
| `quiet-mono` | 1.0.1 | GPL-3.0-or-later | アプリ共通の意匠キット（トークンと UI 部品） |
| `@ortho-earth/jp` | 0.0.1（private） | GPL-3.0-or-later | 日本の地域パック |
| `@ortho-earth/nl` | 0.0.1（private） | GPL-3.0-or-later | オランダの地域パック |
| `@ortho-earth/regions` | 0.0.1（private） | GPL-3.0-or-later | 地域の切り替え口（`orthoJapan`） |
| `@ortho-earth/equal` | 0.0.1（private） | GPL-3.0-or-later | Equal Earth の世界地図の部品（`createEqual`） |
| `common` | 1.0.0（private） | MIT | 小さな共通の道具 |
| `world-data` | 2.0.0（private） | CC BY-SA 4.0（データ） | 国と地域 262、地形 約 900、天体の名前、26 言語 |

## SDK と道具（`sdk/*`）

| パッケージ | 版 | ライセンス | 内容 |
|---|---|---|---|
| `@ortho-earth/japan` | 2.0.2 | GPL-3.0-or-later | どの頁にも置ける自己完結の日本の地球儀（エンジン＋日本パック） |
| `@ortho-earth/cesium` | 0.1.0 | GPL-3.0-or-later | ortho-earth の上の CesiumJS API：`import * as Cesium from "@ortho-earth/cesium"` |
| `@ortho-earth/react` | 0.1.0 | GPL-3.0-or-later | React の部品：`<Globe>`・`<Source>`・`<Layer>`・`useGlobe` など |
| `@ortho-earth/gmaps` | 0.2.0 | GPL-3.0-or-later | MapLibre／地球儀の上の `google.maps` 名前空間 |
| `@ortho-earth/leaflet` | 0.1.0 | GPL-3.0-or-later | MapLibre／地球儀の上の Leaflet の `L` 名前空間 |
| `@ortho-earth/google3d` | 0.2.0 | GPL-3.0-or-later | Google Photorealistic 3D Tiles（鍵・セッション・帰属表示） |
| `@ortho-earth/ktx2` | 0.1.0 | GPL-3.0-or-later | KTX2 / Basis Universal のトランスコーダ |
| `@ortho-earth/scene` | 0.2.0 | GPL-3.0-or-later | インスタンス化メッシュ・ビルボード・3D 文字（`map.addData` の種類） |
| `@ortho-earth/splat` | 0.6.0 | GPL-3.0-or-later | ガウシアンスプラット（`.ply`・`.splat`・`.spz`・`.ksplat`・`.sog`・3D Tiles） |
| `@ortho-earth/voxel` | 0.6.0 | GPL-3.0-or-later | ボクセル：ボリューム・ブロック・等値面 |
| `glbconv` | 0.2.0 | MIT | GLB を他の 3D 形式へ（ブラウザと Node） |

## 1 つのアプリが持つパッケージ

| パッケージ | 版 | ライセンス | 置き場 |
|---|---|---|---|
| `himekuri` | 2.0.0 | MIT | `apps/himekuri/lib`（日めくりと世界時計の SVG 部品） |
| `ortho-world` | 1.0.0 | MIT | `apps/world`（`<div>` に置ける国の選択部品） |

## ミラー

`geopbf`・`altpbf`・`geoedit`・`native-bucket`・`ortho-world`・`himekuri` はリリースのたびに単独の読み取り専用リポジトリにも写されます（workflow `mirror`）。

## 版の引き上げ

2.0 で 1.x の別名と内部の道を外しました。変更点の一覧（旧 → 新）は [MIGRATION.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/MIGRATION.md) にあります。
