/**
 * 2015年国勢調査 GIS T-tableの内容をスキャンして家族類型・住宅系のテーブルを特定する
 * node scripts/scan-2015-tables.mjs
 */
import AdmZip from 'adm-zip';

const PROXY = 'https://api.ortho-earth.com/proxy/?url=';
const GIS   = 'https://www.e-stat.go.jp/gis/statmap-search/data';

async function probe(statsId) {
    try {
        const url = `${PROXY}${encodeURIComponent(`${GIS}?statsId=${statsId}&downloadType=2&code=01`)}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) return null;
        const b = Buffer.from(await r.arrayBuffer());
        if (!(b[0] === 0x50 && b[1] === 0x4b)) return null;
        const zip = new AdmZip(b);
        const e = zip.getEntries().find(x => /\.(csv|txt)$/i.test(x.entryName) && !x.entryName.startsWith('.'));
        if (!e) return null;
        let t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(e.getData()); }
        catch { t = new TextDecoder('shift-jis').decode(e.getData()); }
        const rows = t.split(/\r?\n/).map(l => l.split(',').map(s => s.replace(/^"|"$/g, '')));
        const h = rows[0], d = rows[1];
        const cols = h.length - 7;  // data columns (excluding metadata)
        // 最初のデータ列の日本語名と列数を返す
        return { cols, first: d[7] || h[7], second: d[8] || '' };
    } catch { return null; }
}

// T000854-T000880 をスキャン
const ids = [];
for (let i = 854; i <= 882; i++) ids.push(`T${String(i).padStart(6,'0')}`);

console.log('T-table | データ列数 | 1列目の説明                          | 2列目');
for (const id of ids) {
    const r = await probe(id);
    if (r) {
        console.log(`${id} | ${String(r.cols).padStart(6)} | ${r.first.slice(0,38).padEnd(38)} | ${r.second.slice(0,30)}`);
    } else {
        process.stdout.write('.');
    }
    await new Promise(res => setTimeout(res, 200));
}
console.log('\n完了');
