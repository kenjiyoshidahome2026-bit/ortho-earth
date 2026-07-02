/**
 * T001170-T001600 スキャン（2015年 家族類型・住宅系テーブル探索）
 * node scripts/scan-t001170plus.mjs
 */
import AdmZip from 'adm-zip';
const PROXY = 'https://api.ortho-earth.com/proxy/?url=';
const GIS   = 'https://www.e-stat.go.jp/gis/statmap-search/data';

async function probe(statsId, pref = '13') {
    const url = `${PROXY}${encodeURIComponent(`${GIS}?statsId=${statsId}&downloadType=2&code=${pref}`)}`;
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) return null;
        const b = Buffer.from(await r.arrayBuffer());
        if (!(b[0] === 0x50 && b[1] === 0x4b)) return null;
        const zip = new AdmZip(b);
        const e = zip.getEntries().find(x => /\.(csv|txt)$/i.test(x.entryName) && !x.entryName.startsWith('.'));
        if (!e) return null;
        let t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(e.getData()); }
        catch { t = new TextDecoder('shift-jis').decode(e.getData()); }
        const rows = t.split(/\r?\n/).map(l => l.split(',').map(s => s.replace(/^"|"$/g, '')));
        const hdr2 = rows[1] || [];
        const data = rows.find(r => /^\d{5}$/.test(r[0]));
        const cols = data ? data.length - 7 : 0;
        const label = hdr2.slice(7, 10).join(' / ');
        return { cols, label, rows: rows.filter(r => /^\d{5}$/.test(r[0])).length };
    } catch { return null; }
}

console.log('Scanning T001170-T001600...');
for (let i = 1170; i <= 1600; i++) {
    const id = `T${String(i).padStart(6, '0')}`;
    process.stdout.write('.');
    const r = await probe(id);
    if (r && r.rows > 0) {
        console.log(`\n${id} | ${r.rows} rows | ${r.cols} cols | ${r.label}`);
    }
    await new Promise(x => setTimeout(x, 150));
}
console.log('\n完了');
