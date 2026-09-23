/**
 * 気象庁 アメダス観測所 → GeoJSON（canonical）＋ GeoPBF（描画用）
 *
 * 二つの出所を観測所番号で突合する（2026-09-23 に改めた）:
 *   ① 観測所テーブル  https://www.jma.go.jp/bosai/amedas/const/amedastable.json
 *      座標・名称・標高。lat/lon は [度, 分] → 十進度 = 度 + 分/60。
 *   ② 地域気象観測所一覧（公式・機械可読）https://www.jma.go.jp/jma/kishou/know/amedas/ame_master.zip
 *      種類（四/官/雨）・所在地・観測開始年月日・風速計/温度計の高さ・備考。
 *
 * ■ なぜ②を足したか：①の `type`（A/B/C/D/E/F/G）は**観測所の区分**であって観測要素ではない。
 *   これに要素名のラベル（A=四要素 / B=気温・降水等 / C=雨量）を貼っていたのは取り違えで、
 *   ②と突合すると A(56)・B(95) は全部「官」、C(1131) は「四687 / 官74 / 雨370」の混在だった＝
 *   1,286 件中およそ 761 件が誤った種別を表示していた。②の「種類」は気象庁が配る一次資料なので、
 *   推測せずこれを正とする。突合は観測所番号で 1,286/1,286＝100%。
 *
 * ■ 轍
 *   - ②は 1,316 行／観測所番号は 1,286 種＝**30 件は 1 つの番号に観測地点が 2 つ**ある
 *     （例：帯広＝気温・雨は東4条南、風・日照は東9条南。座標も別）。①の座標に近い行を主とし、
 *     備考を束ねて sites=2 を立てる。
 *   - 観測開始年月日の記号は公式 PDF にしか凡例が無く、`#`（520 行）の意味は未確認。
 *     `(昭50.5.29)昭52.10.24` は括弧が前の開始日。**解釈せず原文 startRaw を残し**、
 *     比較用に主たる日付の西暦年だけ start に出す。
 *   - ①の type / elems は気象庁が説明を公開していない内部表現＝canonical には残すが描画用からは落とす。
 *
 * 出力:
 *   jma/amedas.geojson         … canonical（type/elems も保持）
 *   public/jma/amedas.geopbf   … 描画用（PRECISION=7）
 *
 * node jma/amedas-to-geopbf.mjs
 */
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import AdmZip from 'adm-zip';
import { encodeGeoPBF } from '../scripts/geopbf-encode.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const TABLE_URL  = 'https://www.jma.go.jp/bosai/amedas/const/amedastable.json';
const MASTER_URL = 'https://www.jma.go.jp/jma/kishou/know/amedas/ame_master.zip';

// 元号→西暦（明治以降・n 年は base+(n-1)）
const ERA = { 明: 1868, 大: 1912, 昭: 1926, 平: 1989, 令: 2019 };
const dm2deg = ([d, m]) => +(d + m / 60).toFixed(7);
const txt = v => { const s = (v ?? '').trim(); return s && s !== '－' && s !== '-' ? s : null; };
const numOf = v => { const n = parseFloat(txt(v)); return Number.isFinite(n) ? n : null; };

// 「#昭50.4.1」「(昭50.5.29)昭52.10.24」→ 主たる日付の西暦年。括弧書き＝前の開始日は取らない
function startYear(raw) {
    const s = txt(raw); if (!s) return null;
    const main = s.replace(/^\(.*?\)/, '').replace(/^#/, '');   // 括弧書きを落とし、記号を外す
    const m = main.match(/([明大昭平令])\s*(\d+)/);
    if (!m) return null;
    const base = ERA[m[1]]; const n = parseInt(m[2], 10);
    return base && Number.isFinite(n) ? base + n - 1 : null;
}

function parseCsv(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const split = l => { const o = []; let c = '', q = false;
        for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; }
        o.push(c); return o; };
    const head = split(lines[0]);
    return lines.slice(1).map(l => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

async function fetchMaster() {
    const resp = await fetch(MASTER_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) throw new Error(`ame_master.zip: HTTP ${resp.status}`);
    const zip = new AdmZip(Buffer.from(await resp.arrayBuffer()));
    const entry = zip.getEntries().find(e => /\.csv$/i.test(e.entryName));
    if (!entry) throw new Error('ame_master.zip に CSV が無い');
    console.log(`  ${entry.entryName}`);
    return parseCsv(new TextDecoder('shift-jis').decode(entry.getData()));
}

async function main() {
    console.log('fetching amedastable.json …');
    const r1 = await fetch(TABLE_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60_000) });
    if (!r1.ok) throw new Error(`amedastable: HTTP ${r1.status}`);
    const table = await r1.json();

    console.log('fetching ame_master.zip …');
    const master = await fetchMaster();
    const byId = new Map();
    for (const r of master) {
        const k = (r['観測所番号'] || '').trim(); if (!k) continue;
        (byId.get(k) ?? byId.set(k, []).get(k)).push(r);
    }
    console.log(`  公式一覧 ${master.length} 行／観測所番号 ${byId.size} 種`);

    const features = [];
    let matched = 0, split2 = 0;
    for (const [id, s] of Object.entries(table)) {
        if (!Array.isArray(s.lat) || !Array.isArray(s.lon)) continue;
        const lon = dm2deg(s.lon), lat = dm2deg(s.lat);
        const cand = byId.get(id) || [];
        if (cand.length) matched++;
        // 1 番号に 2 地点ある時は①の座標に近い行を主とする（所在地・計器高はその行のもの）
        const main = cand.length > 1
            ? cand.slice().sort((a, b) =>
                Math.hypot(dm2deg([+a['緯度(度)'], +a['緯度(分)']]) - lat, dm2deg([+a['経度(度)'], +a['経度(分)']]) - lon) -
                Math.hypot(dm2deg([+b['緯度(度)'], +b['緯度(分)']]) - lat, dm2deg([+b['経度(度)'], +b['経度(分)']]) - lon))[0]
            : cand[0];
        if (cand.length > 1) split2++;
        const note = [...new Set(cand.map(r => txt(r['備考2'])).filter(Boolean))].join(' ／ ') || null;
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
                id,
                name: s.kjName || id,
                kana: s.knName || null,
                en:   s.enName || null,
                alt:  typeof s.alt === 'number' ? s.alt : null,
                kind:  main ? txt(main['種類']) : null,          // 四 / 官 / 雨（公式・codelist で開く）
                place: main ? txt(main['所在地']) : null,
                start: main ? startYear(main['観測開始年月日']) : null,
                startRaw: main ? txt(main['観測開始年月日']) : null,
                windH: main ? numOf(main['風速計の高さ(ｍ)']) : null,
                tempH: main ? numOf(main['温度計の高さ(ｍ)']) : null,
                elemNote: note,                                   // 備考2＝観測要素の例外
                sites: cand.length > 1 ? cand.length : null,      // 1 番号に観測地点が複数
                type: s.type || null,                             // ①の区分コード（説明非公開）＝canonical のみ
                elems: s.elems || null,                           // ①の要素ビット（説明非公開）＝canonical のみ
            },
        });
    }
    features.sort((a, b) => a.properties.id.localeCompare(b.properties.id));

    const geojson = { type: 'FeatureCollection', features };
    writeFileSync(join(__dir, 'amedas.geojson'), JSON.stringify(geojson));

    // 描画用は説明が公開されていない内部表現を落とす（canonical が正本）
    const drawn = features.map(f => { const { type, elems, ...rest } = f.properties; return { ...f, properties: rest }; });
    const raw = encodeGeoPBF(drawn, {
        name: 'amedas',
        description: '気象庁 アメダス観測所（地域気象観測所一覧と突合）',
        license: '出典の明示等（気象庁ホームページ利用規約）',
        attribution: '気象庁 アメダス・地域気象観測所一覧',
    });
    mkdirSync(join(__dir, '../public/jma'), { recursive: true });
    writeFileSync(join(__dir, '../public/jma/amedas.geopbf'), raw);

    const kinds = {};
    for (const f of features) kinds[f.properties.kind ?? '（一覧に無い）'] = (kinds[f.properties.kind ?? '（一覧に無い）'] || 0) + 1;
    console.log(`観測所: ${features.length}（公式一覧と突合 ${matched}／観測地点が複数 ${split2}）`);
    console.log('種類:', kinds);
    console.log(`GeoJSON: jma/amedas.geojson (${(Buffer.byteLength(JSON.stringify(geojson))/1024).toFixed(0)} KB)`);
    console.log(`GeoPBF : public/jma/amedas.geopbf (${(raw.length/1024).toFixed(0)} KB)`);
    console.log('例:', JSON.stringify(features[0].properties));
}

main().catch(e => { console.error(e); process.exit(1); });
