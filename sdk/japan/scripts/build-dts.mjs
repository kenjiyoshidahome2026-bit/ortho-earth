#!/usr/bin/env node
// SDK の型定義 lib/ortho-japan.d.ts を作る（2026-09-25）。正本は @ortho-earth/globe の globe.d.ts（map の公開面は globe の物）＝
// それを丸ごと継ぎ、SDK の入口（default orthoJapan）を足すだけ。SDK は依存ゼロの束なので import で繋がず自己完結の 1 枚にする。
// 使い方：node scripts/build-dts.mjs <出力ファイル>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const out = process.argv[2];
if (!out) { console.error("usage: build-dts.mjs <out.d.ts>"); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../../packages/globe/globe.d.ts");
// 公開の map の型（GlobeMap／別名 OrthoJapanMap）の正本は globe の src/types/map.ts（TS 化 段 4・batch 1）＝globe.d.ts はそれを import／re-export する。
// SDK の 1 枚には中身を継ぐ：globe.d.ts の import／export … from "./src/types/map.ts" を map.ts の本文で置き換え、map.ts の import は
// 同じ 1 枚の中の型（globe.d.ts）なので外す
const mapSrc = path.resolve(here, "../../../packages/globe/src/types/map.ts");
const mapTs = readFileSync(mapSrc, "utf8").replace(/^import type \{[^}]*\} from "\.\.\/\.\.\/globe\.d\.ts";\n/m, "");
let globe = readFileSync(src, "utf8");
const link = /^import type \{ GlobeMap \} from "\.\/src\/types\/map\.ts";\nexport type \{[^}]*\} from "\.\/src\/types\/map\.ts";\n/m;
if (!link.test(globe) || /^import /m.test(mapTs)) { console.error("build-dts: cannot inline src/types/map.ts into globe.d.ts (the import lines changed)"); process.exit(1); }
globe = globe.replace(link, () => mapTs);
writeFileSync(out, `// ortho-japan SDK 型定義＝@ortho-earth/globe の globe.d.ts ＋ SDK の入口（scripts/build-dts.mjs が作る・手で直さない）\n\n${globe}
/** 1行で地球儀が立ち上がる入口（globe＋日本の申告）。await 必須 */
export default function orthoJapan(opts?: OrthoJapanOptions): Promise<GlobeMap>;
`);
