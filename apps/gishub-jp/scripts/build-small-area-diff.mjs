/**
 * 2015 ↔ 2020 の小地域（9桁＝町丁・字等）コード集合を市区町村ごとに突合し、
 * 「区域の追加・削除があった市区町村」だけを census/small-area-diff.json に出力する。
 *
 * 出力形式: { "46525": [7, 49], ... }   // [2015の区域数, 2020の区域数]
 *   ・両年に同一5桁コードで存在し、かつ9桁コード集合に差分（追加 or 削除）がある市区町村のみ
 *   ・名称のみ変更や完全一致は含めない（実質的な区分変更に限定）
 *   ・市制施行等で5桁コード自体が変わったもの（片年のみ存在）は対象外
 *
 * node scripts/build-small-area-diff.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT   = join(__dir, '../census/small-area-diff.json');

// 5桁市区町村 → Set<9桁コード>
function loadCityCodeSets(file) {
    const m = new Map();
    for (const line of readFileSync(join(__dir, '..', file), 'utf8').split('\n')) {
        if (!line) continue;
        const code = line.slice(0, line.indexOf(','));
        if (code.length !== 9) continue;   // 9桁＝町丁・字等（正準層）のみ
        const city = code.slice(0, 5);
        if (!m.has(city)) m.set(city, new Set());
        m.get(city).add(code);
    }
    return m;
}

const a = loadCityCodeSets('public/census/2015-small.csv');
const b = loadCityCodeSets('public/census/2020-small.csv');

const out = {};
let changed = 0;
for (const [city, s15] of a) {
    const s20 = b.get(city);
    if (!s20) continue;                    // 片年のみ（市制施行等）は対象外
    let added = 0, removed = 0;
    for (const c of s20) if (!s15.has(c)) added++;
    for (const c of s15) if (!s20.has(c)) removed++;
    if (added || removed) { out[city] = [s15.size, s20.size]; changed++; }
}

// 5桁コードをキー順（文字列）でソートして安定出力
const sorted = {};
for (const k of Object.keys(out).sort()) sorted[k] = out[k];

writeFileSync(OUT, JSON.stringify(sorted));
const size = (Buffer.byteLength(JSON.stringify(sorted)) / 1024).toFixed(1);
console.log(`✅ ${changed} 市区町村（区分変更あり）→ census/small-area-diff.json (${size} KB)`);
