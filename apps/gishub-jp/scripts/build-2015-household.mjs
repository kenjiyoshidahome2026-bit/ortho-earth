/**
 * 2015年国勢調査 世帯・住宅データ生成
 *
 *   T000851 → fam  (世帯の家族類型: 9列)
 *               [0] 一般世帯総数
 *               [1] 親族のみの世帯
 *               [2] 核家族世帯
 *               [3] うち夫婦のみ
 *               [4] うち夫婦と子供
 *               [5] 核家族以外の世帯
 *               [6] 6歳未満世帯員あり
 *               [7] 18歳未満世帯員あり
 *               [8] 65歳以上世帯員あり
 *
 *   T000852 → own  (住宅の所有関係: 3列)
 *               [0] 住宅に住む一般世帯
 *               [1] 持ち家
 *               [2] 民営借家
 *
 *   T000853 → dwell (住宅の建て方: 9列)
 *               [0] 主世帯数
 *               [1] 一戸建
 *               [2] 長屋建
 *               [3] 共同住宅
 *               [4] 共同住宅1・2階建
 *               [5] 共同住宅3～5階建
 *               [6] 共同住宅6～10階建
 *               [7] 共同住宅11階建以上
 *               [8] その他
 *
 * node scripts/build-2015-household.mjs
 */
import AdmZip from 'adm-zip';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT   = join(__dir, '../census/2015-household.json');
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

// T000851=家族類型(fam), T000852=住宅所有(own), T000853=住宅建て方(dwell)
const TABLES = [['T000851', 'fam'], ['T000852', 'own'], ['T000853', 'dwell']];
const out = {};

for (let p = 1; p <= 47; p++) {
    const pref = String(p).padStart(2, '0');
    for (const [id, key] of TABLES) {
        try {
            const rows = await fetchTable(id, pref);
            for (const t of rows) {
                const code = String(t[0] || '');
                if (code.length !== 5 || !/^\d{5}$/.test(code)) continue;
                (out[code] ??= {})[key] = clean(t.slice(7));
            }
        } catch (err) {
            console.error(`\n  ${pref}/${id} FAILED: ${err.message}`);
        }
    }
    process.stdout.write(`\r  ${pref} 完了 (${p}/47)  codes=${Object.keys(out).length}   `);
    await new Promise(r => setTimeout(r, 400));
}
process.stdout.write('\n');

writeFileSync(OUT, JSON.stringify(out));

let famTotal = 0;
for (const c of Object.keys(out)) if (out[c].fam) famTotal += out[c].fam[0] || 0;
console.log(`✅ ${Object.keys(out).length} codes → census/2015-household.json`);
console.log(`   市区町村合算 一般世帯総数(2015) = ${famTotal.toLocaleString()}  (参考: 約5,340万世帯)`);
