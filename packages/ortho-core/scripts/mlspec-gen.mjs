// MapLibre の style-spec（v8.json）から、層の型ごとの layout／paint の性質の名前と source の型を写した表 src/mlspec.ts を作る（互換の計画 P0・2026-10-22）。
// 使い方：node scripts/mlspec-gen.mjs <maplibre-style-spec の clone か npm の package の dir>（src/reference/v8.json を読む）
// 表は入口の検査（validateMLStyle）と網羅表（globe scripts/ml-coverage.mjs）が読む。spec の版を上げた時だけ作り直す
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) { console.error("usage: node scripts/mlspec-gen.mjs <maplibre-style-spec dir>"); process.exit(2); }
const spec = JSON.parse(fs.readFileSync(path.join(root, "src/reference/v8.json"), "utf8"));
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const types = Object.keys(spec.layer.type.values);
const layers = Object.fromEntries(types.map(t => [t, { layout: Object.keys(spec[`layout_${t}`] || {}), paint: Object.keys(spec[`paint_${t}`] || {}) }]));
const sources = spec.source.map(k => spec[k]?.type?.values ? Object.keys(spec[k].type.values) : []).flat();
const out = `// 生成物（scripts/mlspec-gen.mjs・手で書き換えない）＝MapLibre style-spec ${version} の v8.json の写し：層の型ごとの layout／paint の性質の名前・source の型・root と層の鍵。
// 入口の検査（mlstyle.ts の validateMLStyle）と網羅表（globe scripts/ml-coverage.mjs）が読む
export const ML_SPEC_VERSION = ${JSON.stringify(version)};
export const ML_LAYER_PROPS: Record<string, { layout: string[]; paint: string[] }> = ${JSON.stringify(layers, null, "\t")};
export const ML_SOURCE_TYPES: string[] = ${JSON.stringify([...new Set(sources)])};
export const ML_ROOT_KEYS: string[] = ${JSON.stringify(Object.keys(spec.$root))};
export const ML_LAYER_KEYS: string[] = ${JSON.stringify(Object.keys(spec.layer))};
`;
fs.writeFileSync(new URL("../src/mlspec.ts", import.meta.url), out);
console.log(`mlspec.ts from style-spec ${version}: ${types.length} layer types, ${Object.values(layers).reduce((a, l) => a + l.layout.length + l.paint.length, 0)} properties`);
