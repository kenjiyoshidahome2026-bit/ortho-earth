/**
 * e-Stat GIS T001082 (年齢別人口) → census/2020-ages.json
 *
 * downloadType=2 : 市区町村レベル CSV
 * 出力: { "13101": [m0,m1,...,m15, f0,...,f15], "_national": [...] }
 * 16 groups per sex: 0-4, 5-9, ..., 70-74, 75+
 *
 * node scripts/build-2020-ages.mjs
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import AdmZip from 'adm-zip';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT   = join(__dir, '../census/2020-ages.json');

const BASE_URL = 'https://www.e-stat.go.jp/gis/statmap-search/data';
const STATS_ID = 'T001082';

// male cols: T001082022-T001082036 (0-4 to 70-74), T001082040 (75+)
// fema cols: T001082042-T001082056 (0-4 to 70-74), T001082060 (75+)
const MALE_COLS = [
    ...Array.from({ length: 15 }, (_, i) => `T001082${String(22 + i).padStart(3, '0')}`),
    'T001082040',
];
const FEMA_COLS = [
    ...Array.from({ length: 15 }, (_, i) => `T001082${String(42 + i).padStart(3, '0')}`),
    'T001082060',
];
const ALL_COLS = [...MALE_COLS, ...FEMA_COLS];

function decode(buf) {
    try { return new TextDecoder('shift_jis').decode(buf); } catch { return buf.toString('utf8'); }
}

function parseCSV(text) {
    const lines = text.split(/\r?\n/);
    // Row 0 = column IDs, Row 1 = Japanese descriptions, Row 2+ = data
    if (lines.length < 3) return [];

    const raw    = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const ci     = raw.findIndex(h => /^KEY_CODE$/i.test(h));
    const hyoIdx = raw.findIndex(h => /^HYOSYO$/i.test(h));
    if (ci < 0) {
        console.warn('  KEY_CODE column not found, header sample:', raw.slice(0, 7).join(','));
        return [];
    }

    const ageIdx = ALL_COLS.map(col => raw.findIndex(h => h === col));
    const missingCount = ageIdx.filter(i => i < 0).length;
    if (missingCount > 0) console.warn(`  ${missingCount} age columns not found`);

    const result = [];
    for (let i = 2; i < lines.length; i++) {     // skip 2 header rows
        if (!lines[i].trim()) continue;
        const row  = lines[i].split(',');
        // Keep only city-level (HYOSYO=1); skip if hyoIdx not found
        if (hyoIdx >= 0 && row[hyoIdx]?.trim() !== '1') continue;
        const code = row[ci]?.trim().replace(/^"|"$/g, '');
        if (!code || code.length !== 5 || !/^\d{5}$/.test(code)) continue;
        const ages = ageIdx.map(idx => idx >= 0 ? (parseInt(row[idx], 10) || 0) : 0);
        result.push([code, ages]);
    }
    return result;
}

async function fetchPref(pref) {
    const code = String(pref).padStart(2, '0');
    const url  = `${BASE_URL}?statsId=${STATS_ID}&downloadType=2&code=${code}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const zip = new AdmZip(buf);
    const entry = zip.getEntries().find(e => /\.(csv|txt)$/i.test(e.entryName) && !e.entryName.startsWith('.'));
    if (!entry) throw new Error(`No CSV/TXT in ZIP (entries: ${zip.getEntries().map(e=>e.entryName).join(', ')})`);
    return decode(entry.getData());
}

async function main() {
    const out       = {};
    const natM      = new Array(16).fill(0);
    const natF      = new Array(16).fill(0);
    let totalCities = 0;

    for (let pref = 1; pref <= 47; pref++) {
        const code = String(pref).padStart(2, '0');
        process.stdout.write(`[${code}/47] `);
        try {
            const text = await fetchPref(pref);
            const rows = parseCSV(text);
            for (const [city, ages] of rows) {
                out[city] = ages;
                for (let j = 0; j < 16; j++) natM[j] += ages[j];
                for (let j = 0; j < 16; j++) natF[j] += ages[j + 16];
            }
            totalCities += rows.length;
            console.log(`${rows.length} cities`);
        } catch (e) {
            console.error(`FAILED: ${e.message}`);
        }
        // polite rate limit
        await new Promise(r => setTimeout(r, 400));
    }

    out['_national'] = [...natM, ...natF];
    writeFileSync(OUT, JSON.stringify(out));
    console.log(`\n✅ ${totalCities} cities → census/2020-ages.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
