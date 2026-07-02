/**
 * 2015 GIS CSV の列ヘッダーを確認するユーティリティ
 * T000865 / T000866 / T000875 の col 0〜30 番の名前と北海道サンプルデータを出力
 *
 * node scripts/inspect-2015-household-columns.mjs
 */
import AdmZip from 'adm-zip';

const PROXY = 'https://api.ortho-earth.com/proxy/?url=';
const GIS   = 'https://www.e-stat.go.jp/gis/statmap-search/data';

async function fetchCsv(statsId, pref = '01') {
    const url = `${PROXY}${encodeURIComponent(`${GIS}?statsId=${statsId}&downloadType=2&code=${pref}`)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = Buffer.from(await r.arrayBuffer());
    const zip = new AdmZip(b);
    const e = zip.getEntries().find(x => /\.(csv|txt)$/i.test(x.entryName) && !x.entryName.startsWith('.'));
    let t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(e.getData()); }
    catch { t = new TextDecoder('shift-jis').decode(e.getData()); }
    return t.split(/\r?\n/).map(l => l.split(',').map(s => s.replace(/^"|"$/g, '')));
}

for (const id of ['T000865', 'T000866', 'T000875']) {
    console.log('\n' + '='.repeat(60));
    console.log(`${id}`);
    console.log('='.repeat(60));
    const rows = await fetchCsv(id);
    const header = rows[0];  // row0=列ID, row1=日本語説明
    const desc   = rows[1];
    // 最初の市区町村行（5桁コード）を探す
    const sample = rows.slice(2).find(r => /^\d{5}$/.test(r[0]));

    console.log(`全列数: ${header.length}`);
    console.log('  idx | 列ID                 | 日本語説明                      | 札幌市?');
    for (let i = 0; i < Math.min(header.length, 40); i++) {
        const val = sample ? String(sample[i]).padStart(8) : '';
        console.log(`  ${String(i).padStart(3)} | ${(header[i]||'').padEnd(20)} | ${(desc[i]||'').slice(0,30).padEnd(30)} | ${val}`);
    }
}
