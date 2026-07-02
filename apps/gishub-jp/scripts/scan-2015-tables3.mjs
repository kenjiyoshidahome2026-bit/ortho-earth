/**
 * T003400-T003500 周辺のスキャン（2015年 家族類型・住宅系テーブル探索）
 * node scripts/scan-2015-tables3.mjs
 */
const PROXY = 'https://api.ortho-earth.com/proxy/?url=';
const GIS   = 'https://www.e-stat.go.jp/gis/statmap-search/data';

async function probe(statsId, pref = '13') {
    const url = `${PROXY}${encodeURIComponent(`${GIS}?statsId=${statsId}&downloadType=2&code=${pref}`)}`;
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) return null;
        const b = Buffer.from(await r.arrayBuffer());
        if (!(b[0] === 0x50 && b[1] === 0x4b)) return null;
        const { default: AdmZip } = await import('adm-zip');
        const zip = new AdmZip(b);
        const e = zip.getEntries().find(x => /\.(csv|txt)$/i.test(x.entryName) && !x.entryName.startsWith('.'));
        if (!e) return null;
        let t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(e.getData()); }
        catch { t = new TextDecoder('shift-jis').decode(e.getData()); }
        const rows = t.split(/\r?\n/).map(l => l.split(',').map(s => s.replace(/^"|"$/g, '')));
        // ヘッダ行を探す（5桁数字コードでない最初の行）
        const hdr = rows.find(r => r[0] && !/^\d{5}$/.test(r[0]));
        const data = rows.find(r => /^\d{5}$/.test(r[0]));
        const cols = data ? data.length - 7 : 0;
        const label = hdr ? hdr.slice(7, 11).join(' | ') : '(no header)';
        return { cols, label };
    } catch { return null; }
}

// T000300-T000500 と T003400-T003500 をスキャン
const RANGES = [
    [300, 500, 'T000'],
    [3400, 3500, 'T00'],
];

for (const [start, end, prefix] of RANGES) {
    console.log(`\nScanning ${prefix}${start}-${prefix}${end}...`);
    for (let i = start; i <= end; i++) {
        const id = `T${String(i).padStart(6, '0')}`;
        process.stdout.write('.');
        const r = await probe(id);
        if (r) {
            console.log(`\n${id} | ${r.cols} cols | ${r.label}`);
        }
        await new Promise(x => setTimeout(x, 200));
    }
}
console.log('\n完了');
