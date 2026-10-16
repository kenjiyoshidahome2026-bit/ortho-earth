// 型を書き切っていない subpath の省略宣言（import は any で通る・TS7016 を出さない）。型を書いたら該当行を消して package.json の exports に "types" を足す。
// 正典（散文）は reference.md「Module map」。2026-10-12（改良点 10）
declare module "geopbf/no-builtin-workers";
declare module "geopbf/gint";
declare module "geopbf/czml";
declare module "geopbf/parquet";
declare module "geopbf/featureservice";
declare module "geopbf/georef";
declare module "geopbf/maplibre-cog";
declare module "geopbf/leaflet-cog";
declare module "geopbf/sanitize";
declare module "geopbf/edit";
declare module "geopbf/edit/*";
declare module "geopbf/encodeXLSX";
// geopbf/internal/*（src/*.ts）と cog／convert の subpath は .ts を直に指す＝exports から型が付く（TS化 段 3・2026-10-16）＝省略宣言は要らない
