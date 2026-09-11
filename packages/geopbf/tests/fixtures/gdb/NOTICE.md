# tests/fixtures/gdb

`testopenfilegdb.gdb.zip` は GDAL の自動テスト資料
（https://github.com/OSGeo/gdal/tree/master/autotest/ogr/data/filegdb ・ MIT/X ライセンス）をそのまま置いたもの。
FileGDB（ArcGIS 10.x 形式）の全フィールド型・全ジオメトリ種（Z/M・空・NULL・多面・穴・削除行・多パッチ）を 85KB に収めた資料で、
convert/filegdb.js の検定（tests/t-gdb.mjs）が読む。
