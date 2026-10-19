// loaders.gl を worker で呼ぶ時の glTF の選択肢の検定（2026-10-19）。node packages/globe/tests/loaders-worker-opts.mjs
//  loaders.gl 4.5 の EXT_texture_avif は、どの glTF でも preprocess で getSupportedImageFormats() を呼び、
//  ブラウザ判定（worker も真）の下で new Image() する＝worker には Image が無く「Image is not defined」で倒れる（b3dm が描けない）。
//  meshdecode.ts の excludeExtensions は全部 EXT_texture_avif: false（loaders.gl では false が「外す」）を持つこと
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/meshdecode.ts", import.meta.url), "utf8");
const sets = [...src.matchAll(/excludeExtensions:\s*\{([^}]*)\}/g)].map(m => m[1]);
assert.ok(sets.length >= 2, `excludeExtensions が見当たらない（${sets.length} 件）`);
for (const s of sets) assert.match(s, /EXT_texture_avif:\s*false/, `EXT_texture_avif を外していない excludeExtensions：{${s.trim()}}`);
console.log(`  ✓ meshdecode の excludeExtensions ${sets.length} 件とも EXT_texture_avif を外す`);
