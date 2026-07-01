/**
 * T001081（2020年国勢調査 基本集計）全47都道府県
 * → 市区町村レベル（HYOSYO=1, code.length===5）の人口データ
 * → public/census/2020-pop.json
 *
 * 出力形式: { "13101": [66680, 33637, 33043], ... }
 *   [総人口, 男, 女]
 *
 * node scripts/build-2020-pop.mjs
 */
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import AdmZip from 'adm-zip';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT   = join(__dir, '../census/2020-pop.json');

const outDir = dirname(OUT);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

function decode(buf) {
    try { return new TextDecoder('shift_jis').decode(buf); } catch { return buf.toString('utf8'); }
}

function parseCityRows(text) {
    const lines = text.split(/\r?\n/);
    // Row 0 = col IDs, Row 1 = descriptions, Row 2+ = data
    if (lines.length < 3) return [];
    const result = [];
    for (let i = 2; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cols = lines[i].split(',');
        const code = cols[0]?.trim().replace(/^"|"$/g, '');
        if (!code || code.length !== 5) continue;   // only city-level (5-digit code)
        const total = parseInt(cols[7], 10);
        const male  = parseInt(cols[8], 10);
        const fem   = parseInt(cols[9], 10);
        if (isNaN(total)) continue;
        result.push([code, total, male || 0, fem || 0]);
    }
    return result;
}

async function fetchPref(pref) {
    const prefCode = String(pref).padStart(2, '0');
    const url = `https://www.e-stat.go.jp/gis/statmap-search/data?statsId=T001081&downloadType=2&code=${prefCode}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf   = Buffer.from(await resp.arrayBuffer());
    const zip   = new AdmZip(buf);
    const entry = zip.getEntries().find(e => /\.(csv|txt)$/i.test(e.entryName) && !e.entryName.startsWith('.'));
    if (!entry) throw new Error('No data file in ZIP');
    return decode(entry.getData());
}

async function main() {
    const out = {};
    let total = 0;

    for (let pref = 1; pref <= 47; pref++) {
        const code = String(pref).padStart(2, '0');
        process.stdout.write(`[${code}/47] `);
        try {
            const text = await fetchPref(pref);
            const rows = parseCityRows(text);
            for (const [c, t, m, f] of rows) {
                out[c] = [t, m, f];
                total++;
            }
            console.log(`${rows.length} cities`);
        } catch (e) {
            console.error(`FAILED: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 300));
    }

    writeFileSync(OUT, JSON.stringify(out));
    const kb = (Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(0);
    console.log(`\n✅ ${total} cities → census/2020-pop.json (${kb} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
