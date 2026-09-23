// 地震観測施設レイヤー（静的GeoPBF配信・独立モジュール）
// 出所は地震調査研究推進本部（地震本部）。11 観測網（地震計・GNSS・重力・電磁気・海底・歪・検潮・地下水）を統合し、
// 2013〜2026 年版を重ね合わせて「掲載初年／最終年」を持たせてある（最終年が最新でない点＝その後の版から消えた観測点）。
// public/jishin/seismic.geopbf を自前fetch → geopbf(buffer) デコード → execGlobeView 描画。
// 生成は jishin/seismic-to-geopbf.mjs。突合の正本は jishin/seismic.geojson（uid を持つ）。
import { geopbf } from '../ui/gpbf.js';
import { execGlobeView } from '../ui/globe.js';

const LATEST = 2026;

// 観測網＝生成側 NETS の tag と対。GeoPBF は符号で持ち、名前はここで開く
const NET = {
    HS: '高感度地震計', BB: '広帯域地震計', SG: '強震計（地上）', SU: '強震計（地下）',
    GN: 'GNSS・SLR・VLBI', GV: '重力', MG: '地球電磁気', SF: '海底地殻変動',
    ST: '歪計・傾斜計等', TS: '検潮・津波', WA: '地下水観測井',
};

const SEISMIC_DS = {
    title: '地震観測施設',
    attributes: {
        net: '観測網', kind: '観測の種類', name: '観測点名', alias: '旧名称', romaji: 'ローマ字', code: 'コード',
        org: '保守管理機関', alt: '標高 (m)', depth: '観測の深さ (m)', equip: '観測機種',
        start: '観測開始年', first: '掲載初年', last: '掲載最終年',
    },
    codelist: { net: NET },
};

export function jishinSeismicSidebarEntry() {
    return {
        dataset_code: 'seismic',
        title: `地震観測施設（11観測網・2013〜${LATEST}年版）`,
        file_count: 9276,
        license: '地震本部',
        _sourceId: 'jishin',
    };
}

let _pbf = null;
export async function showSeismic() {
    if (!_pbf) {
        const res = await fetch(`${import.meta.env.BASE_URL}jishin/seismic.geopbf`);
        if (!res.ok) throw new Error(`seismic.geopbf HTTP ${res.status}`);
        _pbf = await geopbf(await res.arrayBuffer(), { name: 'seismic' });
    }
    execGlobeView(_pbf, SEISMIC_DS);
}

// ── 震源断層モデル 上端トレース（全国地震動予測地図 2009年版 別冊2）─────────────
// 活断層のトレース（実測の断層線）ではなく、地震動計算のために置いた矩形断層面の上端辺。
// 地震本部サイトが自前で配っている唯一のジオメトリ源。生成は jishin/fault-to-geopbf.mjs。
const FAULT_DS = {
    title: '震源断層モデル（2009年版）',
    attributes: {
        no: '断層番号', band: '断層帯名', fault: '起震断層名', seg: '区間名',
        mjma: '気象庁マグニチュード', mw: 'モーメントマグニチュード',
        len: 'モデル長さ (km)', width: 'モデル幅 (km)', area: 'モデル面積 (km²)', top: '上端深さ (km)',
        strike: '走向 (N°E)', dip: '傾斜 (°)', rake: 'すべり角 (°)', slip: '平均すべり量 (m)',
        chained: '直前の区間から連結',
    },
    codelist: {},
};

export function jishinFaultSidebarEntry() {
    return {
        dataset_code: 'fault',
        title: '震源断層モデル（全国地震動予測地図 2009年版）',
        file_count: 231,
        license: '地震本部',
        _sourceId: 'jishin',
    };
}

let _fault = null;
export async function showFault() {
    if (!_fault) {
        const res = await fetch(`${import.meta.env.BASE_URL}jishin/fault.geopbf`);
        if (!res.ok) throw new Error(`fault.geopbf HTTP ${res.status}`);
        _fault = await geopbf(await res.arrayBuffer(), { name: 'fault' });
    }
    execGlobeView(_fault, FAULT_DS);
}
