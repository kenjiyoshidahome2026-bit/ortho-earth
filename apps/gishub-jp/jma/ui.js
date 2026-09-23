// 気象庁 アメダス観測所レイヤー（静的GeoPBF配信・独立モジュール）
// public/jma/amedas.geopbf を自前fetch → geopbf(buffer) でデコード（bucket不要）→
// 既存の execGlobeView で地図描画。生成は jma/amedas-to-geopbf.mjs。
import { geopbf } from '../ui/gpbf.js';
import { execGlobeView } from '../ui/globe.js';

// 種類＝**観測装置の種類**（公式 PDF「地域気象観測所一覧」(3) の略字表・2026-09-23 確認）。
// bosai API の type（A/B/C…＝説明非公開）は使わない。旧実装はそこに要素名を貼っていて
// 1,286 件中およそ 761 件が誤表示だった。三/雪 は現データに出ないが凡例表にあるので入れておく。
const KIND = {
    '四': '有線ロボット気象計（降水量・気温・風向風速・湿度）',
    '三': '有線ロボット気象計（降水量・気温・風向風速）',
    '官': '地上気象観測装置（＋日照・湿度・気圧・積雪）',
    '雨': '有線ロボット雨量計（降水量）',
    '雪': '有線ロボット積雪深計（積雪の深さ）',
};

const AMEDAS_DS = {
    title: '気象庁 アメダス観測所',
    attributes: {
        id: '観測所番号', name: '観測所名', kana: 'よみ', en: '英名', alt: '標高 (m)',
        kind: '種類（観測装置）', place: '所在地',
        start: '降水量の観測開始年', startMet: '気温・風等の観測開始年',
        startRaw: '観測開始年月日（一覧の記載）', snowId: '積雪観測所の番号（同一敷地）',
        windH: '風速計の高さ (m)', tempH: '温度計の高さ (m)',
        elemNote: '備考（観測要素）', sites: '観測地点の数',
    },
    codelist: { kind: KIND },
};

// 観測装置で塗り分ける（裁定 2026-09-23）。色は 3 分類を全ペアで検定した組（CVD ΔE 11.6・
// 明るい地形の上でコントラスト 3:1 以上）。測る要素が多いものほど大きく＝色だけに頼らない。
const C_KIND = { '四': '#E8601C', '官': '#6A3D9A', '雨': '#2E7FBF' };
const AMEDAS_PAINT = {
    'circle-color':  ['match', ['get', 'kind'], '官', C_KIND['官'], '雨', C_KIND['雨'], C_KIND['四']],
    'circle-radius': ['match', ['get', 'kind'], '官', 2.0, '雨', 1.2, 1.6],
};
const _dot = (c, r, label) =>
    `<div style="display:flex;align-items:center;gap:6px;font-size:11px;line-height:1.7">`
    + `<span style="width:14px;display:inline-flex;justify-content:center">`
    + `<span style="width:${r * 2}px;height:${r * 2}px;border-radius:50%;background:${c};display:inline-block"></span></span>`
    + `${label}</div>`;
const AMEDAS_LEGEND =
    `<div style="font-size:12px;font-weight:600;margin-bottom:4px">アメダス観測所（観測装置）</div>`
    + _dot(C_KIND['官'], 5, '地上気象観測装置 228')
    + _dot(C_KIND['四'], 4, '有線ロボット気象計 688')
    + _dot(C_KIND['雨'], 3, '有線ロボット雨量計 370')
    + `<div style="font-size:10px;opacity:.7;margin-top:4px;max-width:180px">気象庁「地域気象観測所一覧」の種類</div>`;

let _pbf = null;
export async function showAmedas() {
    if (!_pbf) {
        const res = await fetch(`${import.meta.env.BASE_URL}jma/amedas.geopbf`);
        if (!res.ok) throw new Error(`amedas.geopbf HTTP ${res.status}`);
        // ArrayBuffer を渡すとサーバ(bucket)を介さず直接デコードされる（geopbf の isBuffer 分岐）
        _pbf = await geopbf(await res.arrayBuffer(), { name: 'amedas' });
    }
    execGlobeView(_pbf, AMEDAS_DS, { paint: AMEDAS_PAINT, legend: AMEDAS_LEGEND });
}
