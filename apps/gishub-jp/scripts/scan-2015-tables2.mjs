/**
 * 2015年国勢調査 基本集計の T-table を広域スキャン
 * node scripts/scan-2015-tables2.mjs
 */
import AdmZip from 'adm-zip';

const PROXY = 'https://api.ortho-earth.com/proxy/?url=';
const GIS   = 'https://www.e-stat.go.jp/gis/statmap-search/data';

async function probe(statsId) {
    try {
        const url = `${PROXY}${encodeURIComponent(`${GIS}?statsId=${statsId}&downloadType=2&code=01`)}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) return null;
        const b = Buffer.from(await r.arrayBuffer());
        if (!(b[0] === 0x50 && b[1] === 0x4b)) return null;
        const zip = new AdmZip(b);
        const e = zip.getEntries().find(x => /\.(csv|txt)$/i.test(x.entryName) && !x.entryName.startsWith('.'));
        if (!e) return null;
        let t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(e.getData()); }
        catch { t = new TextDecoder('shift-jis').decode(e.getData()); }
        const rows = t.split(/\r?\n/).map(l => l.split(',').map(s => s.replace(/^"|"$/g, '')));
        const d = rows[1];
        return { cols: rows[0].length - 7, first: (d[7]||'').slice(0,40), second: (d[8]||'').slice(0,25) };
    } catch { return null; }
}

// 複数の番号域をスキャン
const ranges = [
    // T000900-T000950
    ...Array.from({length:51}, (_,i)=>`T${String(900+i).padStart(6,'0')}`),
    // T001001-T001050 (2020はT001081〜)
    ...Array.from({length:50}, (_,i)=>`T${String(1001+i).padStart(6,'0')}`),
];

console.log('T-table | 列数 | 1列目の説明');
for (const id of ranges) {
    const r = await probe(id);
    if (r) {
        console.log(`${id} | ${String(r.cols).padStart(4)} | ${r.first}`);
    } else {
        process.stdout.write('.');
    }
    await new Promise(res => setTimeout(res, 150));
}
console.log('\n完了');
