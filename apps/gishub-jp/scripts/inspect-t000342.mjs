/**
 * T000340-T000350 の詳細インスペクション
 * node scripts/inspect-t000342.mjs
 */
import AdmZip from 'adm-zip';
const PROXY = 'https://api.ortho-earth.com/proxy/?url=';
const GIS   = 'https://www.e-stat.go.jp/gis/statmap-search/data';

async function inspect(statsId, pref = '13') {
    const url = `${PROXY}${encodeURIComponent(`${GIS}?statsId=${statsId}&downloadType=2&code=${pref}`)}`;
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

    console.log(`\n=== ${statsId} ===`);
    // 最初の5行を表示
    for (let i = 0; i < Math.min(5, rows.length); i++) {
        console.log(`row${i}: [${rows[i].slice(0, 12).join(' | ')}]`);
    }
    // 5桁コードの行を探す
    const dataRows = rows.filter(r => /^\d{5}$/.test(r[0]));
    console.log(`  → 5桁コード行数: ${dataRows.length}, 列数: ${dataRows[0]?.length ?? 0}`);
    if (dataRows[0]) console.log(`  → 13xxx sample: [${dataRows.find(r => r[0].startsWith('13'))?.slice(0, 15).join(' | ') ?? 'none'}]`);
}

for (let i = 340; i <= 355; i++) {
    await inspect(`T${String(i).padStart(6, '0')}`);
    await new Promise(x => setTimeout(x, 300));
}
