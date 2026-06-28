import CENSUS_MANIFEST    from './manifest.json'    with { type: 'json' };
import CENSUS_2025_POP    from './2025-pop.json'    with { type: 'json' };
import CENSUS_2020_STATS  from './2020-stats.json'  with { type: 'json' };
import CENSUS_2015_STATS  from './2015-stats.json'  with { type: 'json' };
import ESTAT_MANIFEST     from '../estat/manifest.json' with { type: 'json' };
import { buildCensusChartSVG } from './charts.mjs';
import { fetchSmallAreaPop, fetchSmallAreaPyramid, smallAreaPyramidSvg, miniAgeBar } from './small-area.js';
import { PREFS, escHtml } from '../ui/shared.js';
import { ctx } from '../ui/ctx.js';
import { renderGroupedCities } from '../ui/grouped-list.js';
import { geopbf } from '../ui/gpbf.js';
import { API_BASE } from '../ui/config.js';

// ---- constants -------------------------------------------------------

const ESTAT_SURVEY  = 'A002005212020';
const ESTAT_DL_BASE = 'https://www.e-stat.go.jp/gis/statmap-search/data';
const ESTAT_CODE_SET = new Set(ESTAT_MANIFEST.map(e => e.code));

function estatDlUrl(code) {
    return `${ESTAT_DL_BASE}?dlserveyId=${ESTAT_SURVEY}&code=${code}&coordSys=1&format=shape&downloadType=5&datum=2011`;
}
async function fetchEstatGeopbf(name, code) {
    const proxyUrl = `${API_BASE}/proxy/?url=${encodeURIComponent(estatDlUrl(code))}`;
    const resp = await fetch(proxyUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    return geopbf(new File([blob], `${name}.zip`), { name });
}

// ---- sidebar entries -------------------------------------------------------

export function census2025SidebarEntry() {
    const cities = CENSUS_MANIFEST.filter(e => !e.code.endsWith('000') && e.code !== '00000');
    return { dataset_code:'census2025', title:'国勢調査 2025 速報集計', file_count:cities.length, license:'CC BY', _sourceId:'estat', attribution:'総務省統計局' };
}
export function census2020SidebarEntry() {
    const cities = CENSUS_MANIFEST.filter(e => !e.code.endsWith('000') && e.code !== '00000');
    return { dataset_code:'census2020', title:'国勢調査 2020 基本集計', file_count:cities.length, license:'CC BY', _sourceId:'estat', attribution:'総務省統計局' };
}
export function census2015SidebarEntry() {
    const cities = Object.keys(CENSUS_2015_STATS);
    return { dataset_code:'census2015', title:'国勢調査 2015 基本集計', file_count:cities.length, license:'CC BY', _sourceId:'estat', attribution:'総務省統計局' };
}

// ---- city item HTML -------------------------------------------------------

function censusSign(v) { return v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1); }

function census2025CityItemHtml(city) {
    const p   = CENSUS_2025_POP[city.code];
    const chg = p ? `<span class="pop-chg ${p.popChange >= 0 ? 'pos' : 'neg'}">${censusSign(p.popChange)}%</span>` : '';
    const pop = p ? `<span class="pop-val">${p.pop[0].toLocaleString()}人</span>` : '';
    return `
        <div class="census-city-item moj-city-item" data-code="${city.code}">
            <span class="moj-city-code">${city.code}</span>
            <span class="moj-city-name">${city.name}</span>
            ${pop}${chg}
        </div>
    `;
}
function census2020CityItemHtml(city) {
    const s   = CENSUS_2020_STATS[city.code];
    const ind = s?.ind?.[0];
    const emp = ind ? `<span class="pop-val">${ind.toLocaleString()}人就業</span>` : '';
    return `
        <div class="census-city-item moj-city-item" data-code="${city.code}">
            <span class="moj-city-code">${city.code}</span>
            <span class="moj-city-name">${city.name}</span>
            ${emp}
        </div>
    `;
}
function census2015CityItemHtml(city) {
    const s   = CENSUS_2015_STATS[city.code];
    const pop = s?.pop?.[0];
    const val = pop ? `<span class="pop-val">${pop.toLocaleString()}人</span>` : '';
    return `
        <div class="census-city-item moj-city-item" data-code="${city.code}">
            <span class="moj-city-code">${city.code}</span>
            <span class="moj-city-name">${city.name}</span>
            ${val}
        </div>
    `;
}

function buildCensusCityList() {
    return CENSUS_MANIFEST.filter(e => !e.code.endsWith('000') && e.code !== '00000');
}

// ---- list renders -------------------------------------------------------

let census2025Search = '', census2025Expanded = new Set();
let census2020Search = '', census2020Expanded = new Set();
let census2015Search = '', census2015Expanded = new Set();

export function renderCensus2025List() {
    const cities = buildCensusCityList();
    renderCensusMinistryList({
        id:       'census2025',
        title:    '国勢調査 2025 速報集計',
        subtitle: '令和7年国勢調査 人口速報集計（2025年10月1日現在）<span class="moj-fmt-note">男女別人口・世帯数</span>',
        cities,
        expanded:    census2025Expanded,
        getSearch:   () => census2025Search,
        setSearch:   v  => { census2025Search = v; },
        itemHtml:    census2025CityItemHtml,
        onItemClick: code => showCensusDetail(code, '2025'),
    });
}
export function renderCensus2020List() {
    const cities = buildCensusCityList();
    renderCensusMinistryList({
        id:       'census2020',
        title:    '国勢調査 2020 基本集計',
        subtitle: '令和2年国勢調査 産業別・職業別就業者、世帯経済構成<span class="moj-fmt-note">2020年10月1日現在</span>',
        cities,
        expanded:    census2020Expanded,
        getSearch:   () => census2020Search,
        setSearch:   v  => { census2020Search = v; },
        itemHtml:    census2020CityItemHtml,
        onItemClick: code => showCensusDetail(code, '2020'),
    });
}
export function renderCensus2015List() {
    const codes  = new Set(Object.keys(CENSUS_2015_STATS));
    const cities = CENSUS_MANIFEST.filter(e => !e.code.endsWith('000') && e.code !== '00000' && codes.has(e.code));
    renderCensusMinistryList({
        id:       'census2015',
        title:    '国勢調査 2015 基本集計',
        subtitle: '平成27年国勢調査 産業別・職業別就業者、世帯経済構成<span class="moj-fmt-note">2015年10月1日現在</span>',
        cities,
        expanded:    census2015Expanded,
        getSearch:   () => census2015Search,
        setSearch:   v  => { census2015Search = v; },
        itemHtml:    census2015CityItemHtml,
        onItemClick: code => showCensusDetail(code, '2015'),
    });
}

function renderCensusMinistryList({ id, title, subtitle, cities, expanded, getSearch, setSearch, itemHtml, onItemClick }) {
    ctx.setDetailHtml(`
        <div class="moj-list-wrap">
            <div class="moj-list-head">
                <div class="moj-head-row">
                    <div>
                        <h2>${title}</h2>
                        <p class="moj-subtitle">${subtitle}<span class="moj-total">${cities.length.toLocaleString()}市区町村</span></p>
                    </div>
                </div>
                <input type="text" id="${id}-search" class="moj-search" placeholder="市区町村・都道府県を検索...">
            </div>
            <div class="grouped-list" id="${id}-cities"></div>
        </div>
    `);
    const render = () => renderGroupedCities(cities, `${id}-cities`, expanded, itemHtml, {
        query:       getSearch(),
        groupFn:     c => ({ key: c.pref, name: PREFS[c.pref] || c.pref }),
        onBulkClick: () => {},
        onItemClick: e => {
            const row = e.target.closest('.moj-city-item');
            if (row) onItemClick(row.dataset.code);
        },
    });
    document.getElementById(`${id}-search`).addEventListener('input', function() {
        setSearch(this.value); render();
    });
    render();
}

// ---- small area list -------------------------------------------------------

async function loadSmallAreas(code, bodyEl) {
    bodyEl.innerHTML = '<span class="cs-sa-loading">読み込み中…</span>';
    try {
        const [pbfResult, popResult, pyrResult] = await Promise.allSettled([
            fetchEstatGeopbf(`${code}_${ESTAT_SURVEY}`, code),
            fetchSmallAreaPop(code, API_BASE),
            fetchSmallAreaPyramid(code, API_BASE),
        ]);

        if (pbfResult.status === 'rejected') throw pbfResult.reason;
        const pbf    = pbfResult.value;
        const popMap = popResult.status === 'fulfilled' ? popResult.value : new Map();
        const pyrMap = pyrResult.status === 'fulfilled' ? pyrResult.value : new Map();

        const data = pbf.getPropertyTable();
        if (!data?.length) { bodyEl.textContent = 'データなし'; return; }
        const headers = data[0];
        const rows    = data.slice(1);
        const ki = headers.findIndex(h => /KEY_CODE/i.test(String(h)));
        const ni = headers.findIndex(h => /S_NAME/i.test(String(h)));
        if (ki < 0 || ni < 0) { bodyEl.textContent = 'カラム不明'; return; }

        const seen = new Set();
        const items = rows
            .map(r => [String(r[ki]), String(r[ni])])
            .filter(t => { if (seen.has(t[0])) return false; seen.add(t[0]); return true; })
            .sort((a, b) => a[0] > b[0] ? 1 : -1);

        const hasPop = popMap.size > 0;
        const hasPyr = pyrMap.size > 0;
        const esc    = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const csvHead = hasPop ? 'コード,名称,総人口,男,女' : 'コード,名称';
        const csvRows = items.map(([kc, nm]) => {
            const p = popMap.get(kc);
            return hasPop
                ? `${kc},"${nm.replace(/"/g, '""')}",${p?.total ?? ''},${p?.m ?? ''},${p?.f ?? ''}`
                : `${kc},"${nm.replace(/"/g, '""')}"`;
        });
        const csvContent = '﻿' + csvHead + '\n' + csvRows.join('\n');

        const thPop = hasPop ? '<th>人口</th>' : '';
        const thPyr = hasPyr ? '<th>年齢構成</th>' : '';
        const bodyHtml = items.map(([kc, nm], i) => {
            const p   = popMap.get(kc);
            const pyr = pyrMap.get(kc);
            const tdPop = hasPop
                ? `<td class="cs-sa-pop">${p?.total ? p.total.toLocaleString() : '—'}</td>`
                : '';
            const tdPyr = hasPyr
                ? `<td class="cs-sa-bar">${pyr ? miniAgeBar(pyr.mAges, pyr.fAges) : ''}</td>`
                : '';
            return `<tr data-code="${esc(kc)}"${pyr ? ' class="has-pyr"' : ''}>` +
                `<td>${i + 1}</td><td>${esc(kc)}</td><td>${esc(nm)}</td>${tdPop}${tdPyr}</tr>`;
        }).join('');

        bodyEl.innerHTML = `
            <div class="cs-sa-toolbar">
                <span class="cs-sa-count">${items.length}件</span>
                ${hasPyr ? '<span class="cs-sa-legend"><span class="cs-sa-l y"></span>年少 <span class="cs-sa-l w"></span>生産 <span class="cs-sa-l o"></span>老年</span>' : ''}
                <button class="cs-sa-csv">CSV ↓</button>
            </div>
            <div class="cs-sa-scroll">
                <table class="cs-sa-table">
                    <thead><tr><th>#</th><th>コード</th><th>名称</th>${thPop}${thPyr}</tr></thead>
                    <tbody>${bodyHtml}</tbody>
                </table>
            </div>
            <div class="cs-sa-pyramid-wrap" id="cs-sa-pyramid" style="display:none"></div>`;

        bodyEl.querySelector('.cs-sa-csv').addEventListener('click', () => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([csvContent], { type: 'text/csv' }));
            a.download = `${code}_小地域.csv`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });

        if (hasPyr) {
            const pyrWrap = bodyEl.querySelector('#cs-sa-pyramid');
            let activeRow = null;
            bodyEl.querySelector('tbody').addEventListener('click', e => {
                const tr = e.target.closest('tr.has-pyr');
                if (!tr) return;
                if (tr === activeRow) {
                    tr.classList.remove('active');
                    pyrWrap.style.display = 'none';
                    activeRow = null;
                    return;
                }
                activeRow?.classList.remove('active');
                tr.classList.add('active');
                activeRow = tr;
                const kc  = tr.dataset.code;
                const nm  = items.find(([c]) => c === kc)?.[1] ?? kc;
                const pyr = pyrMap.get(kc);
                const p   = popMap.get(kc);
                const popLine = p?.total
                    ? `<span class="cs-sa-py-pop">人口 ${p.total.toLocaleString()}人（男 ${p.m.toLocaleString()} / 女 ${p.f.toLocaleString()}）</span>`
                    : '';
                pyrWrap.style.display = '';
                pyrWrap.innerHTML =
                    `<div class="cs-sa-py-name">${esc(nm)}${popLine}</div>` +
                    smallAreaPyramidSvg(pyr.mAges, pyr.fAges);
            });
        }
    } catch (e) {
        bodyEl.textContent = `エラー: ${e.message}`;
    }
}

// ---- detail panel -------------------------------------------------------

function showCensusDetail(code, year) {
    const entry = CENSUS_MANIFEST.find(e => e.code === code);
    if (!entry) return;
    const pop  = year === '2025' || year === '2020' ? CENSUS_2025_POP[code] : null;
    const stat = year === '2020' ? CENSUS_2020_STATS[code]
                 : year === '2015' ? CENSUS_2015_STATS[code]
                 : null;
    const name = entry.name;

    let popHtml = '';

    if (pop) {
        const total = pop.pop[0], male = pop.pop[1], female = pop.pop[2];
        const chgSign = pop.popChange >= 0 ? `+${pop.popChange.toFixed(1)}` : pop.popChange.toFixed(1);
        const chgCl   = pop.popChange >= 0 ? '#0a0' : '#c00';
        popHtml = `
            <div class="cs-section">
                <h3>人口・世帯 <span class="cs-year">2025年</span></h3>
                <div class="cs-kv-grid">
                    <div class="cs-kv"><span class="cs-k">総人口</span><span class="cs-v">${total.toLocaleString()} 人</span></div>
                    <div class="cs-kv"><span class="cs-k">男性</span><span class="cs-v">${male.toLocaleString()} 人</span></div>
                    <div class="cs-kv"><span class="cs-k">女性</span><span class="cs-v">${female.toLocaleString()} 人</span></div>
                    <div class="cs-kv"><span class="cs-k">世帯数</span><span class="cs-v">${pop.hh.toLocaleString()} 世帯</span></div>
                    <div class="cs-kv"><span class="cs-k">5年間増減率</span><span class="cs-v" style="color:${chgCl};font-weight:600">${chgSign}%</span></div>
                    <div class="cs-kv"><span class="cs-k">2020年人口(組替)</span><span class="cs-v">${pop.pop2020.toLocaleString()} 人</span></div>
                    ${entry.area    ? `<div class="cs-kv"><span class="cs-k">面積</span><span class="cs-v">${entry.area.toLocaleString()} km²</span></div>` : ''}
                    ${entry.density ? `<div class="cs-kv"><span class="cs-k">人口密度</span><span class="cs-v">${entry.density.toLocaleString()} 人/km²</span></div>` : ''}
                </div>
            </div>`;
    } else if (year === '2015' && stat?.pop) {
        const [total, male, female] = stat.pop;
        popHtml = `
            <div class="cs-section">
                <h3>人口・世帯 <span class="cs-year">2015年</span></h3>
                <div class="cs-kv-grid">
                    <div class="cs-kv"><span class="cs-k">総人口</span><span class="cs-v">${total.toLocaleString()} 人</span></div>
                    <div class="cs-kv"><span class="cs-k">男性</span><span class="cs-v">${male.toLocaleString()} 人</span></div>
                    <div class="cs-kv"><span class="cs-k">女性</span><span class="cs-v">${female.toLocaleString()} 人</span></div>
                    <div class="cs-kv"><span class="cs-k">世帯数</span><span class="cs-v">${stat.hh.toLocaleString()} 世帯</span></div>
                </div>
            </div>`;
    }

    const chartSvg = stat ? buildCensusChartSVG(stat, year) : null;
    const hasSmallArea = ESTAT_CODE_SET.has(code);

    const panel = document.getElementById('geo-preview') || document.createElement('div');
    panel.classList.add('visible');
    panel.innerHTML = `
        <div class="geo-preview-header">
            <span class="geo-preview-label">${escHtml(name)} — 国勢調査統計</span>
            <button class="geo-preview-close">✕</button>
        </div>
        <div class="geo-preview-body census-detail">
            ${popHtml}
            ${chartSvg ? `<div class="cs-section cs-svg-wrap">${chartSvg}</div>` : ''}
            ${!pop && !stat ? '<p style="padding:16px;color:#aaa">統計データなし</p>' : ''}
            ${hasSmallArea ? `
            <div class="cs-section cs-sa-section">
                <h3>小地域（町丁・字等） <span class="cs-year">2020年</span></h3>
                <div class="cs-sa-body" id="cs-sa-body">
                    <button class="cs-sa-load">📋 一覧を読み込む</button>
                </div>
            </div>` : ''}
        </div>
    `;
    panel.querySelector('.geo-preview-close').addEventListener('click', ctx.closeGeoPreview);
    if (hasSmallArea) {
        const bodyEl = panel.querySelector('#cs-sa-body');
        panel.querySelector('.cs-sa-load').addEventListener('click', () => loadSmallAreas(code, bodyEl));
    }
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
