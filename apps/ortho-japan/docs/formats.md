# 読める形式・書ける形式の一覧（geopbf／ortho-japan）　2026-09-21 時点

コードから起こした台帳。正典＝`packages/geopbf/src/index.js`（拡張子の振り分け）・`packages/geopbf/src/convert/index.js`（API）・
`apps/ortho-japan/app.js` の INTAKE 表と `?g=`/`?cog=`/`?scene=`/`?pm=`・`gadgets/dropfile.js`。

## 1. geopbf が読める（ブラウザ：`geopbf(File | URL)`＝拡張子で worker へ振り分け・gzip は自動解凍）

| 種別 | 形式（拡張子） | 備考 |
| :-- | :-- | :-- |
| 自前 | GeoPBF（.geopbf / .pbf） | topology（gint）込み。@スタイル付きは注釈（geoedit 作） |
| JSON 系 | GeoJSON（.geojson / .json）・TopoJSON（.topojson / .json）・NDJSON / GeoJSON Text Sequence（.ndjson / .geojsonl / .geojsons / .jsonl）・CZML（.czml、.json 内の CZML も嗅ぎ分け） | IF は FeatureCollection |
| バイナリ | FlatGeobuf（.fgb） | |
| Shapefile | zip（.shp+.dbf+.shx+.prj） | .prj の CRS を読む |
| FileGDB | .gdb を zip したもの（*.gdbtable） | 層指定・平面直角座標系/UTM → 経緯度・日本測地系→JGD2011（tky2jgd/patchjgd 格子・無ければ Helmert） |
| GeoPackage | .gpkg | 自前 SQLite リーダ（読み専用・1 層指定）。ラスタ gpkg のタイルは API `openGpkgTiles` |
| SpatiaLite / SQLite | .sqlite / .sqlite3 / .spatialite / .db | 自前 SQLite リーダ |
| GeoParquet | .parquet / .geoparquet | WKB／経緯度列。zstd は不可（gzip/snappy/none）。API `openParquet` で footer→row group の Range 部分読み |
| CAD | DXF（.dxf） | CRS 指定・単位倍率・閉じた線を面に |
| 表 | CSV / TSV / XLSX（.csv / .tsv / .xlsx） | 経緯度列か WKT 列。非 UTF-8 は Shift_JIS フォールバック |
| XML 系 | KML / KMZ（.kml / .kmz）・GPX（.gpx・trk/rte の ele/time 保持）・GML（.gml / .xml・zip 内も可） | |
| 法務省 | MOJ 登記所備付地図（zip） | `{format:"moj"}` |
| 圧縮 | .gz（中身の印で判定） | どの形式も gzip のまま可 |

API／CLI だけで読めるもの（ドロップの振り分けには無い）：PMTiles（`readPMTiles`）・MBTiles（`openMBTiles`）・
GeoPackage のラスタタイル（`openGpkgTiles`）・COG / GeoTIFF（`geopbf/cog`＝`openCog`・Range 直読み・JPEG/WebP/deflate・
maplibre/leaflet アダプタ）。

## 2. geopbf が書ける

| 口 | 形式 |
| :-- | :-- |
| `pbf.*File()`（ブラウザ・File を返す） | GeoJSON・TopoJSON・FlatGeobuf・Shapefile（zip）・KMZ・GPX・CZML・GML・GeoPBF |
| API（`geopbf/convert`） | GeoParquet（`toGeoParquet`・WKB+bbox）・PMTiles（`toPMTiles`＝MVT タイル化・`writePMTiles`）・属性表（CSV） |
| 測地系 | Tokyo → JGD2000 → JGD2011 の連鎖（`resolveDatum`／`tokyoToJGD`・格子は native-bucket） |

CLI（`npx geopbf …`）：`enc`（→GeoPBF）・`dec`（→GeoJSON）・`info`・`lod`・`parquet`／`parquet2pbf`・`gpkg2pbf`・`gdb2pbf`・
`csv2pbf`・`dxf2pbf`・`spatialite2pbf`・`pmtiles`・`cog`。

## 3. ortho-japan が直読みできる（ドロップ／`?g=<URL>`・`gh:user/repo/path` 短縮／専用パラメータ）

| 入口 | 形式 | どう描くか |
| :-- | :-- | :-- |
| ドロップ・?g= | 1. の全形式 | GeoPBF 本道＝gint（GPU 描画・識別・地形ドレープ）→ bbox へ球面フライト。単一スロット（最後の 1 枚が勝つ） |
| ドロップ・?g= | @スタイル付き GeoPBF（geoedit 作） | anno（canvas2D 再生・3D ピン・tip/pop） |
| ドロップ・?g= | GeoParquet 8 MB 超 | 視野追従（row group の Range 部分読み・IDB キャッシュ・列で色分け・点は GPU 直行） |
| ドロップ・?cog= | COG / GeoTIFF（.tif / .tiff） | 球へドレープ（cog ガジェット・Range 直読み） |
| ドロップ・?g=（+?at=lon,lat[,heading[,scale]]） | glTF / GLB（.glb / .gltf） | PLATEAU と同じ建物メッシュ（落とした地点・CESIUM_RTC/ECEF 優先・マテリアル/テクスチャ/ミップ/BLEND） |
| ドロップ・?scene= | シーン台本（.scenes / .scenes.gz / type:"scenes" の JSON） | 共有シーンの再生（飛行・ドリー） |
| ?pm= | PMTiles（MVT ベクタタイル／ラスタ png・jpeg・webp・avif） | ベクタ＝基図として（vector_layers から規則を自動生成）／ラスタ＝ヘッダの tileType で自動判別→画像タイル層（基図・塗りは伏せる） |
| ?xyz=（+?xyzmin= ?xyzmax=）・?r=<id,…> | XYZ 画像タイル（`{z}/{x}/{y}` テンプレ・`{-y}` `{s}` `{q}` 可）／地域パックのカタログ id（地理院 std/pale/写真/色別標高＝基図・陰影/洪水浸水想定＝重ね） | 画像タイル層（ortho-core/raster）＝タイル 1 枚＝格子メッシュ＋uv を塗り VS で描く（地形ドレープ・建物遮蔽を継承・両バックエンド）。公開 API `map.raster.add(id, spec, opts)`＝自前契約の URL テンプレ・ラスタ PMTiles・MessagePort プロバイダ |
| ドロップ | ラスタ GeoPackage（gpkg_tile_matrix が Web Mercator XYZ 同型の表）・MBTiles（画像） | プロバイダ worker（rastertiles-worker.js＝geopbf openGpkgTiles/openMBTiles）→ MessagePort → 画像タイル層。地物層だけの gpkg はベクタ本道へ・ベクタ MBTiles は理由を言って断る |
| 地域宣言（jp/nl region） | 3D Tiles（b3dm / glb・Draco・KHR_mesh_quantization・CESIUM_RTC） | PLATEAU / 3DBAG の建物台帳（自動ロード・IDB/OPFS 焼き） |
| ガジェット | STAC（Earth Search・Sentinel-2 → COG）・Tellus（PALSAR-2 / AVNIR-2 / GCOM-C の COG） | 衛星画像を球へ |
| ガジェット | USGS 地震 GeoJSON・衛星 TLE（sats-mirror）・e-Stat 小地域・国土数値情報（KSJ 直読み→IDB） | データ直読み（鯖焼きなし） |

未対応：非メルカトル（gpkg_tile_matrix が XYZ 同型でない）タイル行列・ベクタ MBTiles（MVT）の表示・glTF の
metallic/roughness/normal/emissive・KHR_texture_basisu・EXT_texture_webp のテクスチャ（worker で解けない＝形だけ）。
（ラスタ GeoPackage / MBTiles の画像タイル層は 2026-09-21 に実装＝上の表）
