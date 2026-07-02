/**
 * T000848-T000853 の詳細インスペクション（全6テーブルの内容確認）
 * node scripts/inspect-t000850.mjs
 */
import AdmZip from 'adm-zip';
const PROXY = 'https://api.ortho-earth.com/proxy/?url=';
const GIS   = 'https://www.e-stat.go.jp/gis/statmap-search/data';

async function inspect(statsId) {
    const url = `${PROXY}${encodeURIComponent(`${GIS}?statsId=${statsId}&downloadType=2&code=13`)}`;
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) { console.log(`${statsId}: HTTP ${r.status}`); return; }
        const b = Buffer.from(await r.arrayBuffer());
        if (!(b[0] === 0x50 && b[1] === 0x4b)) { console.log(`${statsId}: not zip`); return; }
        const zip = new AdmZip(b);
        const e = zip.getEntries().find(x => /\.(csv|txt)$/i.test(x.entryName) && !x.entryName.startsWith('.'));
        if (!e) { console.log(`${statsId}: no csv`); return; }
        let t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(e.getData()); }
        catch { t = new TextDecoder('shift-jis').decode(e.getData()); }
        const rows = t.split(/\r?\n/).map(l => l.split(',').map(s => s.replace(/^"|"$/g, '')));
        const hdr1 = rows[0] || [];
        const hdr2 = rows[1] || [];
        const dataRows = rows.filter(r => /^\d{5}$/.test(r[0]));
        const sample = dataRows.find(r => r[0] === '13101');
        console.log(`\n=== ${statsId} ===`);
        console.log(`  rows: ${dataRows.length}, cols: ${dataRows[0]?.length ?? 0}`);
        console.log(`  hdr1(7-16): [${hdr1.slice(7, 17).join(' | ')}]`);
        console.log(`  hdr2(7-16): [${hdr2.slice(7, 17).join(' | ')}]`);
        if (sample) console.log(`  千代田区(7-16): [${sample.slice(7, 17).join(', ')}]`);
    } catch(err) { console.log(`${statsId}: ERROR ${err.message}`); }
}

for (let i = 848; i <= 853; i++) {
    await inspect(`T${String(i).padStart(6, '0')}`);
    await new Promise(x => setTimeout(x, 400));
}
