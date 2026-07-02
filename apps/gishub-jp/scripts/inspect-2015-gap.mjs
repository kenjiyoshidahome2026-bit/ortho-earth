/**
 * 2015年国勢調査 T-table ギャップ精査
 * T000854-T000900 の詳細インスペクション（家族類型・住宅系を探す）
 * node scripts/inspect-2015-gap.mjs
 */
import AdmZip from 'adm-zip';
const PROXY = 'https://api.ortho-earth.com/proxy/?url=';
const GIS   = 'https://www.e-stat.go.jp/gis/statmap-search/data';

async function inspect(statsId) {
    const url = `${PROXY}${encodeURIComponent(`${GIS}?statsId=${statsId}&downloadType=2&code=13`)}`;
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) { process.stdout.write(' 404'); return; }
        const b = Buffer.from(await r.arrayBuffer());
        if (!(b[0] === 0x50 && b[1] === 0x4b)) { process.stdout.write(' !zip'); return; }
        const zip = new AdmZip(b);
        const e = zip.getEntries().find(x => /\.(csv|txt)$/i.test(x.entryName) && !x.entryName.startsWith('.'));
        if (!e) { process.stdout.write(' !csv'); return; }
        let t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(e.getData()); }
        catch { t = new TextDecoder('shift-jis').decode(e.getData()); }
        const rows = t.split(/\r?\n/).map(l => l.split(',').map(s => s.replace(/^"|"$/g, '')));
        // 5桁コード行
        const dataRows = rows.filter(r => /^\d{5}$/.test(r[0]));
        // ヘッダ (2行目: 内容説明)
        const hdr2 = rows[1] || [];
        const label = hdr2.slice(7, 10).join(' / ');
        const cols = dataRows[0] ? dataRows[0].length - 7 : 0;
        console.log(`\n${statsId} | ${dataRows.length} rows | ${cols} cols | ${label}`);
        // 13101（千代田区）のサンプル
        const sample = dataRows.find(r => r[0] === '13101');
        if (sample) console.log(`  千代田区: [${sample.slice(7, 17).join(', ')}]`);
    } catch(err) { process.stdout.write(` ERR:${err.message}`); }
}

console.log('=== T000854-T000900 ===');
for (let i = 854; i <= 900; i++) {
    const id = `T${String(i).padStart(6, '0')}`;
    await inspect(id);
    await new Promise(x => setTimeout(x, 300));
}
console.log('\n\n完了');
