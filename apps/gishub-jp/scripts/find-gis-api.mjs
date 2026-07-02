/**
 * e-Stat GIS の内部APIエンドポイントを探し、2015年国勢調査の利用可能T-tableを取得する
 * node scripts/find-gis-api.mjs
 */
const PROXY = 'https://api.ortho-earth.com/proxy/?url=';

// GISデータダウンロード一覧API候補
const candidates = [
    // 2015年国勢調査のGISデータリスト
    `https://www.e-stat.go.jp/gis/statmap-search/statsIdSearch?surveyId=A002005212015`,
    `https://www.e-stat.go.jp/gis/statmap-search/statsIdSearch?toukeiCode=00200521&toukeiYear=2015`,
    `https://www.e-stat.go.jp/gis/statmap-search/ajax/getStatsInfo?surveyId=A002005212015`,
    `https://www.e-stat.go.jp/gis/statmap-search/ajax?toukeiCode=00200521&toukeiYear=2015&type=2`,
    // GISデータダウンロードページのHTMLを取得
    `https://www.e-stat.go.jp/gis/statmap-search?type=2&toukeiCode=00200521&toukeiYear=2015`,
    // stats IDリスト
    `https://www.e-stat.go.jp/gis/statmap-search/data?datatype=1&statsId=T000848&downloadType=1`,
];

for (const url of candidates) {
    console.log(`\n=== ${url.replace(PROXY, '')} ===`);
    try {
        const r = await fetch(`${PROXY}${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(15000) });
        console.log(`  Status: ${r.status}, Content-Type: ${r.headers.get('content-type')}`);
        const text = await r.text();
        // T000***パターンを抽出
        const tIds = [...new Set(text.match(/T\d{6}/g) || [])];
        if (tIds.length) {
            console.log(`  T-table IDs found: ${tIds.join(', ')}`);
        }
        // 家族・住宅キーワードを含む周辺テキストを抽出
        const keywords = ['家族類型', '住宅', '世帯構造', '建て方', '所有', 'statsId'];
        for (const kw of keywords) {
            const idx = text.indexOf(kw);
            if (idx !== -1) {
                console.log(`  [${kw}]: ...${text.slice(Math.max(0, idx-30), idx+80)}...`);
            }
        }
        // 最初の500文字
        if (!tIds.length) console.log(`  Preview: ${text.slice(0, 300)}`);
    } catch(err) {
        console.log(`  ERROR: ${err.message}`);
    }
    await new Promise(x => setTimeout(x, 500));
}
console.log('\n完了');
