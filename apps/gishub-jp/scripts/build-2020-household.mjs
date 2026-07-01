/**
 * 国勢調査2020 小地域GIS から市区町村別の世帯・住宅データを生成 → census/2020-household.json
 *   T001084 世帯の家族類型別世帯数
 *   T001085 住宅の所有関係別世帯数（持ち家・民営借家）
 *   T001086 住宅の建て方別世帯数
 * 各表を都道府県ZIP(downloadType=2)で取得し、市区町村(5桁)行の slice(7) を格納。
 *   { "01100": { fam:[...], own:[...], dwell:[...] }, ... }
 * 集計レベルは _aggForLevel で合算、小地域は runtime fetch（fetchSmallAreaStats拡張）。
 *
 * node scripts/build-2020-household.mjs
 */
import AdmZip from 'adm-zip';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT   = join(__dir, '../census/2020-household.json');
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

const TABLES = [['T001084', 'fam'], ['T001085', 'own'], ['T001086', 'dwell']];
const out = {};

for (let p = 1; p <= 47; p++) {
    const pref = String(p).padStart(2, '0');
    for (const [id, key] of TABLES) {
        const rows = await fetchTable(id, pref);
        for (const t of rows) {
            const code = String(t[0] || '');
            if (code.length !== 5) continue;   // 市区町村集計行のみ（小地域9/11桁は除外）
            (out[code] ??= {})[key] = clean(t.slice(7));
        }
    }
    process.stdout.write(`\r  ${pref} 完了 (${p}/47)  codes=${Object.keys(out).length}   `);
}
process.stdout.write('\n');

writeFileSync(OUT, JSON.stringify(out));
// 検証: 全国の家族類型総数（各県000は5桁でないので市区町村合算）
let famTotal = 0;
for (const c of Object.keys(out)) if (!c.endsWith('000') && out[c].fam) famTotal += out[c].fam[0];
console.log(`✅ ${Object.keys(out).length} codes → census/2020-household.json`);
console.log(`   市区町村合算 一般世帯総数(2020) = ${famTotal.toLocaleString()}  (参考: 約5,570万世帯)`);
