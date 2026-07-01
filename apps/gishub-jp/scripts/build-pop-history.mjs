/**
 * 国勢調査 時系列データ「第6表 年齢（3区分），男女別人口」から
 * 市区町村別・年次別の人口推移を生成 → census/pop-history.json
 *
 * 出典: e-Stat 統計表Excel（47都道府県、statInfId 1085975〜1086021）
 *   URL: https://www.e-stat.go.jp/stat-search/file-download?statInfId=00000{id}&fileKind=0
 * 各シート = 年次（昭和55年〜令和2年）。2015/2020は「_不詳補完値」を優先。
 * 各行: t[2]=市区町村コード, 値=[男少,男生,男老,女少,女生,女老]（年齢3区分×男女）
 *   t[9]=男<15, t[10]=15≤男<64, t[11]=男≥64, t[13]=女<15, t[14]=女生, t[15]=女老
 *
 * node scripts/build-pop-history.mjs
 */
import * as XLSX from 'xlsx';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT   = join(__dir, '../public/census/pop-history.json');   // 1MB: バンドルせず静的配信でランタイムfetch
const PROXY = 'https://api.ortho-earth.com/proxy/?url=';

// 都道府県順（01北海道〜47沖縄）の statInfId
const IDS = [];
for (let id = 1085975; id <= 1086021; id++) IDS.push(id);

// シート基底名 → 西暦
const YEARS = [
    ['昭和55年', 1980], ['昭和60年', 1985], ['平成2年', 1990], ['平成7年', 1995],
    ['平成12年', 2000], ['平成17年', 2005], ['平成22年', 2010], ['平成27年', 2015], ['令和2年', 2020],
];

const num = s => +String(s).replace(/,/g, '') || 0;

async function fetchXlsx(id, tries = 3) {
    const url = `${PROXY}${encodeURIComponent(`https://www.e-stat.go.jp/stat-search/file-download?statInfId=00000${id}&fileKind=0`)}`;
    for (let a = 1; a <= tries; a++) {
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const b = Buffer.from(await r.arrayBuffer());
            if (!(b[0] === 0x50 && b[1] === 0x4b)) throw new Error('not xlsx');
            return XLSX.read(b, { type: 'buffer' });
        } catch (e) {
            if (a === tries) throw e;
            await new Promise(res => setTimeout(res, 1500 * a));
        }
    }
}

const Q = {};   // code → { year: [男少,男生,男老,女少,女生,女老] }

for (let i = 0; i < IDS.length; i++) {
    const pref = String(i + 1).padStart(2, '0');
    const wb = await fetchXlsx(IDS[i]);
    for (const [base, year] of YEARS) {
        const sn = wb.SheetNames.find(s => s === `${base}_不詳補完値`)
                || wb.SheetNames.find(s => s === `${base}_原数値`)
                || wb.SheetNames.find(s => s === base);
        if (!sn) continue;
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
        for (const t of rows) {
            if (!/^\d+$/.test(String(t[2]))) continue;
            const code = String(parseInt(t[2], 10)).padStart(5, '0');
            (Q[code] ??= {})[year] = [num(t[9]), num(t[10]), num(t[11]), num(t[13]), num(t[14]), num(t[15])];
        }
    }
    process.stdout.write(`\r  ${pref} 完了 (${i + 1}/47)  codes=${Object.keys(Q).length}   `);
}
process.stdout.write('\n');

writeFileSync(OUT, JSON.stringify(Q));

// 検証: 全国2020総人口（各県000行の3区分合計） vs 126,146,099（不詳補完値なので一致するはず）
let nat2020 = 0;
for (let p = 1; p <= 47; p++) {
    const v = Q[String(p).padStart(2, '0') + '000']?.[2020];
    if (v) nat2020 += v[0] + v[1] + v[2] + v[3] + v[4] + v[5];
}
console.log(`✅ ${Object.keys(Q).length} codes → census/pop-history.json`);
console.log(`   全国2020(3区分合計) = ${nat2020.toLocaleString()}  (参考: 総数126,146,099)`);
