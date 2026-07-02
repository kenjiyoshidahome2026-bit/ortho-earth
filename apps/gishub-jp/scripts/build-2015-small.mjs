/**
 * 国勢調査2015 e-Stat GIS T000848（男女別人口・世帯総数）全47都道府県 → public/census/2015-small.csv
 *
 * 出力形式（1行 = 1小地域）: KEY_CODE,NAME,総人口,男,女
 *   KEY_CODE: 9桁=町丁・字等 / 11桁=基本単位区
 *   （5桁の市区町村集計行は除外。市区町村コードは KEY_CODE の先頭5桁）
 *
 * 2020年版 build-2020-small.mjs（T001081）と同一形式。列位置も共通:
 *   cols[0]=code, cols[3]=name, cols[7]=人口総数, cols[8]=男, cols[9]=女
 *
 * node scripts/build-2015-small.mjs
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import AdmZip from 'adm-zip';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT   = join(__dir, '../public/census/2015-small.csv');

const outDir = join(__dir, '../public/census');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

function decode(buf) {
    try { return new TextDecoder('shift_jis').decode(buf); } catch { return buf.toString('utf8'); }
}

function parseSmallAreas(text) {
    const lines = text.split(/\r?\n/);
    if (lines.length < 3) return [];   // Row 0 = col IDs, Row 1 = 説明, Row 2+ = data
    const result = [];
    for (let i = 2; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cols = lines[i].split(',');
        const code = cols[0]?.trim();
        if (!code || code.length <= 5) continue;   // skip city-level rows
        const name  = (cols[3] || cols[2] || '').trim().replace(/^"|"$/g, '');
        const total = parseInt(cols[7], 10) || 0;
        const male  = parseInt(cols[8], 10) || 0;
        const fem   = parseInt(cols[9], 10) || 0;
        const city  = code.slice(0, 5);
        result.push([city, [code, name, total, male, fem]]);
    }
    return result;
}

async function fetchPref(pref) {
    const prefCode = String(pref).padStart(2, '0');
    const url = `https://www.e-stat.go.jp/gis/statmap-search/data?statsId=T000848&downloadType=2&code=${prefCode}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf   = Buffer.from(await resp.arrayBuffer());
    const zip   = new AdmZip(buf);
    const entry = zip.getEntries().find(e => /\.(csv|txt)$/i.test(e.entryName) && !e.entryName.startsWith('.'));
    if (!entry) throw new Error('No data file in ZIP');
    return decode(entry.getData());
}

async function main() {
    const out   = {};
    let totalSA = 0;

    for (let pref = 1; pref <= 47; pref++) {
        const code = String(pref).padStart(2, '0');
        process.stdout.write(`[${code}/47] `);
        try {
            const text  = await fetchPref(pref);
            const pairs = parseSmallAreas(text);
            for (const [city, entry] of pairs) {
                if (!out[city]) out[city] = [];
                out[city].push(entry);
            }
            totalSA += pairs.length;
            console.log(`${pairs.length} small areas`);
        } catch (e) {
            console.error(`FAILED: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 400));
    }

    const rows = [];
    for (const entries of Object.values(out)) {
        for (const [code, name, total, male, fem] of entries) {
            const nm = name.includes(',') ? `"${name}"` : name;
            rows.push(`${code},${nm},${total},${male},${fem}`);
        }
    }
    rows.sort();
    writeFileSync(OUT, rows.join('\n') + '\n');
    const size = (Buffer.byteLength(rows.join('\n')) / 1024 / 1024).toFixed(1);
    console.log(`\n✅ ${totalSA} small areas → public/census/2015-small.csv (${size} MB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
