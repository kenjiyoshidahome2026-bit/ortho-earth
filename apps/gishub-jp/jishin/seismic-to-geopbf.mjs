/**
 * 地震観測施設（地震調査研究推進本部 地震本部）→ GeoJSON（canonical）＋ GeoPBF（描画用）
 *
 * 4種の地震計観測点CSV（Shift-JIS）を統合する。緯度経度は既に十進度（世界測地系）。
 *   high_sens=高感度 / broad=広帯域 / strong_og=強震(地上) / strong_ug=強震(地下)
 * 列: 0種類 1名称 2ローマ字 3コード 4緯度 5経度 6標高 7深さ 8保守機関 9機関英 10開始年 11月 12機種
 *
 * 出力:
 *   jishin/seismic.geojson         … canonical
 *   public/jishin/seismic.geopbf   … 描画用（PRECISION=7）
 *
 * node jishin/seismic-to-geopbf.mjs
 */
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { encodeGeoPBF } from '../scripts/geopbf-encode.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://www.jishin.go.jp/main/kansoku/kansoku25/csv';
const NETS = [
    { file: 'high_sens', net: '高感度',     tag: 'HS' },
    { file: 'broad',     net: '広帯域',     tag: 'BB' },
    { file: 'strong_og', net: '強震(地上)', tag: 'SG' },
    { file: 'strong_ug', net: '強震(地下)', tag: 'SU' },
];

function parseLine(l) {
    const out = []; let cur = '', q = false;
    for (const ch of l) {
        if (ch === '"') q = !q;
        else if (ch === ',' && !q) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur); return out;
}

async function fetchCsv(file) {
    const resp = await fetch(`${BASE}/${file}_2025.csv`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) throw new Error(`${file}: HTTP ${resp.status}`);
    return new TextDecoder('shift-jis').decode(new Uint8Array(await resp.arrayBuffer()));
}

async function main() {
    const features = [];
    const perNet = {};
    const uidSeen = new Map();   // 突合キーの行一意化（衝突時に #2, #3 …）
    for (const { file, net, tag } of NETS) {
        console.log(`fetching ${file}_2025.csv …`);
        const rows = (await fetchCsv(file)).split(/\r?\n/).map(parseLine);
        let n = 0;
        for (const c of rows) {
            const lat = parseFloat(c[4]), lon = parseFloat(c[5]);
            if (!isFinite(lat) || !isFinite(lon) || lon < 122 || lon > 154 || lat < 20 || lat > 46) continue;
            const alt = parseInt(c[6], 10);
            const start = parseInt(c[10], 10);
            const code   = (c[3] || '').trim();
            const romaji = (c[2] || '').trim();
            // 突合キー: 公式コード優先、無ければローマ字。網タグで前置し行一意に（#nで衝突回避）
            const base = `${tag}:${code || romaji || 'NA'}`;
            const seq = (uidSeen.get(base) || 0) + 1; uidSeen.set(base, seq);
            const uid = seq === 1 ? base : `${base}#${seq}`;
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [+lon.toFixed(7), +lat.toFixed(7)] },
                properties: {
                    uid, net,
                    name:  (c[1] || '').trim(),
                    romaji: romaji || null,
                    code:  code || null,
                    org:   (c[8] || '').trim(),
                    alt:   Number.isFinite(alt) ? alt : null,
                    depth: (c[7] || '').trim() || null,
                    equip: (c[12] || '').trim() || null,
                    start: Number.isFinite(start) ? start : null,
                },
            });
            n++;
        }
        perNet[net] = n;
    }
    features.sort((a, b) => a.properties.uid.localeCompare(b.properties.uid));

    const geojson = { type: 'FeatureCollection', features };
    writeFileSync(join(__dir, 'seismic.geojson'), JSON.stringify(geojson));

    const raw = encodeGeoPBF(features, {
        name: 'seismic',
        description: '地震観測施設（高感度・広帯域・強震）',
        license: '地震調査研究推進本部',
        attribution: '地震調査研究推進本部（地震本部）',
    });
    mkdirSync(join(__dir, '../public/jishin'), { recursive: true });
    writeFileSync(join(__dir, '../public/jishin/seismic.geopbf'), raw);

    console.log(`観測点: ${features.length}`);
    console.log('種別:', perNet);
    console.log(`GeoJSON: jishin/seismic.geojson (${(Buffer.byteLength(JSON.stringify(geojson))/1024).toFixed(0)} KB)`);
    console.log(`GeoPBF : public/jishin/seismic.geopbf (${(raw.length/1024).toFixed(0)} KB)`);
    console.log('例:', JSON.stringify(features[0].properties), features[0].geometry.coordinates);
}

main().catch(e => { console.error(e); process.exit(1); });
