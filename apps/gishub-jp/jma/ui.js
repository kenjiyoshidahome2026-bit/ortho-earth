// 気象庁 アメダス観測所レイヤー（静的GeoPBF配信・独立モジュール）
// public/jma/amedas.geopbf を自前fetch → geopbf(buffer) でデコード（bucket不要）→
// 既存の execGlobeView で地図描画。生成は jma/amedas-to-geopbf.mjs。
import { geopbf } from '../ui/gpbf.js';
import { execGlobeView } from '../ui/globe.js';

// execGlobeView の tip/pop 用ラベル辞書。
// 種類は気象庁「地域気象観測所一覧」の正本（四/官/雨）＝bosai API の type（説明非公開）は使わない。
// 旧実装は type に要素名を貼っていて 1,286 件中およそ 761 件が誤表示だった（2026-09-23 に是正）。
const AMEDAS_DS = {
    title: '気象庁 アメダス観測所',
    attributes: {
        id: '観測所番号', name: '観測所名', kana: 'よみ', en: '英名', alt: '標高 (m)',
        kind: '種類', place: '所在地',
        start: '観測開始年', startRaw: '観測開始年月日（一覧の記載）',
        windH: '風速計の高さ (m)', tempH: '温度計の高さ (m)',
        elemNote: '備考（観測要素）', sites: '観測地点の数',
    },
    codelist: {
        kind: {
            '四': '四要素（降水量・風向風速・気温・湿度）',
            '官': '気象官署・特別地域気象観測所',
            '雨': '雨量',
        },
    },
};

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
