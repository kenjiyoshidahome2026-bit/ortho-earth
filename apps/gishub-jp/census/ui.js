import CENSUS_MANIFEST    from './manifest.json'    with { type: 'json' };
import CENSUS_2025_POP    from './2025-pop.json'    with { type: 'json' };
import CENSUS_2020_POP    from './2020-pop.json'    with { type: 'json' };
import CENSUS_2020_STATS  from './2020-stats.json'  with { type: 'json' };
import CENSUS_2015_STATS  from './2015-stats.json'  with { type: 'json' };
import CENSUS_2020_AGES   from './2020-ages.json'   with { type: 'json' };
import CENSUS_KANA        from './kana.json'        with { type: 'json' };
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
const MANIFEST_BY_CODE = new Map(CENSUS_MANIFEST.map(e => [e.code, e]));

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
// 都道府県の正式名（都/道/府/県）
function _prefFull(prefCode) {
    const n = PREFS[prefCode] || prefCode;
    if (n === '北海道') return n;
    if (n === '東京') return n + '都';
    if (n === '大阪' || n === '京都') return n + '府';
    return n + '県';
}
// 親名を接頭辞として除き住所風の増分表示に（横浜市都筑区→都筑区, 茅ケ崎南一丁目→一丁目）
function _addrShort(name, parentLabel) {
    return parentLabel && name.startsWith(parentLabel) && name !== parentLabel
        ? name.slice(parentLabel.length) : name;
}
// 漢字名＋ふりがなルビ（かなが無ければ漢字のみ）。多言語化の土台にもなる
function _rubyHtml(name, kana) {
    return kana ? `<ruby>${escHtml(name)}<rt>${escHtml(kana)}</rt></ruby>` : escHtml(name);
}

const _crumbNat   = () => ({ label: '全国', go: _csDrillNational });
const _crumbPref  = prefCode => ({ label: _prefFull(prefCode), go: () => _csDrillPref(prefCode) });
const _crumbDesig = (code, prefCode) => ({ label: CENSUS_MANIFEST.find(e => e.code === code)?.name || code, go: () => _csDrillDesignated(code, prefCode) });
const _crumbCity  = (code, prefCode, parentCode) => {
    const name   = CENSUS_MANIFEST.find(e => e.code === code)?.name || code;
    const parent = parentCode ? (CENSUS_MANIFEST.find(e => e.code === parentCode)?.name || '') : '';
    return { label: _addrShort(name, parent), go: () => _csDrillCity(code, prefCode, parentCode) };
};

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
// 並び順: パンくず → セレクタ（子リスト）→ 表示（統計・ピラミッド）
function _drillWrap({ crumbs, title, statsHtml = '', chartHtml = '', listHtml = '' }) {
    return `
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                ${_crumbBarHtml(crumbs)}
                <div class="cs-drill-title-row">
                    <h2>${title}</h2>
                </div>
            </div>
            ${listHtml ? `<div class="cs-drill-list">${listHtml}</div>` : ''}
            <div class="cs-drill-display">${statsHtml}${chartHtml}</div>
        </div>`;
}

// 年齢ピラミッドの凡例（年少/生産/老年、任意で全国平均線）
function _pyramidLegend(hasRef) {
    return `<div class="cs-pyramid-legend">
        <span class="cs-pl-item"><span class="cs-pl-sw" style="background:#80f"></span><span class="cs-pl-sw" style="background:#804"></span>年少 0-14</span>
        <span class="cs-pl-item"><span class="cs-pl-sw" style="background:#88f"></span><span class="cs-pl-sw" style="background:#fcc"></span>生産 15-64</span>
        <span class="cs-pl-item"><span class="cs-pl-sw" style="background:#8f0"></span><span class="cs-pl-sw" style="background:#f80"></span>老年 65+</span>
        ${hasRef ? '<span class="cs-pl-item cs-pl-ref"><span class="cs-pl-line"></span>全国平均</span>' : ''}
    </div>`;
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

// 市区町村以上の全チャート（年齢ピラミッド → 人口推移 → 就業・世帯経済）を凡例付きで
function _fullChartHtml({ ages = null, refAges = CENSUS_2020_AGES['_national'], popTrend = null, stat = null }) {
    const secs = buildCensusChartSections(stat, '2020', {
        ages:     ages?.length === 32 ? ages : null,
        refAges:  refAges?.length === 32 ? refAges : null,
        popTrend: popTrend?.length >= 2 ? popTrend : null,
    });
    const META = {
        pyramid: { title: '年齢別人口構成', year: refAges ? '2020年（参考：全国平均）' : '2020年' },
        trend:   { title: '人口推移',       year: '2015 – 2025' },
        stats:   { title: '就業・世帯経済',  year: '2020年' },
    };
    return secs.map(sec => {
        const m  = META[sec.id] || {};
        const hd = m.title ? `<h3 class="cs-drill-sec-h3">${m.title}${m.year ? ` <span class="cs-year">${m.year}</span>` : ''}</h3>` : '';
        const lg = sec.id === 'pyramid' ? _pyramidLegend(!!refAges) : '';
        return `<div class="cs-section cs-svg-wrap">${hd}${sec.svg}${lg}</div>`;
    }).join('');
}

// 葉コード集合の人口推移（2015/2020/2025 を年ごとに男女合算）
function _sumTrend(leaf) {
    let m15 = 0, f15 = 0, s15 = false, m20 = 0, f20 = 0, s20 = false, m25 = 0, f25 = 0, s25 = false;
    for (const c of leaf) {
        const a = CENSUS_2015_STATS[c]; if (a?.pop) { m15 += a.pop[1]; f15 += a.pop[2]; s15 = true; }
        const v = CENSUS_2020_POP[c];   if (v)      { m20 += v[1];     f20 += v[2];     s20 = true; }
        const w = CENSUS_2025_POP[c];   if (w?.pop) { m25 += w.pop[1]; f25 += w.pop[2]; s25 = true; }
    }
    const t = [];
    if (s15) t.push({ year: 2015, male: m15, female: f15 });
    if (s20) t.push({ year: 2020, male: m20, female: f20 });
    if (s25) t.push({ year: 2025, male: m25, female: f25 });
    return t.length >= 2 ? t : null;
}

// pred(code) を満たす市区町村を積み上げ（人口・世帯・面積・年齢・就業/世帯経済・推移）
// 葉ノードは CENSUS_2020_POP のキー集合（集計コードを含まない）を正準とする
function _aggForLevel(pred) {
    const leaf = Object.keys(CENSUS_2020_POP).filter(pred);
    const p20 = [0, 0, 0], p25 = [0, 0, 0], ages = new Array(32).fill(0);
    let hh = 0, area = 0, has25 = false, hasHh = false, hasArea = false, hasAges = false;
    const stat = {};
    for (const c of leaf) {
        const v20 = CENSUS_2020_POP[c]; p20[0] += v20[0]; p20[1] += v20[1]; p20[2] += v20[2];
        const m = MANIFEST_BY_CODE.get(c); if (m?.area) { area += m.area; hasArea = true; }
        const v25 = CENSUS_2025_POP[c];
        if (v25?.pop) { p25[0] += v25.pop[0]; p25[1] += v25.pop[1]; p25[2] += v25.pop[2]; has25 = true; if (v25.hh2020) { hh += v25.hh2020; hasHh = true; } }
        const a = CENSUS_2020_AGES[c]; if (a?.length === 32) { a.forEach((x, i) => { ages[i] += x; }); hasAges = true; }
        const s = CENSUS_2020_STATS[c];
        if (s) for (const k of ['ind', 'occ', 'eco']) if (s[k]) {
            if (!stat[k]) stat[k] = new Array(s[k].length).fill(0);
            s[k].forEach((x, i) => { stat[k][i] += x; });
        }
    }
    return {
        pop2020: p20, pop2025: has25 ? p25 : null, hh: hasHh ? hh : 0, area: hasArea ? area : 0, count: leaf.length,
        ages: hasAges ? ages : null, stat: Object.keys(stat).length ? stat : null, trend: _sumTrend(leaf),
    };
}

// 集計 KV（市区町村と同じ項目: 2020人口・2025人口＆増減率・世帯・面積・密度）
// 件数はセレクタ見出しに出るので KV には含めない
function _aggKvHtml(agg) {
    const rows = [_popKvRows('総人口', '2020年', agg.pop2020)];
    if (agg.pop2025) {
        const chg  = agg.pop2020[0] ? (agg.pop2025[0] - agg.pop2020[0]) / agg.pop2020[0] * 100 : 0;
        const sign = chg >= 0 ? `+${chg.toFixed(1)}` : chg.toFixed(1);
        const cl   = chg >= 0 ? '#4c8' : '#f64';
        rows.push(`<div class="cs-kv"><span class="cs-k">人口 <span class="cs-year">2025年</span></span><span class="cs-v">${agg.pop2025[0].toLocaleString()} 人</span></div>`);
        rows.push(`<div class="cs-kv"><span class="cs-k">増減率</span><span class="cs-v" style="color:${cl}">${sign}%</span></div>`);
    }
    if (agg.hh)   rows.push(`<div class="cs-kv"><span class="cs-k">世帯数 <span class="cs-year">2020年</span></span><span class="cs-v">${agg.hh.toLocaleString()} 世帯</span></div>`);
    if (agg.area) {
        rows.push(`<div class="cs-kv"><span class="cs-k">面積</span><span class="cs-v">${Math.round(agg.area).toLocaleString()} km²</span></div>`);
        rows.push(`<div class="cs-kv"><span class="cs-k">人口密度</span><span class="cs-v">${Math.round(agg.pop2020[0] / agg.area).toLocaleString()} 人/km²</span></div>`);
    }
    return `<div class="cs-kv-grid">${rows.join('')}</div>`;
}

// 集計レベル（全国/都道府県/政令市）共通ビュー: 積み上げ統計＋全チャート＋子チップ
function _renderAggView({ crumbs = null, title, pred, ages = null, refAges = CENSUS_2020_AGES['_national'], listHtml, onChip }) {
    const agg = _aggForLevel(pred);
    ctx.setDetailHtml(_drillWrap({
        crumbs, title,
        statsHtml: _aggKvHtml(agg),
        chartHtml: _fullChartHtml({ ages: ages || agg.ages, refAges, popTrend: agg.trend, stat: agg.stat }),
        listHtml,
    }));
    if (crumbs) _wireCrumbs(crumbs);
    document.querySelectorAll('.cs-drill-chip[data-key]').forEach(el =>
        el.addEventListener('click', () => onChip(el.dataset.key)));
}

// 市区町村/区チップのリスト HTML（人口ラベル付き）
function _cityChipsHtml(headTitle, headCount, items) {
    return `<h3 class="cs-drill-sec-h3">${headTitle} <span class="cs-year">${headCount}</span></h3>
        <div class="cs-drill-chips">${items.map(c => {
            const sub = _popLabel(_cityPop2020(c.code)?.[0]);
            return `<span class="cs-drill-chip" data-key="${c.code}">${escHtml(c.name)}${sub ? `<span class="cs-chip-sub">${sub}</span>` : ''}</span>`;
        }).join('')}</div>`;
}

// Level 0: 全国データ + 都道府県一覧
function _csDrillNational() {
    const byPref = new Map();
    for (const [code, v] of Object.entries(CENSUS_2020_POP)) {
        const pref = code.slice(0, 2);
        byPref.set(pref, (byPref.get(pref) || 0) + v[0]);
    }
    const listHtml = `<h3 class="cs-drill-sec-h3">都道府県 <span class="cs-year">47都道府県</span></h3>
        <div class="cs-drill-chips">${
        [...byPref.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([pref, pop]) =>
            `<span class="cs-drill-chip" data-key="${pref}">${PREFS[pref] || pref}<span class="cs-chip-sub">${_popLabel(pop)}</span></span>`
        ).join('')}</div>`;
    // 全国のピラミッドは precomputed _national（参考線なし）
    _renderAggView({
        title: _rubyHtml('全国', 'ぜんこく'), pred: () => true,
        ages: CENSUS_2020_AGES['_national'], refAges: null,
        listHtml, onChip: _csDrillPref,
    });
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
    // 政令指定都市の区は除外（政令指定都市自体は残す）
    const topCities = CENSUS_MANIFEST.filter(e => e.pref === prefCode && !e.code.endsWith('000') && !_wardParent(e.code));
    _renderAggView({
        crumbs: [_crumbNat(), _crumbPref(prefCode)],
        title: _rubyHtml(_prefFull(prefCode), CENSUS_KANA[prefCode]),
        pred: c => c.slice(0, 2) === prefCode,
        listHtml: _cityChipsHtml('市区町村', `${topCities.length}件`, topCities),
        onChip: code => DESIGNATED_CITIES.has(code) ? _csDrillDesignated(code, prefCode) : _csDrillCity(code, prefCode, null),
    });
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

// Level 1.5: 政令指定都市 → 区一覧（区を積み上げ）
function _csDrillDesignated(cityCode, prefCode) {
    const wards   = CENSUS_MANIFEST.filter(e => _wardParent(e.code) === cityCode);
    const wardSet = new Set(wards.map(w => w.code));
    _renderAggView({
        crumbs: [_crumbNat(), _crumbPref(prefCode), _crumbDesig(cityCode, prefCode)],
        title: _rubyHtml(MANIFEST_BY_CODE.get(cityCode)?.name || cityCode, CENSUS_KANA[cityCode]),
        pred: c => wardSet.has(c),
        listHtml: _cityChipsHtml('行政区', `${wards.length}区`, wards),
        onChip: code => _csDrillCity(code, prefCode, cityCode),
    });
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

    const chart = _fullChartHtml({ ages, refAges: natAges, popTrend, stat });

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
                    <h2>${_rubyHtml(cityName, CENSUS_KANA[cityCode])}</h2>
                </div>
            </div>
            <div class="cs-drill-list">
                <h3 class="cs-drill-sec-h3">小地域（町丁・字等） <span class="cs-year">2020年</span></h3>
                ${saHtml}
            </div>
            <div class="cs-drill-display">${statsHtml}${chart}</div>
        </div>
    `);
    _wireCrumbs(crumbs);

    if (hasSmallArea) {
        const saEl = document.getElementById('cs-drill-sa');
        try {
            const { items: allItems, popMap } = await fetchSmallAreaData(cityCode);
            // 9桁＝町丁・字等（正準層。合算が市区町村人口と一致）。
            // 11桁＝基本単位区/丁目は各9桁の子として subMap に退避し、行クリックでドリルできるようにする
            const subMap = new Map();   // 9桁 → [[11桁, name], ...]
            for (const [c, n] of allItems) {
                if (c.length === 11) {
                    const parent = c.slice(0, 9);
                    if (!subMap.has(parent)) subMap.set(parent, []);
                    subMap.get(parent).push([c, n]);
                }
            }
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
                const [, d] = [...groups.entries()][0];
                await _populateSmallAreaBody(saEl, cityCode, {
                    preItems: d.items, prePopMap: popMap,
                    onRowClick: _saRowClick(cityCode, popMap, subMap, crumbs),
                    hasChild: c => subMap.has(c),
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
                    const gc = _cityCrumbs(cityCode, prefCode, parentCode);
                    // 単一町丁字＋子（丁目）あり → 中間の1行テーブルを挟まず丁目＋集計ピラミッドへ直行
                    if (d.items.length === 1 && subMap.has(d.items[0][0])) {
                        const [code, name] = d.items[0];
                        gc.push({ label: name, go: () => _csDrillSmallAreaTable(cityCode, name, subMap.get(code), popMap, subMap, gc, code) });
                        _csDrillSmallAreaTable(cityCode, name, subMap.get(code), popMap, subMap, gc, code);
                        return;
                    }
                    gc.push({ label: g, go: () => _csDrillSmallAreaTable(cityCode, g, d.items, popMap, subMap, gc) });
                    _csDrillSmallAreaTable(cityCode, g, d.items, popMap, subMap, gc);
                })
            );
        } catch (e) { saEl.textContent = `エラー: ${e.message}`; }
    }
}

// 小地域テーブルの行クリック: 11桁の子（丁目/基本単位区）があればドリル、なければピラミッド
function _saRowClick(cityCode, popMap, subMap, crumbs) {
    return (areaCode, areaName, pyr) => {
        const kids = subMap.get(areaCode);
        if (kids?.length) {
            // グループ名＝町丁字名なら重複クラムを避けて置き換え
            const base = crumbs[crumbs.length - 1]?.label === areaName ? crumbs.slice(0, -1) : crumbs;
            const cc = [...base, { label: areaName }];
            cc[cc.length - 1].go = () => _csDrillSmallAreaTable(cityCode, areaName, kids, popMap, subMap, cc, areaCode);
            _csDrillSmallAreaTable(cityCode, areaName, kids, popMap, subMap, cc, areaCode);
        } else {
            const short = _addrShort(areaName, crumbs[crumbs.length - 1]?.label);
            _csDrillSmallAreaPyramid(areaName, areaCode, pyr, [...crumbs, { label: short }]);
        }
    };
}

// Level 3: 小地域テーブル（町丁字グループ or その下の丁目/基本単位区）
// nodeCode を渡すと、そのノード自身（例: 茅ケ崎南 9桁集計）のピラミッドを頭に表示
function _csDrillSmallAreaTable(cityCode, title, items, popMap, subMap, crumbs, nodeCode = null) {
    ctx.setDetailHtml(`
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                ${_crumbBarHtml(crumbs)}
                <div class="cs-drill-title-row">
                    <h2>${escHtml(title)}</h2>
                </div>
                ${nodeCode ? `<div class="cs-sa-code">${escHtml(nodeCode)}</div>` : ''}
                <div style="font-size:11px;color:#888;padding:2px 0">${items.length}件</div>
            </div>
            <div class="cs-drill-list" id="cs-sa-table-body"></div>
            <div class="cs-drill-display" id="cs-node-pyr"></div>
        </div>
    `);
    _wireCrumbs(crumbs);
    // ノード自身の集計ピラミッドを後追いで表示セクションに描画
    if (nodeCode) {
        fetchSmallAreaPyramid(cityCode, API_BASE).then(pm => {
            const el  = document.getElementById('cs-node-pyr');
            const pyr = pm?.get(nodeCode);
            if (el?.isConnected && pyr) el.innerHTML = _fullChartHtml({ ages: [...pyr.mAges, ...pyr.fAges] });
        }).catch(() => {});
    }
    _populateSmallAreaBody(document.getElementById('cs-sa-table-body'), cityCode, {
        preItems: items,
        prePopMap: popMap,
        onRowClick: _saRowClick(cityCode, popMap, subMap, crumbs),
        hasChild: c => subMap.has(c),
    });
}

// Level 4: 小地域（最下位）→ 名称・コード・人口ピラミッドのみ。秘匿なら理由説明のみ
// ピラミッドは本文で主役として大きく表示（フロートしない）
function _csDrillSmallAreaPyramid(areaName, areaCode, pyr, crumbs) {
    const ages = pyr ? [...pyr.mAges, ...pyr.fAges] : null;
    const body = !ages?.some(v => v > 0)
        ? `<p class="cs-sa-suppressed">この地域は統計上の<b>秘匿</b>対象です。<br>
             対象となる人口が少なく個人が特定されるおそれがあるため、年齢別人口は公表されていません。</p>`
        : _fullChartHtml({ ages });
    ctx.setDetailHtml(`
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                ${_crumbBarHtml(crumbs)}
                <div class="cs-drill-title-row">
                    <h2>${escHtml(areaName)}</h2>
                </div>
                <div class="cs-sa-code">${escHtml(areaCode)}</div>
            </div>
            <div class="cs-drill-display cs-sa-leaf">${body}</div>
        </div>
    `);
    _wireCrumbs(crumbs);
}

// ---- small area table renderer (shared) ------------------------------------

async function _populateSmallAreaBody(bodyEl, code, { withPyramid = true, preItems = null, prePopMap = null, onRowClick = null, hasChild = null } = {}) {
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
        const bodyHtml = items.map(([kc, nm]) => {
            const p = popMap.get(kc);
            const sub = hasChild?.(kc);   // 11桁の子（丁目/基本単位区）を持つ行はドリル可
            const tdPop = `<td class="cs-sa-pop">${p?.total ? p.total.toLocaleString() : '—'}</td>`;
            const tdPyr = withPyramid ? '<td class="cs-sa-bar"></td>' : '';
            const nmCell = sub ? `${esc(nm)} <span class="cs-sa-chev">▸</span>` : esc(nm);
            return `<tr data-code="${esc(kc)}"${sub ? ' class="has-sub"' : ''}>` +
                `<td class="cs-sa-name">${nmCell}</td><td class="cs-sa-codecol">${esc(kc)}</td>${tdPop}${tdPyr}</tr>`;
        }).join('');

        const thPyr = withPyramid
            ? '<th class="cs-sa-bar">年齢構成 <span class="cs-sa-hdleg">（<span class="y">年少</span>|<span class="w">生産</span>|<span class="o">老年</span>）</span></th>'
            : '';
        bodyEl.innerHTML = `
            <div class="cs-sa-scroll">
                <table class="cs-sa-table">
                    <thead><tr><th class="cs-sa-name">名称</th><th>コード</th><th class="cs-sa-pop">人口</th>${thPyr}</tr></thead>
                    <tbody>${bodyHtml}</tbody>
                </table>
            </div>
            <div class="cs-sa-pyramid-wrap" id="cs-sa-pyramid" style="display:none"></div>`;

        // 行クリック（子ドリル可 has-sub、または年齢到着後の has-pyr の行に反応）
        let pyrMap = new Map();
        bodyEl.querySelector('tbody').addEventListener('click', e => {
            const tr = e.target.closest('tr.has-pyr, tr.has-sub');
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
                    _fullChartHtml({ ages: [...pyr.mAges, ...pyr.fAges] });
            }
        });

        // 年齢構成（T082）を後追いで取得 → 該当セルに流し込み
        if (withPyramid) {
            fetchSmallAreaPyramid(code, API_BASE).then(pm => {
                if (!pm?.size || !bodyEl.isConnected) return;   // 画面遷移後は無視
                pyrMap = pm;
                const tbody = bodyEl.querySelector('tbody');
                if (!tbody) return;
                for (const tr of tbody.querySelectorAll('tr')) {
                    const pyr = pyrMap.get(tr.dataset.code);
                    if (!pyr) continue;
                    const cell = tr.querySelector('.cs-sa-bar');
                    if (cell) cell.innerHTML = miniAgeBar(pyr.mAges, pyr.fAges);
                    tr.classList.add('has-pyr');
                }
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
    const chartHtml = chartSections.map(sec => {
        const m = SECTION_META[sec.id] || {};
        const title = m.title ? `<h3>${m.title}${m.year ? ` <span class="cs-year">${m.year}</span>` : ''}</h3>` : '';
        const extra = sec.id === 'pyramid' ? _pyramidLegend(true) : '';
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
