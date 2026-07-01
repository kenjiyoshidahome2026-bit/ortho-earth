/**
 * scripts/admin-boundary.csv（全国地方公共団体コード + よみがな）
 * → census/kana.json  { "NN": 都道府県よみ, "NNXXX": 市区町村よみ }
 *
 * node scripts/build-kana.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC   = join(__dir, 'admin-boundary.csv');
const OUT   = join(__dir, '../census/kana.json');

const lines = readFileSync(SRC, 'utf8').split(/\r?\n/).filter(Boolean);
const hdr   = lines[0].split(',');
const ci = {
    code: hdr.indexOf('code'), city: hdr.indexOf('city'),
    prefKana: hdr.indexOf('prefKana'), cityKana: hdr.indexOf('cityKana'),
    status: hdr.indexOf('status'),
};

const out = {};
for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const code = c[ci.code]?.trim();
    if (!code || c[ci.status]?.trim() === '欠番') continue;   // 現行のみ
    const cityKana = c[ci.cityKana]?.trim();
    const prefKana = c[ci.prefKana]?.trim();
    if (code.endsWith('000')) {                 // 都道府県: キーは2桁
        if (prefKana) out[code.slice(0, 2)] = prefKana;
    } else if (cityKana) {                       // 市区町村: キーは5桁
        out[code] = cityKana;
    }
}

writeFileSync(OUT, JSON.stringify(out));
console.log(`✅ ${Object.keys(out).length} よみがな → census/kana.json`);
