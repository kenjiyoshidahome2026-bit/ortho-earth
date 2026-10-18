# tests/fixtures/parquet

t-parquet-encodings.mjs が読む固定具です。中身は「よその writer が実際に書く形」なので、geopbf ではなく pyarrow（26.0.0・2026-10-12）で作り、生成物を commit してあります。検定は pyarrow も Python も無しで走ります。

| ファイル | 中身 |
|---|---|
| encodings-v2.parquet | 1000 行・DataPage v2・無圧縮・row group 600・page 2048 B。辞書なしで DELTA_BINARY_PACKED（i32/i64）、DELTA_BYTE_ARRAY（s/fixed）、DELTA_LENGTH_BYTE_ARRAY（s2）、BYTE_STREAM_SPLIT（f32/f64）、RLE（b）。7 行ごと（b は 11 行ごと）に null |
| encodings-v1-snappy.parquet | 同じ表を DataPage v1・snappy で |
| int96.parquet | 旧式の INT96 timestamp（ms）＋ int32 |
| collide.parquet | 入れ子の葉 `a.b`（struct a の b）と、実在の列名 `"a.b"` の衝突 |
| expected.json | 正解（全列の値・INT96 は epoch ms） |

作り直すとき（符号化を足すときなど）は、元の生成スクリプトを git の履歴から取り出して pyarrow の入った環境で走らせてください。

```sh
git show 9d52c2b:packages/geopbf/tests/fixtures/parquet/make.py > make.py   # 2026-10-18 にリポジトリから外した
```
