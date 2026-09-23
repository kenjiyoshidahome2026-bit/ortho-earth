/**
 * 地震観測施設（地震調査研究推進本部 地震本部）→ GeoJSON（canonical）＋ GeoPBF（描画用）
 *
 * 地震本部が毎年（9月頃）公表する「観測施設」CSV 11 種を、年版をまたいで重ね合わせる。
 * 緯度経度は既に十進度（世界測地系）。2025 年版まで Shift-JIS・2026 年版は UTF-8(BOM)。
 * 列: 0種類 1名称 2ローマ字 3コード 4緯度 5経度 6標高 7深さ 8保守機関 9機関英 10開始年 11月 12機種
 *
 * ■ 年版の重ね合わせ＝同じ観測点を突合して「掲載初年 first / 掲載最終年 last」を持たせる。
 *   last が最新年でない点＝その後の版から消えた観測点。11 種が揃うのは 2013 年版から。
 *
 * ■ 突合キーは 観測網:コード:名称（同じ年に同じキーが並ぶ＝1 地点の複数計器は #n で分ける）。
 *   キーに入れてはいけないもの（実データで確認済み・2026-09-23）:
 *     - 維持管理機関：DONET が 2016 年版で海洋研究開発機構→防災科学技術研究所へ移管。
 *       機関を入れると同一観測点が「2015 に消滅・2016 に新設」と二重化する。
 *     - 座標：2022→2023 年版で一斉に測り直されており 9,592 キー中 1,828 キーが動く。
 *       座標を入れると偽の消滅が約 1,800 件出る。
 *   代わりに、コードが同じまま名称だけ変わり年が隣接する組（「御前崎観測点」→「御前崎」等）は
 *   改名として縫い合わせる（312 組）。旧名は alias に残す。
 *
 * 出力:
 *   jishin/seismic.geojson         … canonical（uid・alias つき＝突合の正本）
 *   public/jishin/seismic.geopbf   … 描画用（PRECISION=7・uid を落とし net は符号）
 *
 * node jishin/seismic-to-geopbf.mjs [最新年] [起点年]   … 既定 2026 2013（単年にするなら同じ年を 2 つ）
 */
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { encodeGeoPBF } from '../scripts/geopbf-encode.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const LATEST = +(process.argv[2] || 2026);
const FROM   = +(process.argv[3] || 2013);   // 11 種が揃う最初の年版（2012 以前は gnss が無い）
const RENAME_MAX_M = 1000;                   // 改名として縫う上限距離
const url = (file, y) => `https://www.jishin.go.jp/main/kansoku/kansoku${String(y).slice(2)}/csv/${file}_${y}.csv`;

// tag＝突合キーの前置（観測網ごとに独立した名前空間）。net＝CSV 1 本の見出し
const NETS = [
    { file: 'high_sens', net: '高感度地震計',        tag: 'HS' },
    { file: 'broad',     net: '広帯域地震計',        tag: 'BB' },
    { file: 'strong_og', net: '強震計（地上）',      tag: 'SG' },
    { file: 'strong_ug', net: '強震計（地下）',      tag: 'SU' },
    { file: 'gnss',      net: 'GNSS・SLR・VLBI',     tag: 'GN' },
    { file: 'gravity',   net: '重力',                tag: 'GV' },
    { file: 'magne',     net: '地球電磁気',          tag: 'MG' },
    { file: 'sgs',       net: '海底地殻変動',        tag: 'SF' },
    { file: 'strain',    net: '歪計・傾斜計等',      tag: 'ST' },
    { file: 'tsunami',   net: '検潮・津波',          tag: 'TS' },
    { file: 'water',     net: '地下水観測井',        tag: 'WA' },
];
const TAG_OF = Object.fromEntries(NETS.map(n => [n.net, n.tag]));

function parseLine(l) {
    const out = []; let cur = '', q = false;
    for (const ch of l) {
        if (ch === '"') q = !q;
        else if (ch === ',' && !q) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur); return out;
}

async function fetchCsv(file, year) {
    const resp = await fetch(url(file, year), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) throw new Error(`${file}_${year}: HTTP ${resp.status}`);
    // 2025 年版までは Shift-JIS・2026 年版は UTF-8（BOM 付き）＝UTF-8 として厳格に読めなければ Shift-JIS
    const buf = new Uint8Array(await resp.arrayBuffer());
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }   // BOM は既定で落ちる
    catch { return new TextDecoder('shift-jis').decode(buf); }
}

const txt = v => (v || '').trim() || null;
const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const metersBetween = (a, b) => Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos(a.lat * Math.PI / 180)) * 111_320;

// CSV 1 本を読んで行の配列に均す（緯度経度が日本の範囲に無い行＝見出し・注記は落ちる）
function rowsOf(text, net, tag) {
    const out = [];
    for (const c of text.split(/\r?\n/).map(parseLine)) {
        const lat = parseFloat(c[4]), lon = parseFloat(c[5]);
        if (!isFinite(lat) || !isFinite(lon) || lon < 121 || lon > 156 || lat < 19 || lat > 47) continue;
        out.push({
            lat, lon, net, tag,
            kind:   txt(c[0]),   // 観測の種類（微小地震 / GPS / 験潮 / 海底基準局 …）＝net より細かい
            name:   txt(c[1]),
            romaji: txt(c[2]),
            code:   txt(c[3]),
            alt:    num(c[6]),
            depth:  txt(c[7]),
            org:    txt(c[8]),
            start:  num(c[10]),
            equip:  txt(c[12]),
        });
    }
    return out;
}

// 年版を古い順に重ねる。内容は新しい年版で上書き（現況を正とする）・first だけ最初の値を守る
async function accumulate(years) {
    const U = new Map();
    for (const y of years) {
        const seen = new Map();
        let n = 0;
        const texts = await Promise.all(NETS.map(({ file }) => fetchCsv(file, y)));
        texts.forEach((text, i) => {
            for (const r of rowsOf(text, NETS[i].net, NETS[i].tag)) {
                const base = `${r.tag}:${r.code || ''}:${r.name || ''}`;
                const seq = (seen.get(base) || 0) + 1;
                seen.set(base, seq);
                const uid = seq > 1 ? `${base}#${seq}` : base;
                const prev = U.get(uid);
                U.set(uid, { ...r, uid, seq, first: prev ? prev.first : y, last: y, alias: prev?.alias ?? null });
                n++;
            }
        });
        console.log(`  ${y}年版: ${n}`);
    }
    return U;
}

// 年の境目の縫い合わせ。地震本部の CSV は年版ごとに作られるので、同じ観測点が
// 「名称が変わった」「コードが後から付いた」だけで別行に見えることがある。実データの 2 型（2026-09-23 確認）:
//   改名        ： SG:OMZ 「御前崎観測点」(-2013) → 「御前崎」(2014-)          ＝コード同じ・名称が変わる
//   コード後付け： BB 「DONET2 A1 広帯域」 コード無し(-2015) → MRA01.HH(2016-) ＝名称同じ・コードが付く
// どちらも「Y 年版で終わる点」と「Y+1 年版で始まる点」の間だけを見て、同じ観測網・同じ連番・
// 1km 以内・（コードが一致 または 名称が一致）なら同一点として畳む。古い側の名称は alias に残す。
// 年を古い順に処理するので A→B→C の連鎖も順に畳まれる。
function stitchAcrossYears(U, years) {
    let merged = 0;
    for (let i = 0; i < years.length - 1; i++) {
        const y = years[i];
        const ends = [], begins = [];
        for (const e of U.values()) {
            if (e.last === y) ends.push(e);
            else if (e.first === y + 1) begins.push(e);
        }
        if (!ends.length || !begins.length) continue;
        const taken = new Set();
        for (const a of ends) {
            let best = null, bestD = Infinity;
            for (const b of begins) {
                if (taken.has(b.uid) || b.tag !== a.tag || b.seq !== a.seq) continue;
                const sameCode = a.code && b.code && a.code === b.code;
                const sameName = a.name && b.name && a.name === b.name;
                if (!sameCode && !sameName) continue;
                const d = metersBetween(a, b);
                if (d <= RENAME_MAX_M && d < bestD) { best = b; bestD = d; }
            }
            if (!best) continue;
            taken.add(best.uid);
            best.first = a.first;                                       // 新しい側へ歴史を引き継ぐ
            if (best.name !== a.name) best.alias = [a.alias, a.name].filter(Boolean).join(' / ');
            else if (a.alias) best.alias = a.alias;
            U.delete(a.uid);
            merged++;
        }
    }
    return merged;
}

async function main() {
    const years = []; for (let y = FROM; y <= LATEST; y++) years.push(y);
    const U = await accumulate(years);
    const rawCount = U.size;
    const merged = stitchAcrossYears(U, years);
    console.log(`年の境目で縫った組: ${merged}（のべ ${rawCount} → ${U.size}）`);

    const features = [...U.values()]
        .sort((a, b) => a.uid.localeCompare(b.uid))
        .map(r => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [+r.lon.toFixed(7), +r.lat.toFixed(7)] },
            properties: {
                uid: r.uid, net: r.net, kind: r.kind, name: r.name, alias: r.alias, romaji: r.romaji, code: r.code,
                org: r.org, alt: r.alt, depth: r.depth, equip: r.equip, start: r.start,
                first: r.first, last: r.last,
            },
        }));

    const geojson = { type: 'FeatureCollection', features };
    writeFileSync(join(__dir, 'seismic.geojson'), JSON.stringify(geojson));

    // 描画用は uid を落とす＝uid は tag/code/name を継いだだけの合成キーで、同じ中身を 2 度持つ（全点固有＝生の約 2 割）。
    // 突合の正本は上の GeoJSON。net は符号（HS/GN/SF…）で持ち、名前は UI 側の凡例（codelist）で開く。
    const drawn = features.map(f => {
        const { uid, net, ...rest } = f.properties;
        return { ...f, properties: { ...rest, net: TAG_OF[net] } };
    });
    const raw = encodeGeoPBF(drawn, {
        name: 'seismic',
        description: `地震観測施設（11 観測網・${FROM}〜${LATEST}年版の重ね合わせ）`,
        license: '地震調査研究推進本部',
        attribution: '地震調査研究推進本部（地震本部）',
    });
    mkdirSync(join(__dir, '../public/jishin'), { recursive: true });
    writeFileSync(join(__dir, '../public/jishin/seismic.geopbf'), raw);

    const live = features.filter(f => f.properties.last === LATEST).length;
    const perNet = {};
    for (const f of features) perNet[f.properties.net] = (perNet[f.properties.net] || 0) + 1;
    console.log(`のべ観測点: ${features.length}（${LATEST}年版に現存 ${live} / 掲載終了 ${features.length - live} / ${FROM}年版より後の新設 ${features.filter(f => f.properties.first > FROM).length}）`);
    console.log('観測網:', perNet);
    console.log(`GeoJSON: jishin/seismic.geojson (${(Buffer.byteLength(JSON.stringify(geojson))/1024).toFixed(0)} KB)`);
    console.log(`GeoPBF : public/jishin/seismic.geopbf (${(raw.length/1024).toFixed(0)} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
