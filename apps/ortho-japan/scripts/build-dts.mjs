#!/usr/bin/env node
// SDK の型定義 lib/ortho-japan.d.ts を作る（2026-09-25）。正本は @ortho-earth/globe の globe.d.ts（map の公開面は globe の物）＝
// それを丸ごと継ぎ、SDK の入口（default orthoJapan）を足すだけ。SDK は依存ゼロの束なので import で繋がず自己完結の 1 枚にする。
// 使い方：node scripts/build-dts.mjs <出力ファイル>
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const out = process.argv[2];
if (!out) { console.error("usage: build-dts.mjs <out.d.ts>"); process.exit(1); }
const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/globe/globe.d.ts");
const globe = readFileSync(src, "utf8");
writeFileSync(out, `// ortho-japan SDK 型定義＝@ortho-earth/globe の globe.d.ts ＋ SDK の入口（scripts/build-dts.mjs が作る・手で直さない）\n\n${globe}
/** 1行で地球儀が立ち上がる入口（globe＋日本の申告）。await 必須 */
export default function orthoJapan(opts?: OrthoJapanOptions): Promise<OrthoJapanMap>;
`);
