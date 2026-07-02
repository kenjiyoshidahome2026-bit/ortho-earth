// 地震観測施設レイヤー（静的GeoPBF配信・独立モジュール）
// 出所は地震調査研究推進本部（地震本部）。高感度・広帯域・強震の観測点を統合。
// public/jishin/seismic.geopbf を自前fetch → geopbf(buffer) デコード → execGlobeView 描画。
// 生成は jishin/seismic-to-geopbf.mjs。
import { geopbf } from '../ui/gpbf.js';
import { execGlobeView } from '../ui/globe.js';

const SEISMIC_DS = {
    title: '地震観測施設',
    attributes: {
        uid: '突合ID', net: '観測網', name: '観測点名', romaji: 'ローマ字', code: 'コード',
        org: '保守管理機関', alt: '標高 (m)', depth: '観測の深さ', equip: '観測機種', start: '観測開始年',
    },
    codelist: {},
};

export function jishinSeismicSidebarEntry() {
    return { dataset_code: 'seismic', title: '地震観測施設（高感度・広帯域・強震）', file_count: 5268, license: '地震本部', _sourceId: 'jishin' };
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
