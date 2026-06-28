// e-Stat GIS downloadType=2 で取得した小地域統計データの解析とピラミッド描画
// T001081: 人口総数・男女別
// T001082: 年齢5歳階級別人口（男女各16グループ）

const GIS_STATS_BASE = 'https://www.e-stat.go.jp/gis/statmap-search/data';

// ---- ZIP 解凍 ---------------------------------------------------------------

export async function unzipFirstEntry(blob) {
    const buf = await blob.arrayBuffer();
    const u8  = new Uint8Array(buf);
    const v   = new DataView(buf);
    if (v.getUint32(0, true) !== 0x04034b50) throw new Error('Not a ZIP');
    const method = v.getUint16(8, true);
    const fnLen  = v.getUint16(26, true);
    const exLen  = v.getUint16(28, true);
    const start  = 30 + fnLen + exLen;
    let comp = v.getUint32(18, true);
    if (comp === 0) {
        for (let i = start + 4; i < u8.length - 4; i++) {
            const sig = v.getUint32(i, true);
            if (sig === 0x02014b50 || sig === 0x04034b50 || sig === 0x08074b50) { comp = i - start; break; }
        }
    }
    const slice = u8.subarray(start, start + comp);
    if (method === 0) return slice;
    if (method === 8) return new Uint8Array(
        await new Response(new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()
    );
    throw new Error(`ZIP method ${method}`);
}

// ---- CSV フェッチ ------------------------------------------------------------

// e-Stat は都道府県単位でしか受け付けないので prefCode = cityCode.substring(0, 2)
export async function fetchGisStatsCsv(prefCode, statsId, apiBase) {
    const url  = `${GIS_STATS_BASE}?statsId=${statsId}&downloadType=2&code=${prefCode}`;
    const resp = await fetch(`${apiBase}/proxy/?url=${encodeURIComponent(url)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = await unzipFirstEntry(await resp.blob());
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('shift-jis').decode(bytes); }
    return text.split(/\r?\n/).map(l => l.split(',').map(s => s.replace(/^"|"$/g, '')));
}

// ---- 統計データ取得 ----------------------------------------------------------

// T001081: col 7=総人口, 8=男, 9=女
export async function fetchSmallAreaPop(cityCode, apiBase) {
    const rows = await fetchGisStatsCsv(cityCode.substring(0, 2), 'T001081', apiBase);
    const map  = new Map();
    for (const t of rows) {
        const code = String(t[0] || '');
        if (code.length <= 5 || !code.startsWith(cityCode)) continue;
        map.set(code, { total: +t[7] || 0, m: +t[8] || 0, f: +t[9] || 0 });
    }
    return map;
}

// T001082: 男 col 28-42 + 46 = 16グループ、女 col 48-62 + 66
export async function fetchSmallAreaPyramid(cityCode, apiBase) {
    const rows = await fetchGisStatsCsv(cityCode.substring(0, 2), 'T001082', apiBase);
    const map  = new Map();
    for (const t of rows) {
        const code = String(t[0] || '');
        if (code.length <= 5 || !code.startsWith(cityCode)) continue;
        const clean = a => a.map(v => +v || 0);
        map.set(code, {
            mAges: clean([...t.slice(28, 43), t[46]]),
            fAges: clean([...t.slice(48, 63), t[66]]),
        });
    }
    return map;
}

// ---- SVG 描画 ---------------------------------------------------------------

// 横並び人口ピラミッド（最大 16バー × 2）
export function smallAreaPyramidSvg(mAges, fAges) {
    const labels = ['0','5','10','15','20','25','30','35','40','45','50','55','60','65','70','75+'];
    const total  = [...mAges, ...fAges].reduce((s, v) => s + v, 0);
    if (!total) return '<span style="color:#666;font-size:11px">データなし</span>';
    const max  = Math.max(...mAges, ...fAges);
    const bW = 52, bH = 8, gap = 1, lblW = 22;
    const W  = bW * 2 + lblW;
    const H  = (bH + gap) * 16 + 14;
    const bars = [...mAges].reverse().map((m, i) => {
        const fi = 15 - i;
        const f  = fAges[fi];
        const mw = max ? (m / max * bW).toFixed(1) : 0;
        const fw = max ? (f / max * bW).toFixed(1) : 0;
        const y  = i * (bH + gap);
        const lbl = i % 2 === 0
            ? `<text x="${bW + lblW / 2}" y="${y + bH - 1}" text-anchor="middle" font-size="5.5" fill="#888">${labels[fi]}</text>`
            : '';
        return `<rect x="${bW - mw}" y="${y}" width="${mw}" height="${bH}" fill="#68b" opacity=".85"/>` +
               `<rect x="${bW + lblW}" y="${y}" width="${fw}" height="${bH}" fill="#c6a" opacity=".85"/>` +
               lbl;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="display:block">` +
        `<text x="${bW / 2}" y="${H - 2}" text-anchor="middle" font-size="6.5" fill="#68b">男</text>` +
        `<text x="${bW + lblW + bW / 2}" y="${H - 2}" text-anchor="middle" font-size="6.5" fill="#c6a">女</text>` +
        bars + '</svg>';
}

// 年齢3区分ミニバー（0-14:緑 / 15-64:青 / 65+:橙）
export function miniAgeBar(mAges, fAges) {
    if (!mAges?.length) return '';
    const all   = mAges.map((m, i) => m + fAges[i]);
    const total = all.reduce((s, v) => s + v, 0);
    if (!total) return '';
    const young = all.slice(0, 3).reduce((s, v) => s + v, 0);
    const work  = all.slice(3, 13).reduce((s, v) => s + v, 0);
    const old   = all.slice(13).reduce((s, v) => s + v, 0);
    const W  = 60;
    const yw = (young / total * W).toFixed(1);
    const ww = (work  / total * W).toFixed(1);
    const ow = (old   / total * W).toFixed(1);
    return `<svg width="${W}" height="8" style="vertical-align:middle;border-radius:2px;overflow:hidden">` +
        `<rect x="0" y="0" width="${yw}" height="8" fill="#5a9"/>` +
        `<rect x="${yw}" y="0" width="${ww}" height="8" fill="#579"/>` +
        `<rect x="${+yw + +ww}" y="0" width="${ow}" height="8" fill="#a65"/>` +
        '</svg>';
}
