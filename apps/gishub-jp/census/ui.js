import CENSUS_MANIFEST    from './manifest.json'    with { type: 'json' };
import CENSUS_2025_POP    from './2025-pop.json'    with { type: 'json' };
import CENSUS_2020_POP    from './2020-pop.json'    with { type: 'json' };
import CENSUS_2020_STATS  from './2020-stats.json'  with { type: 'json' };
import CENSUS_2015_STATS  from './2015-stats.json'  with { type: 'json' };
import CENSUS_2020_AGES   from './2020-ages.json'   with { type: 'json' };
import ESTAT_MANIFEST     from '../estat/manifest.json' with { type: 'json' };
import { buildCensusChartSections } from './charts.mjs';
import { fetchSmallAreaData, fetchSmallAreaPyramid, smallAreaPyramidSvg, miniAgeBar,
         prefetchSmallAreaIdb, isSmallAreaReady } from './small-area.js';
import { PREFS, escHtml } from '../ui/shared.js';
import { ctx } from '../ui/ctx.js';
import { renderGroupedCities } from '../ui/grouped-list.js';
import { API_BASE } from '../ui/config.js';

// ---- constants -------------------------------------------------------

const ESTAT_CODE_SET = new Set(ESTAT_MANIFEST.map(e => e.code));

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

// ---- 小地域ドリルダウンブラウザ -------------------------------------------
// 全国 → 都道府県 → 市区町村 → 小地域テーブル
// 各レベル: そのレベルのデータ（人口・チャート）+ 子リスト

export function censusSmall2020SidebarEntry() {
    return { dataset_code:'census-small-2020', title:'小地域 2020（町丁・字等）',
             file_count:251142, license:'CC BY', _sourceId:'estat', attribution:'総務省統計局' };
}

export async function renderCensusSmall2020() {
    const ready = await isSmallAreaReady();
    if (!ready) { _csDrillFetch(); return; }
    _csDrillNational();
}

// 初回取得パネル
function _csDrillFetch() {
    ctx.setDetailHtml(`
        <div class="moj-list-wrap">
            <div class="moj-list-head">
                <h2>小地域 2020（町丁・字等）</h2>
                <p class="moj-subtitle">全国 251,142件の町丁・字等別人口データ（令和2年国勢調査）</p>
            </div>
            <div style="padding:24px 16px">
                <p style="color:#aaa;font-size:13px;margin-bottom:16px">初回のみ全国データ（約9MB）をダウンロードしてブラウザに保存します。次回以降は即時表示されます。</p>
                <button id="cs-drill-btn" class="cs-sa-load" style="font-size:14px;padding:8px 20px">全国データを取得</button>
                <div id="cs-drill-sta" style="margin-top:12px;font-size:12px;color:#aaa"></div>
            </div>
        </div>
    `);
    document.getElementById('cs-drill-btn').addEventListener('click', async () => {
        const btn = document.getElementById('cs-drill-btn');
        const sta = document.getElementById('cs-drill-sta');
        btn.disabled = true; sta.textContent = '取得中...';
        try { await prefetchSmallAreaIdb(); renderCensusSmall2020(); }
        catch (e) { sta.textContent = `エラー: ${e.message}`; btn.disabled = false; }
    });
}

// ヘルパー: ドリルダウン共通ラッパー HTML
function _drillWrap({ back, title, statsHtml, chartHtml, listHtml }) {
    const backBtn = back
        ? `<button class="cs-drill-back">${escHtml(back.label)}</button>`
        : '';
    return `
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                <div class="cs-drill-title-row">
                    ${backBtn}
                    <h2>${escHtml(title)}</h2>
                </div>
                ${statsHtml}
                ${chartHtml}
            </div>
            <div class="cs-drill-list">
                ${listHtml}
            </div>
        </div>`;
}

// チャートセクションを最小構成で HTML 化
function _chartHtml(sections, meta = {}) {
    return sections.map(sec => {
        const m = meta[sec.id] || {};
        const hd = m.title
            ? `<h3 class="cs-drill-sec-h3">${m.title}${m.year ? ` <span class="cs-year">${m.year}</span>` : ''}</h3>`
            : '';
        return `<div class="cs-section cs-svg-wrap">${hd}${sec.svg}</div>`;
    }).join('');
}

// Level 0: 全国データ + 都道府県一覧
function _csDrillNational() {
    const cities = CENSUS_MANIFEST.filter(e => !e.code.endsWith('000') && e.code !== '00000');

    // 都道府県ごとに集計
    const byPref = new Map();
    for (const c of cities) {
        const pref = c.pref;
        if (!byPref.has(pref)) byPref.set(pref, { pop: 0, male: 0, female: 0, n: 0 });
        const p = byPref.get(pref);
        p.pop += c.pop || 0; p.male += c.male || 0; p.female += c.female || 0; p.n++;
    }

    const totPop  = [...byPref.values()].reduce((s, p) => s + p.pop, 0);
    const totMale = [...byPref.values()].reduce((s, p) => s + p.male, 0);
    const totFem  = [...byPref.values()].reduce((s, p) => s + p.female, 0);

    const statsHtml = `
        <div class="cs-kv-grid">
            <div class="cs-kv"><span class="cs-k">総人口 <span class="cs-year">2025年</span></span><span class="cs-v">${totPop.toLocaleString()} 人</span></div>
            <div class="cs-kv"><span class="cs-k">男性</span><span class="cs-v">${totMale.toLocaleString()} 人</span></div>
            <div class="cs-kv"><span class="cs-k">女性</span><span class="cs-v">${totFem.toLocaleString()} 人</span></div>
            <div class="cs-kv"><span class="cs-k">市区町村</span><span class="cs-v">${cities.length.toLocaleString()} 件</span></div>
            <div class="cs-kv"><span class="cs-k">小地域 <span class="cs-year">2020年</span></span><span class="cs-v">251,142 件</span></div>
        </div>`;

    // 全国年齢ピラミッド
    const natAges = CENSUS_2020_AGES['_national'];
    const chartSecs = natAges
        ? buildCensusChartSections(null, '2020', { ages: natAges })
        : [];
    const chart = _chartHtml(chartSecs, { pyramid: { title: '年齢別人口構成', year: '2020年' } });

    const listHtml = `<h3 class="cs-drill-sec-h3">都道府県 <span class="cs-year">47都道府県</span></h3>
        <div class="cs-drill-chips">${
        [...byPref.entries()].map(([pref, d]) =>
            `<span class="cs-drill-chip" data-key="${pref}">${PREFS[pref] || pref}<span class="cs-chip-sub">${(d.pop / 1e4).toFixed(0)}万</span></span>`
        ).join('')
    }</div>`;

    ctx.setDetailHtml(_drillWrap({
        title: '全国小地域 2020',
        statsHtml, chartHtml: chart, listHtml,
    }));
    document.querySelectorAll('.cs-drill-chip[data-key]').forEach(el =>
        el.addEventListener('click', () => _csDrillPref(el.dataset.key))
    );
}

// 政令指定都市コード（20市）
const DESIGNATED_CITIES = new Set([
    '01100','04100','11100','12100',
    '14100','14130','14150','15100',
    '22100','22130','23100','26100',
    '27100','27140','28100','33100',
    '34100','40100','40130','43100',
]);

// code が政令指定都市の区なら親市コードを返す（違えば null）
function _wardParent(code) {
    const cNum = parseInt(code, 10);
    let best = null, bestDiff = 40;
    for (const dc of DESIGNATED_CITIES) {
        if (dc.slice(0, 2) !== code.slice(0, 2)) continue;
        const diff = cNum - parseInt(dc, 10);
        if (diff > 0 && diff < bestDiff) { best = dc; bestDiff = diff; }
    }
    return best;
}

// Level 1: 都道府県データ + 市区町村一覧
function _csDrillPref(prefCode) {
    const prefName = PREFS[prefCode] || prefCode;
    const prefEntry = CENSUS_MANIFEST.find(e => e.pref === prefCode && e.code === `${prefCode}000`);
    const cities    = CENSUS_MANIFEST.filter(e => e.pref === prefCode && !e.code.endsWith('000'));

    const pop    = prefEntry?.pop    || cities.reduce((s, c) => s + (c.pop    || 0), 0);
    const male   = prefEntry?.male   || cities.reduce((s, c) => s + (c.male   || 0), 0);
    const female = prefEntry?.female || cities.reduce((s, c) => s + (c.female || 0), 0);
    const hh     = prefEntry?.hh;

    // 都道府県年齢ピラミッド（市区町村合計）
    const prefAges = new Array(32).fill(0);
    let hasAges = false;
    for (const c of cities) {
        const a = CENSUS_2020_AGES[c.code];
        if (a) { a.forEach((v, i) => { prefAges[i] += v; }); hasAges = true; }
    }
    const natAges = CENSUS_2020_AGES['_national'];
    const chartSecs = hasAges
        ? buildCensusChartSections(null, '2020', { ages: prefAges, refAges: natAges })
        : [];
    const chart = _chartHtml(chartSecs, { pyramid: { title: '年齢別人口構成', year: '2020年（参考：全国平均）' } });

    const statsHtml = `
        <div class="cs-kv-grid">
            <div class="cs-kv"><span class="cs-k">人口 <span class="cs-year">2025年</span></span><span class="cs-v">${pop.toLocaleString()} 人</span></div>
            <div class="cs-kv"><span class="cs-k">男性</span><span class="cs-v">${male.toLocaleString()} 人</span></div>
            <div class="cs-kv"><span class="cs-k">女性</span><span class="cs-v">${female.toLocaleString()} 人</span></div>
            ${hh ? `<div class="cs-kv"><span class="cs-k">世帯数</span><span class="cs-v">${hh.toLocaleString()} 世帯</span></div>` : ''}
            <div class="cs-kv"><span class="cs-k">市区町村</span><span class="cs-v">${cities.length} 件</span></div>
        </div>`;

    // 政令指定都市の区は除外（政令指定都市自体は残す）
    const topCities = cities.filter(c => !_wardParent(c.code));
    const listHtml = `<h3 class="cs-drill-sec-h3">市区町村 <span class="cs-year">${topCities.length}件</span></h3>
        <div class="cs-drill-chips">${topCities.map(c =>
            `<span class="cs-drill-chip" data-key="${c.code}">${escHtml(c.name)}</span>`
        ).join('')}</div>`;

    ctx.setDetailHtml(_drillWrap({
        back: { label: '← 全国', fn: _csDrillNational },
        title: prefName, statsHtml, chartHtml: chart, listHtml,
    }));
    document.querySelector('.cs-drill-back').addEventListener('click', _csDrillNational);
    document.querySelectorAll('.cs-drill-chip[data-key]').forEach(el =>
        el.addEventListener('click', () => {
            const code = el.dataset.key;
            if (DESIGNATED_CITIES.has(code)) _csDrillDesignated(code, prefCode);
            else _csDrillCity(code, prefCode, null);
        })
    );
}

// 小地域名 → 大字/町名グループ（丁目・小字を除いた親名）
function _areaGroup(name) {
    // 大字○○字△△ → 大字○○
    const ozaMatch = name.match(/^(大字.+?)字.+$/);
    if (ozaMatch) return ozaMatch[1];
    // ○○一丁目 → ○○（漢数字またはアラビア数字 + 丁目 を除去）
    const choIdx = name.indexOf('丁目');
    if (choIdx > 0) {
        let i = choIdx - 1;
        while (i >= 0 && /[一二三四五六七八九十百千万億兆〇零壱弐参拾\d]/.test(name[i])) i--;
        if (i >= 0) return name.slice(0, i + 1).trim();
    }
    return name;
}

// Level 1.5: 政令指定都市 → 区一覧
// 区の人口は CENSUS_2020_POP の各区の合計（IDB pre-load があれば小地域合計と一致）
function _csDrillDesignated(cityCode, prefCode) {
    const entry    = CENSUS_MANIFEST.find(e => e.code === cityCode);
    const cityName = entry?.name || cityCode;
    const prefName = PREFS[prefCode] || prefCode;

    const wards = CENSUS_MANIFEST.filter(e => _wardParent(e.code) === cityCode);

    const pop20 = CENSUS_2020_POP[cityCode];
    const p25   = CENSUS_2025_POP[cityCode];

    const statsHtml = (() => {
        const rows = [];
        if (pop20) {
            rows.push(`<div class="cs-kv"><span class="cs-k">人口 <span class="cs-year">2020年</span></span><span class="cs-v">${pop20[0].toLocaleString()} 人</span></div>`);
            rows.push(`<div class="cs-kv"><span class="cs-k">男性</span><span class="cs-v">${pop20[1].toLocaleString()} 人</span></div>`);
            rows.push(`<div class="cs-kv"><span class="cs-k">女性</span><span class="cs-v">${pop20[2].toLocaleString()} 人</span></div>`);
        }
        if (p25?.pop) {
            const chgSign = p25.popChange >= 0 ? `+${p25.popChange.toFixed(1)}` : p25.popChange.toFixed(1);
            const chgCl   = p25.popChange >= 0 ? '#4c8' : '#f64';
            rows.push(`<div class="cs-kv"><span class="cs-k">人口 <span class="cs-year">2025年</span></span><span class="cs-v">${p25.pop[0].toLocaleString()} 人</span></div>`);
            rows.push(`<div class="cs-kv"><span class="cs-k">増減率</span><span class="cs-v" style="color:${chgCl}">${chgSign}%</span></div>`);
        }
        if (entry?.area) rows.push(`<div class="cs-kv"><span class="cs-k">面積</span><span class="cs-v">${entry.area.toLocaleString()} km²</span></div>`);
        if (entry?.density) rows.push(`<div class="cs-kv"><span class="cs-k">人口密度</span><span class="cs-v">${entry.density.toLocaleString()} 人/km²</span></div>`);
        return rows.length ? `<div class="cs-kv-grid">${rows.join('')}</div>` : '';
    })();

    const listHtml = `<h3 class="cs-drill-sec-h3">行政区 <span class="cs-year">${wards.length}区</span></h3>
        <div class="cs-drill-chips">${wards.map(w =>
            `<span class="cs-drill-chip" data-key="${w.code}">${escHtml(w.name)}</span>`
        ).join('')}</div>`;

    ctx.setDetailHtml(_drillWrap({
        back: { label: `← ${prefName}` }, title: cityName, statsHtml, chartHtml: '', listHtml,
    }));
    document.querySelector('.cs-drill-back').addEventListener('click', () => _csDrillPref(prefCode));
    document.querySelectorAll('.cs-drill-chip[data-key]').forEach(el =>
        el.addEventListener('click', () => _csDrillCity(el.dataset.key, prefCode, cityCode))
    );
}

// Level 2: 市区町村データ + 小地域一覧（IDB から自動ロード）
async function _csDrillCity(cityCode, prefCode, parentCode = null) {
    const entry    = CENSUS_MANIFEST.find(e => e.code === cityCode);
    const cityName = entry?.name || cityCode;
    const prefName = PREFS[prefCode] || prefCode;
    const stat     = CENSUS_2020_STATS[cityCode];
    const ages     = CENSUS_2020_AGES[cityCode];
    const natAges  = CENSUS_2020_AGES['_national'];

    const popTrend = [];
    const s15  = CENSUS_2015_STATS[cityCode];
    if (s15?.pop) popTrend.push({ year: 2015, male: s15.pop[1], female: s15.pop[2] });
    const pop20 = CENSUS_2020_POP[cityCode];
    if (pop20) popTrend.push({ year: 2020, male: pop20[1], female: pop20[2] });
    const p25 = CENSUS_2025_POP[cityCode];
    if (p25?.pop) popTrend.push({ year: 2025, male: p25.pop[1], female: p25.pop[2] });

    const chartSecs = buildCensusChartSections(stat, '2020', {
        ages:     ages?.length === 32 ? ages : null,
        refAges:  natAges?.length === 32 ? natAges : null,
        popTrend: popTrend.length >= 2 ? popTrend : null,
    });
    const CHART_META = {
        trend:   { title: '人口推移', year: '2015 – 2025' },
        pyramid: { title: '年齢別人口構成', year: '2020年' },
        stats:   { title: '就業・世帯経済', year: '2020年' },
    };
    const chart = _chartHtml(chartSecs, CHART_META);

    const statsHtml = (() => {
        const rows = [];
        if (pop20) {
            rows.push(`<div class="cs-kv"><span class="cs-k">人口 <span class="cs-year">2020年</span></span><span class="cs-v">${pop20[0].toLocaleString()} 人</span></div>`);
            rows.push(`<div class="cs-kv"><span class="cs-k">男性</span><span class="cs-v">${pop20[1].toLocaleString()} 人</span></div>`);
            rows.push(`<div class="cs-kv"><span class="cs-k">女性</span><span class="cs-v">${pop20[2].toLocaleString()} 人</span></div>`);
        }
        if (p25?.pop) {
            const chgSign = p25.popChange >= 0 ? `+${p25.popChange.toFixed(1)}` : p25.popChange.toFixed(1);
            const chgCl   = p25.popChange >= 0 ? '#4c8' : '#f64';
            rows.push(`<div class="cs-kv"><span class="cs-k">人口 <span class="cs-year">2025年</span></span><span class="cs-v">${p25.pop[0].toLocaleString()} 人</span></div>`);
            rows.push(`<div class="cs-kv"><span class="cs-k">増減率</span><span class="cs-v" style="color:${chgCl}">${chgSign}%</span></div>`);
        }
        const hh20 = p25?.hh2020;
        if (hh20)           rows.push(`<div class="cs-kv"><span class="cs-k">世帯数 <span class="cs-year">2020年</span></span><span class="cs-v">${hh20.toLocaleString()} 世帯</span></div>`);
        if (entry?.area)    rows.push(`<div class="cs-kv"><span class="cs-k">面積</span><span class="cs-v">${entry.area.toLocaleString()} km²</span></div>`);
        if (entry?.density) rows.push(`<div class="cs-kv"><span class="cs-k">人口密度</span><span class="cs-v">${entry.density.toLocaleString()} 人/km²</span></div>`);
        return rows.length ? `<div class="cs-kv-grid">${rows.join('')}</div>` : '';
    })();

    const hasSmallArea = ESTAT_CODE_SET.has(cityCode);
    const saHtml = hasSmallArea
        ? '<div id="cs-drill-sa"><span class="cs-sa-loading">小地域データ読み込み中…</span></div>'
        : '<div style="color:#666;font-size:12px;padding:4px 0">小地域データなし</div>';

    const parentName = parentCode
        ? (CENSUS_MANIFEST.find(e => e.code === parentCode)?.name || parentCode)
        : prefName;

    ctx.setDetailHtml(`
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                <div class="cs-drill-title-row">
                    <button class="cs-drill-back">← ${escHtml(parentName)}</button>
                    <h2>${escHtml(cityName)}</h2>
                </div>
                ${statsHtml}
                ${chart}
            </div>
            <div class="cs-drill-list">
                <h3 class="cs-drill-sec-h3">小地域（町丁・字等） <span class="cs-year">2020年</span></h3>
                ${saHtml}
            </div>
        </div>
    `);
    document.querySelector('.cs-drill-back').addEventListener('click', () =>
        parentCode ? _csDrillDesignated(parentCode, prefCode) : _csDrillPref(prefCode)
    );

    if (hasSmallArea) {
        const saEl = document.getElementById('cs-drill-sa');
        try {
            const { items, popMap } = await fetchSmallAreaData(cityCode);
            if (!items.length) { saEl.textContent = 'データなし'; return; }
            const groups = new Map();
            for (const [code, name] of items) {
                const g = _areaGroup(name);
                if (!groups.has(g)) groups.set(g, { items: [], pop: 0 });
                const d = groups.get(g);
                d.items.push([code, name]);
                d.pop += popMap.get(code)?.total || 0;
            }
            // グループが1種類だけ（全部同じ親名）→ チップ段階をスキップしてテーブル直行
            if (groups.size === 1) {
                const [g, d] = [...groups.entries()][0];
                await _populateSmallAreaBody(saEl, cityCode, {
                    downloadName: `${cityCode}_小地域.csv`,
                    preItems: d.items, prePopMap: popMap,
                });
                return;
            }

            saEl.innerHTML = `<div class="cs-drill-chips">${
                [...groups.entries()].map(([g, d]) =>
                    `<span class="cs-drill-chip cs-sa-group" data-group="${escHtml(g)}">` +
                    `${escHtml(g)}${d.items.length > 1 ? `<span class="cs-chip-sub">${d.items.length}件</span>` : ''}</span>`
                ).join('')
            }</div>`;
            saEl.querySelectorAll('.cs-sa-group').forEach(el =>
                el.addEventListener('click', () => {
                    const g = el.dataset.group;
                    const d = groups.get(g);
                    _csDrillSmallAreaTable(cityCode, g, d.items, popMap, prefCode, parentCode);
                })
            );
        } catch (e) { saEl.textContent = `エラー: ${e.message}`; }
    }
}

// Level 3: 大字/町名グループ → 小地域テーブル
function _csDrillSmallAreaTable(cityCode, groupName, groupItems, popMap, prefCode, parentCode) {
    const cityEntry = CENSUS_MANIFEST.find(e => e.code === cityCode);
    const cityName  = cityEntry?.name || cityCode;
    ctx.setDetailHtml(`
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                <div class="cs-drill-title-row">
                    <button class="cs-drill-back">← ${escHtml(cityName)}</button>
                    <h2>${escHtml(groupName)}</h2>
                </div>
                <div style="font-size:11px;color:#888;padding:2px 0">${groupItems.length}件</div>
            </div>
            <div class="cs-drill-list" id="cs-sa-table-body"></div>
        </div>
    `);
    document.querySelector('.cs-drill-back').addEventListener('click', () =>
        _csDrillCity(cityCode, prefCode, parentCode)
    );
    _populateSmallAreaBody(document.getElementById('cs-sa-table-body'), cityCode, {
        downloadName: `${cityCode}_${groupName}_小地域.csv`,
        preItems: groupItems,
        prePopMap: popMap,
        onRowClick: (areaCode, areaName, pyr, pop) => {
            const backToTable = () => _csDrillSmallAreaTable(cityCode, groupName, groupItems, popMap, prefCode, parentCode);
            _csDrillSmallAreaPyramid(areaName, groupName, pyr, pop, backToTable);
        },
    });
}

// Level 4: 小地域 → 人口ピラミッド（最終系）
function _csDrillSmallAreaPyramid(areaName, backLabel, pyr, pop, backFn) {
    const popHtml = pop?.total ? `
        <div class="cs-kv-grid">
            <div class="cs-kv"><span class="cs-k">総人口</span><span class="cs-v">${pop.total.toLocaleString()} 人</span></div>
            <div class="cs-kv"><span class="cs-k">男性</span><span class="cs-v">${pop.m.toLocaleString()} 人</span></div>
            <div class="cs-kv"><span class="cs-k">女性</span><span class="cs-v">${pop.f.toLocaleString()} 人</span></div>
        </div>` : '';
    const pyrSvg = pyr ? smallAreaPyramidSvg(pyr.mAges, pyr.fAges)
                       : '<span style="color:#666;font-size:11px">年齢データなし</span>';
    ctx.setDetailHtml(`
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                <div class="cs-drill-title-row">
                    <button class="cs-drill-back">← ${escHtml(backLabel)}</button>
                    <h2>${escHtml(areaName)}</h2>
                </div>
                ${popHtml}
            </div>
            <div class="cs-drill-list">
                <div class="cs-svg-wrap" style="padding:8px 0">${pyrSvg}</div>
            </div>
        </div>
    `);
    document.querySelector('.cs-drill-back').addEventListener('click', backFn);
}

// ---- small area table renderer (shared) ------------------------------------

async function _populateSmallAreaBody(bodyEl, code, { downloadName, withPyramid = true, preItems = null, prePopMap = null, onRowClick = null } = {}) {
    bodyEl.innerHTML = '<span class="cs-sa-loading">読み込み中…</span>';
    try {
        let items, popMap, pyrMap = new Map();
        if (preItems && prePopMap) {
            items = preItems;
            popMap = prePopMap;
            if (withPyramid) {
                pyrMap = await fetchSmallAreaPyramid(code, API_BASE).catch(() => new Map());
            }
        } else {
            const [dataResult, pyrResult] = withPyramid
                ? await Promise.allSettled([fetchSmallAreaData(code), fetchSmallAreaPyramid(code, API_BASE)])
                : [{ status: 'fulfilled', value: await fetchSmallAreaData(code) }, { status: 'rejected' }];
            if (dataResult.status === 'rejected') throw dataResult.reason;
            ({ items, popMap } = dataResult.value);
            if (pyrResult.status === 'fulfilled') pyrMap = pyrResult.value;
        }

        if (!items.length) { bodyEl.textContent = 'データなし'; return; }

        const hasPop = true;
        const hasPyr = pyrMap.size > 0;
        const esc    = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const fname  = downloadName ?? `${code}_小地域.csv`;

        const csvRows = items.map(([kc, nm]) => {
            const p = popMap.get(kc);
            return `${kc},"${nm.replace(/"/g, '""')}",${p?.total ?? ''},${p?.m ?? ''},${p?.f ?? ''}`;
        });
        const csvContent = '﻿コード,名称,総人口,男,女\n' + csvRows.join('\n');

        const thPyr    = hasPyr ? '<th>年齢構成</th>' : '';
        const bodyHtml = items.map(([kc, nm], i) => {
            const p   = popMap.get(kc);
            const pyr = pyrMap.get(kc);
            const tdPop = `<td class="cs-sa-pop">${p?.total ? p.total.toLocaleString() : '—'}</td>`;
            const tdPyr = hasPyr ? `<td class="cs-sa-bar">${pyr ? miniAgeBar(pyr.mAges, pyr.fAges) : ''}</td>` : '';
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
                    <thead><tr><th>#</th><th>コード</th><th>名称</th><th>人口</th>${thPyr}</tr></thead>
                    <tbody>${bodyHtml}</tbody>
                </table>
            </div>
            <div class="cs-sa-pyramid-wrap" id="cs-sa-pyramid" style="display:none"></div>`;

        bodyEl.querySelector('.cs-sa-csv').addEventListener('click', () => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([csvContent], { type: 'text/csv' }));
            a.download = fname;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });

        if (hasPyr) {
            bodyEl.querySelector('tbody').addEventListener('click', e => {
                const tr = e.target.closest('tr.has-pyr');
                if (!tr) return;
                const kc  = tr.dataset.code;
                const nm  = items.find(([c]) => c === kc)?.[1] ?? kc;
                const pyr = pyrMap.get(kc);
                const p   = popMap.get(kc);
                if (onRowClick) {
                    // ドリルダウンモード: 専用パネルへ遷移
                    onRowClick(kc, nm, pyr, p);
                } else {
                    // 通常モード: インライン表示（従来の動作）
                    const pyrWrap = bodyEl.querySelector('#cs-sa-pyramid');
                    if (tr.classList.contains('active')) {
                        tr.classList.remove('active');
                        pyrWrap.style.display = 'none';
                        return;
                    }
                    bodyEl.querySelectorAll('tr.active').forEach(r => r.classList.remove('active'));
                    tr.classList.add('active');
                    const popLine = p?.total
                        ? `<span class="cs-sa-py-pop">人口 ${p.total.toLocaleString()}人（男 ${p.m.toLocaleString()} / 女 ${p.f.toLocaleString()}）</span>`
                        : '';
                    pyrWrap.style.display = '';
                    pyrWrap.innerHTML = `<div class="cs-sa-py-name">${esc(nm)}${popLine}</div>` +
                        smallAreaPyramidSvg(pyr.mAges, pyr.fAges);
                }
            });
        }
    } catch (e) {
        bodyEl.textContent = `エラー: ${e.message}`;
    }
}

// ---- small area list (used by city detail panel) ---------------------------

async function loadSmallAreas(code, bodyEl) {
    await _populateSmallAreaBody(bodyEl, code);
}

// ---- detail panel -------------------------------------------------------

function showCensusDetail(code, year) {
    const entry = CENSUS_MANIFEST.find(e => e.code === code);
    if (!entry) return;
    const pop  = year === '2025' ? CENSUS_2025_POP[code] : null;
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
    } else if (year === '2020') {
        const p20det  = CENSUS_2020_POP[code];
        const p25ref  = CENSUS_2025_POP[code];
        if (p20det) {
            const hh20 = p25ref?.hh2020;
            popHtml = `
                <div class="cs-section">
                    <h3>人口・世帯 <span class="cs-year">2020年</span></h3>
                    <div class="cs-kv-grid">
                        <div class="cs-kv"><span class="cs-k">総人口</span><span class="cs-v">${p20det[0].toLocaleString()} 人</span></div>
                        <div class="cs-kv"><span class="cs-k">男性</span><span class="cs-v">${p20det[1].toLocaleString()} 人</span></div>
                        <div class="cs-kv"><span class="cs-k">女性</span><span class="cs-v">${p20det[2].toLocaleString()} 人</span></div>
                        ${hh20           ? `<div class="cs-kv"><span class="cs-k">世帯数</span><span class="cs-v">${hh20.toLocaleString()} 世帯</span></div>` : ''}
                        ${entry?.area    ? `<div class="cs-kv"><span class="cs-k">面積</span><span class="cs-v">${entry.area.toLocaleString()} km²</span></div>` : ''}
                        ${entry?.density ? `<div class="cs-kv"><span class="cs-k">人口密度</span><span class="cs-v">${entry.density.toLocaleString()} 人/km²</span></div>` : ''}
                    </div>
                </div>`;
        }
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

    // Population trend (2015→2020→2025 if data available)
    const popTrend = [];
    const stat2015 = CENSUS_2015_STATS[code];
    if (stat2015?.pop)          popTrend.push({ year: 2015, male: stat2015.pop[1], female: stat2015.pop[2] });
    const pop2020det = CENSUS_2020_POP[code];
    if (pop2020det)             popTrend.push({ year: 2020, male: pop2020det[1], female: pop2020det[2] });
    const pop2025 = CENSUS_2025_POP[code];
    if (pop2025?.pop)           popTrend.push({ year: 2025, male: pop2025.pop[1], female: pop2025.pop[2] });

    // Age pyramid data (2020)
    const ages    = CENSUS_2020_AGES[code]   || null;
    const refAges = CENSUS_2020_AGES['_national'] || null;

    const chartOpts = {
        ages:     ages && ages.length === 32 ? ages : null,
        refAges:  refAges && refAges.length === 32 ? refAges : null,
        popTrend: popTrend.length >= 2 ? popTrend : null,
    };
    const chartSections = buildCensusChartSections(stat, year, chartOpts);

    const SECTION_META = {
        trend:   { title: '人口推移', year: '2015 – 2025' },
        pyramid: { title: '年齢別人口構成', year: '2020年（参考：全国平均）' },
        stats:   { title: '就業・世帯経済', year: year + '年' },
    };
    const PYRAMID_LEGEND = `
        <div class="cs-pyramid-legend">
            <span class="cs-pl-item"><span class="cs-pl-sw" style="background:#80f"></span><span class="cs-pl-sw" style="background:#804"></span>年少 0-14</span>
            <span class="cs-pl-item"><span class="cs-pl-sw" style="background:#88f"></span><span class="cs-pl-sw" style="background:#fcc"></span>生産 15-64</span>
            <span class="cs-pl-item"><span class="cs-pl-sw" style="background:#8f0"></span><span class="cs-pl-sw" style="background:#f80"></span>老年 65+</span>
            <span class="cs-pl-item cs-pl-ref"><span class="cs-pl-line"></span>全国平均</span>
        </div>`;

    const chartHtml = chartSections.map(sec => {
        const m = SECTION_META[sec.id] || {};
        const title = m.title ? `<h3>${m.title}${m.year ? ` <span class="cs-year">${m.year}</span>` : ''}</h3>` : '';
        const extra = sec.id === 'pyramid' ? PYRAMID_LEGEND : '';
        return `<div class="cs-section cs-svg-wrap">${title}${sec.svg}${extra}</div>`;
    }).join('');

    const hasSmallArea = year === '2020' && ESTAT_CODE_SET.has(code);

    const panel = document.getElementById('geo-preview') || document.createElement('div');
    panel.classList.add('visible');
    panel.innerHTML = `
        <div class="geo-preview-header">
            <span class="geo-preview-label">${escHtml(name)} — 国勢調査統計</span>
            <button class="geo-preview-close">✕</button>
        </div>
        <div class="geo-preview-body census-detail">
            ${popHtml}
            ${chartHtml}
            ${!pop && !stat && !chartHtml ? '<p style="padding:16px;color:#aaa">統計データなし</p>' : ''}
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
