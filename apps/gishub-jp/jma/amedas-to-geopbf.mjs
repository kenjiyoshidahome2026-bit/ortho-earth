/**
 * 気象庁 アメダス観測所テーブル → GeoJSON（canonical）＋ GeoPBF（描画用）
 *
 * 観測値JSONには座標が無いため、観測所マスタ amedastable.json で位置を補足する。
 *   座標: lat/lon は [度, 分] → 十進度 = 度 + 分/60
 *   属性: id, name(kjName), kana(knName), en(enName), alt(標高m), type(種別), elems(要素ビット)
 *
 * 出力:
 *   jma/amedas.geojson         … 人が読めるcanonical（検証・再利用用）
 *   public/jma/amedas.geopbf   … アプリ描画用（PRECISION=7）
 *
 * node jma/amedas-to-geopbf.mjs
 */
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { encodeGeoPBF } from '../scripts/geopbf-encode.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const TABLE_URL = 'https://www.jma.go.jp/bosai/amedas/const/amedastable.json';

// 種別ラベル（確実なものだけ。不明は raw を保持）
const TYPE_LABEL = { A: '四要素', B: '気温・降水等', C: '雨量' };

// ── 変換 ─────────────────────────────────────────────────────────────────────
const dm2deg = ([d, m]) => +(d + m / 60).toFixed(7);

async function main() {
    console.log('fetching amedastable.json …');
    const resp = await fetch(TABLE_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const table = await resp.json();

    const features = [];
    for (const [id, s] of Object.entries(table)) {
        if (!Array.isArray(s.lat) || !Array.isArray(s.lon)) continue;
        const lon = dm2deg(s.lon), lat = dm2deg(s.lat);
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
                id,
                name: s.kjName || id,
                kana: s.knName || '',
                en:   s.enName || '',
                alt:  typeof s.alt === 'number' ? s.alt : null,
                type: s.type || '',
                kind: TYPE_LABEL[s.type] || s.type || '',
                elems: s.elems || '',
            },
        });
    }
    features.sort((a, b) => a.properties.id.localeCompare(b.properties.id));

    // canonical GeoJSON
    const geojson = { type: 'FeatureCollection', features };
    writeFileSync(join(__dir, 'amedas.geojson'), JSON.stringify(geojson));

    // GeoPBF
    const raw = encodeGeoPBF(features, {
        name: 'amedas',
        description: '気象庁 アメダス観測所',
        license: '出典の明示等（気象庁ホームページ利用規約）',
        attribution: '気象庁 アメダス',
    });
    mkdirSync(join(__dir, '../public/jma'), { recursive: true });
    writeFileSync(join(__dir, '../public/jma/amedas.geopbf'), raw);

    const kinds = {};
    for (const f of features) kinds[f.properties.kind] = (kinds[f.properties.kind] || 0) + 1;
    console.log(`観測所: ${features.length}`);
    console.log('種別:', kinds);
    console.log(`GeoJSON: jma/amedas.geojson (${(Buffer.byteLength(JSON.stringify(geojson))/1024).toFixed(0)} KB)`);
    console.log(`GeoPBF : public/jma/amedas.geopbf (${(raw.length/1024).toFixed(0)} KB)`);
    console.log('例:', JSON.stringify(features[0].properties), features[0].geometry.coordinates);
}

main().catch(e => { console.error(e); process.exit(1); });
