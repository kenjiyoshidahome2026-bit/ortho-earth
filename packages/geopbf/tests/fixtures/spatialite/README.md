# tests/fixtures/spatialite

t-spatialite.mjs が読む SpatiaLite の固定資料 mixed.sqlite です。幾何 BLOB は SpatiaLite 本体（mod_spatialite）に書かせたものなので、生成物を commit してあります。検定は mod_spatialite も Python も無しで走ります。

中身（page_size 1024・空間参照は 4326/3857/6677 だけ）:

- places: 300 点。型付き属性・overflow の長文・BLOB・NULL
- lines: XYZ の線。圧縮（CompressGeometry）と非圧縮
- polys: XYZM・穴あり。圧縮と非圧縮
- multi: GEOMETRY 列に MultiPoint／MultiLineString（圧縮）／MultiPolygon／GeometryCollection／NULL
- merc（EPSG:3857）・jpr（EPSG:6677 平面直角 IX）: 東京の点を ST_Transform したもの
- tiny・tinyz: TinyPoint（XY／XYZ）
- attrs_only: 幾何なしの表

作り直すときは、元の生成スクリプトを git の履歴から取り出して mod_spatialite の入った環境（`brew install libspatialite` など）で走らせてください。

```sh
git show 9d52c2b:packages/geopbf/tests/fixtures/spatialite/make.py > make.py   # 2026-10-18 にリポジトリから外した
```
