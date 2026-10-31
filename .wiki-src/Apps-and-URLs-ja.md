> [English](Apps-and-URLs) · **日本語**

# アプリと URL

`apps/*` の頁はどれもパッケージの上に載る殻です。URL はすべて `https://www.ortho-earth.com` の下です。

## `/globe/` のホスト（`apps/globe-host`・Worker `ortho-globe`）が配る頁

| URL | アプリ | 内容 |
|---|---|---|
| [/globe/](https://www.ortho-earth.com/globe/) | `apps/globe-map` | 世界の地球儀（地球儀 ⇄ Equal Earth） |
| [/globe/arcs](https://www.ortho-earth.com/globe/arcs) | `apps/arcs` | 各国の首都への大円と世界の航空路 |
| [/globe/clock](https://www.ortho-earth.com/globe/clock) | `apps/clock` | 世界時計：地球儀の上のタイムゾーン |
| [/globe/clouds](https://www.ortho-earth.com/globe/clouds) | `apps/clouds` | 今の雲：静止衛星の赤外画像 |
| [/globe/hex](https://www.ortho-earth.com/globe/hex) | `apps/hex` | 世界の人口を H3 の六角柱で |
| [/globe/parks](https://www.ortho-earth.com/globe/parks) | `apps/parks-us` | アメリカの国立公園 63 か所 |
| [/globe/physical](https://www.ortho-earth.com/globe/physical) | `apps/physical` | 世界の地形 |
| [/globe/sats](https://www.ortho-earth.com/globe/sats) | `apps/sats` | 稼働中の全人工衛星と軌道 |
| [/globe/splat](https://www.ortho-earth.com/globe/splat) | `apps/splat` | 地球儀の上のガウシアンスプラット |
| [/globe/voxel](https://www.ortho-earth.com/globe/voxel) | `apps/voxel` | ボクセル：雲、ブロックの富士山、地震の密度 |

## `/japan/` のホスト（`apps/japan-host`・Worker `ortho-japan`）が配る頁

| URL | アプリ | 内容 |
|---|---|---|
| [/japan/](https://www.ortho-earth.com/japan/) | `apps/japan-map` | 看板の日本の 3D 地図（地理院・PLATEAU・JAXA の公開データだけ） |
| [/japan/terrain](https://www.ortho-earth.com/japan/terrain) | `apps/terrain` | 日本の地形 約 1,500 |
| [/japan/parks](https://www.ortho-earth.com/japan/parks) | `apps/parks` | 日本の国立公園 35 か所 |
| [/japan/models](https://www.ortho-earth.com/japan/models) | `apps/models` | 名所の 3D モデル |
| [/japan/onsen](https://www.ortho-earth.com/japan/onsen) | `apps/onsen` | 温泉 約 5,300 |
| [/japan/fireworks](https://www.ortho-earth.com/japan/fireworks) | `apps/fireworks` | 3D の街に上がる花火 |
| [/japan/pointcloud](https://www.ortho-earth.com/japan/pointcloud) | `apps/pointcloud` | 静岡と熱海の点群（COPC） |
| [/japan/scene](https://www.ortho-earth.com/japan/scene) | `apps/scene` | scenes エディタ：カメラの台本を書いて MP4 に |
| [/japan/tellus](https://www.ortho-earth.com/japan/tellus) | `apps/tellus` | Tellus の衛星データ（PALSAR-2・AVNIR-2・GCOM） |
| [/japan/geoedit](https://www.ortho-earth.com/japan/geoedit) | `apps/geoedit-app` | 位相つき GeoPBF エディタ |

## 自前の Worker を持つアプリ

| URL | アプリ（Worker） | 内容 |
|---|---|---|
| [/globe/engine/](https://www.ortho-earth.com/globe/engine/current.json) | `apps/engine`（`ortho-engine`） | 共有エンジン。[構成](Architecture-ja) を参照 |
| [/globe/quakes/](https://www.ortho-earth.com/globe/quakes/) | `apps/quakes`（`ortho-quakes`） | 1967 年からの世界の地震を本当の深さで |
| [/japan/census2020/](https://www.ortho-earth.com/japan/census2020/) | `apps/census2020` | 2020 年国勢調査の小地域統計と災害区域 |
| [/yokohama/](https://www.ortho-earth.com/yokohama/) | `apps/yokohama`（`ortho-yokohama`） | 市民ファーストの横浜市デジタルツイン |
| [/equal/](https://www.ortho-earth.com/equal/) | `apps/equal`（`ortho-equal`） | Equal Earth の世界地図 |
| [/world/](https://www.ortho-earth.com/world/) | `apps/world`（`world`） | 世界の国と地域のカード |
| [/quiz/](https://www.ortho-earth.com/quiz/) | `apps/quiz`（`ortho-world-quiz`） | 世界の地理クイズ |
| [/solar/](https://www.ortho-earth.com/solar/) | `apps/solar`（`ortho-solar`） | 惑星と衛星の動き |
| [/himekuri/](https://www.ortho-earth.com/himekuri/) | `apps/himekuri`（`ortho-himekuri`） | 日の出・日の入り・月の出入りつき日めくり |
| [/nl/](https://www.ortho-earth.com/nl/) | `apps/ortho-nl`（`ortho-nl`） | オランダの 3D |
| /choju/ | `apps/choju`（`ortho-choju`） | 鳥獣の捕獲記録を 3D 地図に（トップには載せない頁） |
| /sokutei/ | `apps/sokutei`（`ortho-sokutei`） | 写真から捕獲鳥獣の体長を測る PWA（同上） |

## サイトに組み込まれる頁（`apps/www`・Cloudflare Pages）

| URL | アプリ | 内容 |
|---|---|---|
| [/](https://www.ortho-earth.com/) | `apps/www` | トップ頁とデモのカード |
| [/maplibre/](https://www.ortho-earth.com/maplibre/) | `apps/www` | MapLibre の例の一覧と一致の点数 |
| [/sandcastle/](https://www.ortho-earth.com/sandcastle/) | `apps/www` | `@ortho-earth/cesium` で動く Cesium Sandcastle |
| [/docs/](https://www.ortho-earth.com/docs/) | `apps/docs` | 手引き（MapLibre から・Cesium から・Equal Earth…） |
| [/geopbf/](https://www.ortho-earth.com/geopbf/) | `apps/geopbf-demo` | GIS ファイルをブラウザで変換 |
| [/gishub-jp/](https://www.ortho-earth.com/gishub-jp/) | `apps/gishub-jp` | 日本のオープン GIS データを見る・変換する |

## 内部用

`apps/uploader`（データを焼いて R2 に上げる）、`apps/account`（`/auth`・`/me` のサインインと利用者ごとの保存）、`apps/quakes-mirror` と `apps/sats-mirror`（USGS と CelesTrak のフィードの写し）。
