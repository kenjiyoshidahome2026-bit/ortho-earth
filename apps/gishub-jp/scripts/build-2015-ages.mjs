/**
 * 国勢調査2015 e-Stat GIS T000849 (年齢別人口) → census/2015-ages.json
 *
 * 16 groups per sex: 0-4, 5-9, ..., 70-74, 75+
 * CSVの列位置: 男 t[28:43]+t[46], 女 t[48:63]+t[66]
 * 出力: { "13101": [m0..m15, f0..f15], "_national": [...] }
 *
 * node scripts/build-2015-ages.mjs
 */
import AdmZip from 'adm-zip';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT   = join(__dir, '../census/2015-ages.json');
const PROXY = 'https://api.ortho-earth.com/proxy/?url=';
const GIS   = 'https://www.e-stat.go.jp/gis/statmap-search/data';

const clean = a => a.map(v => +v || 0);

async function fetchTable(statsId, pref, tries = 3) {
    const url = `${PROXY}${encodeURIComponent(`${GIS}?statsId=${statsId}&downloadType=2&code=${pref}`)}`;
    for (let a = 1; a <= tries; a++) {
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const b = Buffer.from(await r.arrayBuffer());
            if (!(b[0] === 0x50 && b[1] === 0x4b)) throw new Error('not zip');
            const zip = new AdmZip(b);
            const e = zip.getEntries().find(x => /\.(csv|txt)$/i.test(x.entryName) && !x.entryName.startsWith('.'));
            let t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(e.getData()); }
            catch { t = new TextDecoder('shift-jis').decode(e.getData()); }
            return t.split(/\r?\n/).map(l => l.split(',').map(s => s.replace(/^"|"$/g, '')));
        } catch (err) {
            if (a === tries) throw err;
            await new Promise(res => setTimeout(res, 1500 * a));
        }
    }
}

const out = {};
const natM = new Array(16).fill(0);
const natF = new Array(16).fill(0);

for (let p = 1; p <= 47; p++) {
    const pref = String(p).padStart(2, '0');
    try {
        const rows = await fetchTable('T000849', pref);
        let count = 0;
        for (const t of rows) {
            const code = String(t[0] || '');
            if (code.length !== 5 || !/^\d{5}$/.test(code)) continue;
            // 男: cols 28-42 (0-4〜70-74, 15groups) + col 46 (75+)
            // 女: cols 48-62 (0-4〜70-74, 15groups) + col 66 (75+)
            const m = clean(t.slice(28, 43).concat([t[46]]));
            const f = clean(t.slice(48, 63).concat([t[66]]));
            out[code] = [...m, ...f];
            for (let j = 0; j < 16; j++) natM[j] += m[j];
            for (let j = 0; j < 16; j++) natF[j] += f[j];
            count++;
        }
        process.stdout.write(`\r  ${pref} 完了 (${p}/47)  codes=${Object.keys(out).length}   `);
    } catch (err) {
        console.error(`\n  ${pref} FAILED: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 400));
}
process.stdout.write('\n');

out['_national'] = [...natM, ...natF];
writeFileSync(OUT, JSON.stringify(out));

let total = Object.keys(out).filter(k => k !== '_national').length;
console.log(`✅ ${total} codes → census/2015-ages.json`);
console.log(`   全国男性総人口(0-4) = ${natM[0].toLocaleString()}  (参考: 2015 約252万人)`);
