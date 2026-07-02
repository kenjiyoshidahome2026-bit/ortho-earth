// 気象庁 アメダス観測所レイヤー（静的GeoPBF配信・独立モジュール）
// public/jma/amedas.geopbf を自前fetch → geopbf(buffer) でデコード（bucket不要）→
// 既存の execGlobeView で地図描画。生成は jma/amedas-to-geopbf.mjs。
import { geopbf } from '../ui/gpbf.js';
import { execGlobeView } from '../ui/globe.js';

// execGlobeView の tip/pop 用ラベル辞書
const AMEDAS_DS = {
    title: '気象庁 アメダス観測所',
    attributes: {
        name: '観測所名', kana: 'よみ', en: '英名', alt: '標高 (m)',
        kind: '種別', type: '種別コード', id: '観測所番号', elems: '観測要素ビット',
    },
    codelist: {},
};

export function jmaAmedasSidebarEntry() {
    return { dataset_code: 'amedas', title: '気象庁 アメダス観測所', file_count: 1286, license: '気象庁', _sourceId: 'jma' };
}

let _pbf = null;
export async function showAmedas() {
    if (!_pbf) {
        const res = await fetch(`${import.meta.env.BASE_URL}jma/amedas.geopbf`);
        if (!res.ok) throw new Error(`amedas.geopbf HTTP ${res.status}`);
        // ArrayBuffer を渡すとサーバ(bucket)を介さず直接デコードされる（geopbf の isBuffer 分岐）
        _pbf = await geopbf(await res.arrayBuffer(), { name: 'amedas' });
    }
    execGlobeView(_pbf, AMEDAS_DS);
}
