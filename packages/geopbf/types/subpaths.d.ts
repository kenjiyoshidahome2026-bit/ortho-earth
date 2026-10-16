// 型を書き切っていない subpath の省略宣言（import は any で通る・TS7016 を出さない）。型を書いたら該当行を消して package.json の exports に "types" を足す。
// 正典（散文）は reference.md「Module map」。2026-10-12（改良点 10）
// geopbf/internal/*（src/*.ts）・cog／convert・modules・edit の subpath は .ts を直に指す＝exports から型が付く（TS化 段 3・2026-10-16）＝省略宣言は要らない
// 段 4（2026-10-16）：parquet・featureservice・georef・maplibre-cog・leaflet-cog・sanitize も .ts＝省略宣言は今は 0 本（型を書き切っていない subpath を足す時の置き場として残す）
