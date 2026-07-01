import CENSUS_MANIFEST    from './manifest.json'    with { type: 'json' };
import CENSUS_2025_POP    from './2025-pop.json'    with { type: 'json' };
import CENSUS_2020_POP    from './2020-pop.json'    with { type: 'json' };
import CENSUS_2020_STATS  from './2020-stats.json'  with { type: 'json' };
import CENSUS_2015_STATS  from './2015-stats.json'  with { type: 'json' };
import CENSUS_2020_AGES   from './2020-ages.json'   with { type: 'json' };
import ESTAT_MANIFEST     from '../estat/manifest.json' with { type: 'json' };
import { buildCensusChartSections } from './charts.mjs';
import { fetchSmallAreaData, fetchSmallAreaPyramid, miniAgeBar,
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

// ---- パンくずナビゲーション -------------------------------------------------
// 各クラム = { label, go }。配列末尾が現在地（非リンク）、それ以外はクリックで遷移。
const _crumbNat   = () => ({ label: '全国', go: _csDrillNational });
const _crumbPref  = prefCode => ({ label: PREFS[prefCode] || prefCode, go: () => _csDrillPref(prefCode) });
const _crumbDesig = (code, prefCode) => ({ label: CENSUS_MANIFEST.find(e => e.code === code)?.name || code, go: () => _csDrillDesignated(code, prefCode) });
const _crumbCity  = (code, prefCode, parentCode) => ({ label: CENSUS_MANIFEST.find(e => e.code === code)?.name || code, go: () => _csDrillCity(code, prefCode, parentCode) });
const _crumbGroup = (cityCode, groupName, groupItems, popMap, prefCode, parentCode) =>
    ({ label: groupName, go: () => _csDrillSmallAreaTable(cityCode, groupName, groupItems, popMap, prefCode, parentCode) });

// 全国 → 都道府県 → (政令市) → 市区町村 までのクラム列
function _cityCrumbs(cityCode, prefCode, parentCode) {
    const arr = [_crumbNat(), _crumbPref(prefCode)];
    if (parentCode) arr.push(_crumbDesig(parentCode, prefCode));
    arr.push(_crumbCity(cityCode, prefCode, parentCode));
    return arr;
}

function _crumbBarHtml(crumbs) {
    if (!crumbs?.length) return '';
    return `<nav class="cs-crumbs">` + crumbs.map((c, i) => {
        const sep = i > 0 ? '<span class="cs-crumb-sep">›</span>' : '';
        return sep + (i === crumbs.length - 1
            ? `<span class="cs-crumb cs-crumb-cur">${escHtml(c.label)}</span>`
            : `<button class="cs-crumb" data-idx="${i}">${escHtml(c.label)}</button>`);
    }).join('') + `</nav>`;
}

function _wireCrumbs(crumbs) {
    document.querySelectorAll('.cs-crumbs .cs-crumb[data-idx]').forEach(el =>
        el.addEventListener('click', () => crumbs[+el.dataset.idx]?.go?.())
    );
}

// ヘルパー: ドリルダウン共通ラッパー HTML
function _drillWrap({ crumbs, title, statsHtml = '', chartHtml = '', listHtml = '' }) {
    return `
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                ${_crumbBarHtml(crumbs)}
                <div class="cs-drill-title-row">
                    <h2>${escHtml(title)}</h2>
                </div>
                ${chartHtml}
                ${statsHtml}
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

// 全レベル共通の年齢ピラミッド HTML（ages=32要素[m0..m15,f0..f15]、上位と同じ描画）
function _pyramidHtml(ages, refAges = CENSUS_2020_AGES['_national']) {
    if (!ages?.some(v => v > 0)) return '<span style="color:#666;font-size:11px">年齢データなし</span>';
    const secs = buildCensusChartSections(null, '2020', { ages, refAges });
    return _chartHtml(secs, { pyramid: { title: '年齢別人口構成', year: refAges ? '2020年（参考：全国平均）' : '2020年' } });
}

// 複数コードの年齢（CENSUS_2020_AGES 32要素）を積み上げ。無ければ null
function _sumAges(codes) {
    const ages = new Array(32).fill(0);
    let has = false;
    for (const c of codes) {
        const a = CENSUS_2020_AGES[c];
        if (a?.length === 32) { a.forEach((v, i) => { ages[i] += v; }); has = true; }
    }
    return has ? ages : null;
}

// 人口の KV 行（総数・男・女）
function _popKvRows(label, year, [t, m, f]) {
    return `<div class="cs-kv"><span class="cs-k">${label} <span class="cs-year">${year}</span></span><span class="cs-v">${t.toLocaleString()} 人</span></div>` +
           `<div class="cs-kv"><span class="cs-k">男性</span><span class="cs-v">${m.toLocaleString()} 人</span></div>` +
           `<div class="cs-kv"><span class="cs-k">女性</span><span class="cs-v">${f.toLocaleString()} 人</span></div>`;
}

// 市区町村/政令市パネルの統計行（2020人口・2025人口＆増減率・世帯・面積・密度）
function _cityStatsRows(pop20, p25, entry) {
    const rows = [];
    if (pop20) rows.push(_popKvRows('人口', '2020年', pop20));
    if (p25?.pop) {
        const sign = p25.popChange >= 0 ? `+${p25.popChange.toFixed(1)}` : p25.popChange.toFixed(1);
        const cl   = p25.popChange >= 0 ? '#4c8' : '#f64';
        rows.push(`<div class="cs-kv"><span class="cs-k">人口 <span class="cs-year">2025年</span></span><span class="cs-v">${p25.pop[0].toLocaleString()} 人</span></div>`);
        rows.push(`<div class="cs-kv"><span class="cs-k">増減率</span><span class="cs-v" style="color:${cl}">${sign}%</span></div>`);
    }
    if (p25?.hh2020) rows.push(`<div class="cs-kv"><span class="cs-k">世帯数 <span class="cs-year">2020年</span></span><span class="cs-v">${p25.hh2020.toLocaleString()} 世帯</span></div>`);
    if (entry?.area) rows.push(`<div class="cs-kv"><span class="cs-k">面積</span><span class="cs-v">${entry.area.toLocaleString()} km²</span></div>`);
    if (entry?.density) rows.push(`<div class="cs-kv"><span class="cs-k">人口密度</span><span class="cs-v">${entry.density.toLocaleString()} 人/km²</span></div>`);
    return rows.join('');
}

// Level 0: 全国データ + 都道府県一覧
function _csDrillNational() {
    // 2020人口を都道府県ごとに集計（CENSUS_2020_POP は葉ノードのみ＝合算で全国と完全一致）
    const byPref = new Map();
    let totPop = 0, totMale = 0, totFem = 0;
    for (const [code, v] of Object.entries(CENSUS_2020_POP)) {
        const pref = code.slice(0, 2);
        if (!byPref.has(pref)) byPref.set(pref, { pop: 0 });
        byPref.get(pref).pop += v[0];
        totPop += v[0]; totMale += v[1]; totFem += v[2];
    }
    const cityCount = Object.keys(CENSUS_2020_POP).length;

    const statsHtml = `
        <div class="cs-kv-grid">
            ${_popKvRows('総人口', '2020年', [totPop, totMale, totFem])}
            <div class="cs-kv"><span class="cs-k">市区町村</span><span class="cs-v">${cityCount.toLocaleString()} 件</span></div>
        </div>`;

    // 全国年齢ピラミッド（自身が基準なので参考線なし）
    const chart = _pyramidHtml(CENSUS_2020_AGES['_national'], null);

    const listHtml = `<h3 class="cs-drill-sec-h3">都道府県 <span class="cs-year">47都道府県</span></h3>
        <div class="cs-drill-chips">${
        [...byPref.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([pref, d]) =>
            `<span class="cs-drill-chip" data-key="${pref}">${PREFS[pref] || pref}<span class="cs-chip-sub">${_popLabel(d.pop)}</span></span>`
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
// 政令市が複数ある県（神奈川=横浜/川崎/相模原、福岡=北九州/福岡 等）では、
// 政令市自身が近い方の政令市の区に誤判定されるためガードする
function _wardParent(code) {
    if (DESIGNATED_CITIES.has(code)) return null;   // 政令市自体は区ではない
    const cNum = parseInt(code, 10);
    let best = null, bestDiff = 40;
    for (const dc of DESIGNATED_CITIES) {
        if (dc.slice(0, 2) !== code.slice(0, 2)) continue;
        const diff = cNum - parseInt(dc, 10);
        if (diff > 0 && diff < bestDiff) { best = dc; bestDiff = diff; }
    }
    return best;
}

// チップ用の人口ラベル（2020）
function _popLabel(pop) {
    if (!pop) return '';
    if (pop >= 1e5) return `${Math.round(pop / 1e4)}万`;
    if (pop >= 1e4) return `${(pop / 1e4).toFixed(1)}万`;
    return pop.toLocaleString();
}

// 市区町村コードの2020人口 [総数, 男, 女]（無ければ null）
// 政令市集計コードは区の合算（CENSUS_2020_POP は葉ノードのみ＝集計コードを持たない）
function _cityPop2020(code) {
    if (CENSUS_2020_POP[code]) return CENSUS_2020_POP[code];
    if (DESIGNATED_CITIES.has(code)) {
        const s = [0, 0, 0];
        for (const [k, v] of Object.entries(CENSUS_2020_POP))
            if (_wardParent(k) === code) { s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; }
        return s[0] ? s : null;
    }
    return null;
}

// Level 1: 都道府県データ + 市区町村一覧
function _csDrillPref(prefCode) {
    const prefName = PREFS[prefCode] || prefCode;
    const cities    = CENSUS_MANIFEST.filter(e => e.pref === prefCode && !e.code.endsWith('000'));

    // 2020人口（CENSUS_2020_POP を都道府県内で合算＝二重計上なし）
    let pop = 0, male = 0, female = 0;
    for (const [code, v] of Object.entries(CENSUS_2020_POP)) {
        if (code.slice(0, 2) === prefCode) { pop += v[0]; male += v[1]; female += v[2]; }
    }

    // 都道府県年齢ピラミッド（市区町村合計）
    const chart = _pyramidHtml(_sumAges(cities.map(c => c.code)));

    const statsHtml = `
        <div class="cs-kv-grid">
            ${_popKvRows('人口', '2020年', [pop, male, female])}
            <div class="cs-kv"><span class="cs-k">市区町村</span><span class="cs-v">${cities.length} 件</span></div>
        </div>`;

    // 政令指定都市の区は除外（政令指定都市自体は残す）
    const topCities = cities.filter(c => !_wardParent(c.code));
    const listHtml = `<h3 class="cs-drill-sec-h3">市区町村 <span class="cs-year">${topCities.length}件</span></h3>
        <div class="cs-drill-chips">${topCities.map(c => {
            const sub = _popLabel(_cityPop2020(c.code)?.[0]);
            return `<span class="cs-drill-chip" data-key="${c.code}">${escHtml(c.name)}${sub ? `<span class="cs-chip-sub">${sub}</span>` : ''}</span>`;
        }).join('')}</div>`;

    const crumbs = [_crumbNat(), _crumbPref(prefCode)];
    ctx.setDetailHtml(_drillWrap({
        crumbs, title: prefName, statsHtml, chartHtml: chart, listHtml,
    }));
    _wireCrumbs(crumbs);
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

    const wards = CENSUS_MANIFEST.filter(e => _wardParent(e.code) === cityCode);

    // 区を積み上げた年齢ピラミッド
    const chart = _pyramidHtml(_sumAges(wards.map(w => w.code)));

    const pop20 = _cityPop2020(cityCode);   // 政令市集計コードは区の合算
    const p25   = CENSUS_2025_POP[cityCode];

    const statsHtml = `<div class="cs-kv-grid">${_cityStatsRows(pop20, p25, entry)}</div>`;

    const listHtml = `<h3 class="cs-drill-sec-h3">行政区 <span class="cs-year">${wards.length}区</span></h3>
        <div class="cs-drill-chips">${wards.map(w => {
            const sub = _popLabel(_cityPop2020(w.code)?.[0]);
            return `<span class="cs-drill-chip" data-key="${w.code}">${escHtml(w.name)}${sub ? `<span class="cs-chip-sub">${sub}</span>` : ''}</span>`;
        }).join('')}</div>`;

    const crumbs = [_crumbNat(), _crumbPref(prefCode), _crumbDesig(cityCode, prefCode)];
    ctx.setDetailHtml(_drillWrap({
        crumbs, title: cityName, statsHtml, chartHtml: chart, listHtml,
    }));
    _wireCrumbs(crumbs);
    document.querySelectorAll('.cs-drill-chip[data-key]').forEach(el =>
        el.addEventListener('click', () => _csDrillCity(el.dataset.key, prefCode, cityCode))
    );
}

// Level 2: 市区町村データ + 小地域一覧（IDB から自動ロード）
async function _csDrillCity(cityCode, prefCode, parentCode = null) {
    const entry    = CENSUS_MANIFEST.find(e => e.code === cityCode);
    const cityName = entry?.name || cityCode;
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

    const statsHtml = `<div class="cs-kv-grid">${_cityStatsRows(pop20, p25, entry)}</div>`;

    const hasSmallArea = ESTAT_CODE_SET.has(cityCode);
    const saHtml = hasSmallArea
        ? '<div id="cs-drill-sa"><span class="cs-sa-loading">小地域データ読み込み中…</span></div>'
        : '<div style="color:#666;font-size:12px;padding:4px 0">小地域データなし</div>';

    const crumbs = _cityCrumbs(cityCode, prefCode, parentCode);

    ctx.setDetailHtml(`
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                ${_crumbBarHtml(crumbs)}
                <div class="cs-drill-title-row">
                    <h2>${escHtml(cityName)}</h2>
                </div>
                ${chart}
                ${statsHtml}
            </div>
            <div class="cs-drill-list">
                <h3 class="cs-drill-sec-h3">小地域（町丁・字等） <span class="cs-year">2020年</span></h3>
                ${saHtml}
            </div>
        </div>
    `);
    _wireCrumbs(crumbs);

    if (hasSmallArea) {
        const saEl = document.getElementById('cs-drill-sa');
        try {
            const { items: allItems, popMap } = await fetchSmallAreaData(cityCode);
            // 9桁＝町丁・字等（正準層。合算が市区町村人口と一致）。11桁＝基本単位区は下位のため除外
            const nine  = allItems.filter(([c]) => c.length === 9);
            const items = nine.length ? nine : allItems;
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
                    preItems: d.items, prePopMap: popMap,
                });
                return;
            }

            saEl.innerHTML = `<div class="cs-drill-chips">${
                [...groups.entries()].map(([g, d]) => {
                    const sub = _popLabel(d.pop) + (d.items.length > 1 ? ` ${d.items.length}件` : '');
                    return `<span class="cs-drill-chip cs-sa-group" data-group="${escHtml(g)}">` +
                    `${escHtml(g)}${sub ? `<span class="cs-chip-sub">${sub}</span>` : ''}</span>`;
                }).join('')
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
    const crumbs = [..._cityCrumbs(cityCode, prefCode, parentCode),
                    _crumbGroup(cityCode, groupName, groupItems, popMap, prefCode, parentCode)];
    ctx.setDetailHtml(`
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                ${_crumbBarHtml(crumbs)}
                <div class="cs-drill-title-row">
                    <h2>${escHtml(groupName)}</h2>
                </div>
                <div style="font-size:11px;color:#888;padding:2px 0">${groupItems.length}件</div>
            </div>
            <div class="cs-drill-list" id="cs-sa-table-body"></div>
        </div>
    `);
    _wireCrumbs(crumbs);
    _populateSmallAreaBody(document.getElementById('cs-sa-table-body'), cityCode, {
        preItems: groupItems,
        prePopMap: popMap,
        onRowClick: (areaCode, areaName, pyr) =>
            _csDrillSmallAreaPyramid(areaName, areaCode, pyr, [...crumbs, { label: areaName }]),
    });
}

// Level 4: 小地域（最下位）→ 名称・コード・人口ピラミッドのみ。秘匿なら理由説明のみ
function _csDrillSmallAreaPyramid(areaName, areaCode, pyr, crumbs) {
    const ages = pyr ? [...pyr.mAges, ...pyr.fAges] : null;
    const body = !ages?.some(v => v > 0)
        ? `<p class="cs-sa-suppressed">この地域は統計上の<b>秘匿</b>対象です。<br>
             対象となる人口が少なく個人が特定されるおそれがあるため、年齢別人口は公表されていません。</p>`
        : `<div class="cs-sa-code">${escHtml(areaCode)}</div>${_pyramidHtml(ages)}`;
    ctx.setDetailHtml(`
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                ${_crumbBarHtml(crumbs)}
                <div class="cs-drill-title-row">
                    <h2>${escHtml(areaName)}</h2>
                </div>
                ${body}
            </div>
            <div class="cs-drill-list"></div>
        </div>
    `);
    _wireCrumbs(crumbs);
}

// ---- small area table renderer (shared) ------------------------------------

async function _populateSmallAreaBody(bodyEl, code, { withPyramid = true, preItems = null, prePopMap = null, onRowClick = null } = {}) {
    bodyEl.innerHTML = '<span class="cs-sa-loading">読み込み中…</span>';
    try {
        // 人口（IDB）は即時。年齢ピラミッド（T082）は待たずに後追い描画する。
        let items, popMap;
        if (preItems && prePopMap) {
            items = preItems; popMap = prePopMap;
        } else {
            const r = await fetchSmallAreaData(code);
            popMap = r.popMap;
            // 9桁＝町丁・字等（正準層）。11桁＝基本単位区は下位のため除外
            const nine = r.items.filter(([c]) => c.length === 9);
            items = nine.length ? nine : r.items;
        }

        if (!items.length) { bodyEl.textContent = 'データなし'; return; }

        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // 年齢構成列は withPyramid 時に枠だけ用意（中身は後追いで流し込む）
        const bodyHtml = items.map(([kc, nm], i) => {
            const p = popMap.get(kc);
            const tdPop = `<td class="cs-sa-pop">${p?.total ? p.total.toLocaleString() : '—'}</td>`;
            const tdPyr = withPyramid ? '<td class="cs-sa-bar"></td>' : '';
            return `<tr data-code="${esc(kc)}"><td>${i + 1}</td><td>${esc(kc)}</td><td>${esc(nm)}</td>${tdPop}${tdPyr}</tr>`;
        }).join('');

        bodyEl.innerHTML = `
            <div class="cs-sa-toolbar">
                <span class="cs-sa-count">${items.length}件</span>
                ${withPyramid ? '<span class="cs-sa-legend" style="display:none"><span class="cs-sa-l y"></span>年少 <span class="cs-sa-l w"></span>生産 <span class="cs-sa-l o"></span>老年</span>' : ''}
            </div>
            <div class="cs-sa-scroll">
                <table class="cs-sa-table">
                    <thead><tr><th>#</th><th>コード</th><th>名称</th><th>人口</th>${withPyramid ? '<th>年齢構成</th>' : ''}</tr></thead>
                    <tbody>${bodyHtml}</tbody>
                </table>
            </div>
            <div class="cs-sa-pyramid-wrap" id="cs-sa-pyramid" style="display:none"></div>`;

        // 行クリック（年齢データ到着後に has-pyr が付いた行だけ反応）
        let pyrMap = new Map();
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
                    _pyramidHtml([...pyr.mAges, ...pyr.fAges]);
            }
        });

        // 年齢構成（T082）を後追いで取得 → 該当セルに流し込み
        if (withPyramid) {
            fetchSmallAreaPyramid(code, API_BASE).then(pm => {
                if (!pm?.size || !bodyEl.isConnected) return;   // 画面遷移後は無視
                pyrMap = pm;
                const tbody = bodyEl.querySelector('tbody');
                if (!tbody) return;
                let any = false;
                for (const tr of tbody.querySelectorAll('tr')) {
                    const pyr = pyrMap.get(tr.dataset.code);
                    if (!pyr) continue;
                    const cell = tr.querySelector('.cs-sa-bar');
                    if (cell) cell.innerHTML = miniAgeBar(pyr.mAges, pyr.fAges);
                    tr.classList.add('has-pyr');
                    any = true;
                }
                if (any) { const lg = bodyEl.querySelector('.cs-sa-legend'); if (lg) lg.style.display = ''; }
            }).catch(() => {});
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
