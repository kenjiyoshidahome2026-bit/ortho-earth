import CENSUS_MANIFEST    from './manifest.json'    with { type: 'json' };
import CENSUS_2025_POP    from './2025-pop.json'    with { type: 'json' };
import CENSUS_2020_POP    from './2020-pop.json'    with { type: 'json' };
import CENSUS_2020_STATS  from './2020-stats.json'  with { type: 'json' };
import CENSUS_2015_STATS  from './2015-stats.json'  with { type: 'json' };
import CENSUS_2020_AGES   from './2020-ages.json'   with { type: 'json' };
import CENSUS_2020_HOUSEHOLD from './2020-household.json' with { type: 'json' };
import CENSUS_2015_AGES      from './2015-ages.json'      with { type: 'json' };
import CENSUS_2015_HOUSEHOLD from './2015-household.json' with { type: 'json' };
import SMALL_AREA_DIFF        from './small-area-diff.json' with { type: 'json' };   // 2015↔2020 小地域区分が変わった市区町村: code → [n2015, n2020]
import CITY_HISTORY from '../history.json' with { type: 'json' };   // [YYYYMMDD, "5桁コード", 説明] × 963件（2024-1980）
import CENSUS_KANA        from './kana.json'        with { type: 'json' };
import ESTAT_MANIFEST     from '../estat/manifest.json' with { type: 'json' };
// 政令市・振興局・郡などの行政コード知識は jp/codes.js が正本（1か所管理）
import { DESIGNATED_CITIES, wardParent as _wardParent,
         SHICHO as CENSUS_SHICHO, GUN as CENSUS_GUN } from '../jp/codes.js';
import { buildCensusChartSections, buildPopTrendSVG, popTrendLegendHtml } from './charts.mjs';
import { fetchSmallAreaData, fetchSmallAreaPyramid, fetchSmallAreaStats, miniAgeBar,
         prefetchSmallAreaIdb, isSmallAreaReady } from './small-area.js';
import { prefetchZip, fillZips } from '../zipcode/lookup.js';   // 上位で小地域↔郵便番号を突合
import { PREFS, escHtml } from '../ui/shared.js';
import { ctx } from '../ui/ctx.js';
import { API_BASE } from '../ui/config.js';

// ---- constants -------------------------------------------------------

const ESTAT_CODE_SET = new Set(ESTAT_MANIFEST.map(e => e.code));
const MANIFEST_BY_CODE = new Map(CENSUS_MANIFEST.map(e => [e.code, e]));

// 区名解決用: 現行 manifest に estat manifest（旧区名を含む）を補完してマージ。
// 政令市の区割り再編で manifest から消えた旧区コード（例: 浜松市 旧7区 22131-137）も名称解決できる。
const WARD_NAME = new Map();
for (const e of ESTAT_MANIFEST) WARD_NAME.set(e.code, e.name);
for (const e of CENSUS_MANIFEST) WARD_NAME.set(e.code, e.name);   // 現行 manifest を優先
const _wardName = code => WARD_NAME.get(code) || code;

// 参考「全国平均」の年齢構成（32要素）を年別に返す。
// ★2025基本集計が出たら: 2025-ages.json を import し、この _NAT_AGES に '2025' を1行足すだけで
//   _fullChartHtml / _levelDisplayHtml のピラミッド参考線が 2025 に自動対応する。
const _NAT_AGES = { '2015': CENSUS_2015_AGES, '2020': CENSUS_2020_AGES };
const _natAges = year => (_NAT_AGES[year] || CENSUS_2020_AGES)['_national'];

// ---- 地図バインド用フック（census2020 移植での追記・gishub-jp 正本には無い） --------------
// 各レベルの描画完了（setDetailHtml 後）を通知する。地図側（bind.js/wiki.js）が購読して
// flyTo・境界ロード・Wikipedia カード差し込みを行う＝ドリル UI 自体は地図を知らない（一方向依存）。
const _drillListeners = new Set();
export function onDrill(fn) { _drillListeners.add(fn); return () => _drillListeners.delete(fn); }
function _emit(e) { for (const fn of _drillListeners) { try { fn(e); } catch (err) { console.warn('[drill hook]', err); } } }

// 地図クリック→パネル遷移（プログラム航法）。code: 2桁=都道府県 / 5桁=市区町村（政令市は区一覧へ）
export function drillTo(code, year = '2020') {
    const Y = DRILL_YEARS[year] || DRILL_YEARS['2020'];
    const c = String(code);
    if (c.length === 2) return _dPref(Y, c);
    const prefCode = c.slice(0, 2);
    if (DESIGNATED_CITIES.has(c)) return _dDesignated(Y, c, prefCode);
    return _dCity(Y, c, prefCode, _wardParent(c));
}
// 小地域 KEY_CODE（9/11桁）へ直行（地図の小地域クリック・?area= 復元用）。
// 全国CSV 未取得時は市区町村止まり＝取得ゲートを踏み越えない。
export async function drillToArea(keyCode, year = '2020') {
    const key = String(keyCode);
    const cityCode = key.slice(0, 5);
    if (key.length <= 5 || !(await isSmallAreaReady(year))) return drillTo(cityCode, year);
    const Y = DRILL_YEARS[year] || DRILL_YEARS['2020'];
    const crumbs = _cityCrumbs(Y, cityCode, cityCode.slice(0, 2), _wardParent(cityCode));
    const { items: allItems, popMap } = await fetchSmallAreaData(cityCode, year);
    const subMap = new Map();   // 9桁 → [[11桁, name], ...]（_attachSmallAreaList と同じ再構成）
    for (const [c, n] of allItems) if (c.length === 11) {
        const p = c.slice(0, 9);
        if (!subMap.has(p)) subMap.set(p, []);
        subMap.get(p).push([c, n]);
    }
    const name = allItems.find(([c]) => c === key)?.[1] ?? key;
    if (key.length === 9 && subMap.has(key)) {
        const cc = [...crumbs, { label: name }];
        cc[cc.length - 1].go = () => _csDrillSmallAreaTable(cityCode, name, subMap.get(key), popMap, subMap, cc, key, year);
        cc[cc.length - 1].go();
    } else {
        const pm = await fetchSmallAreaPyramid(cityCode, API_BASE, year).catch(() => null);
        _csDrillSmallAreaPyramid(name, key, pm?.get(key), [...crumbs, { label: _addrShort(name, crumbs[crumbs.length - 1]?.label) }], year);
    }
}

// ---- sidebar entries -------------------------------------------------------

// サイドバー項目は ui/entries.js（正本）へ移動

// ---- list renders -------------------------------------------------------
// 3世代とも共通骨格 _dNational（下方の年度アダプタ DRILL_YEARS 参照）に入る

export function renderCensus2025List() {
    loadPopHistory();
    _dNational(DRILL_YEARS['2025']);
}
export function renderCensus2015List() {
    loadPopHistory();
    _dNational(DRILL_YEARS['2015']);
}
// 旧フラット2020ブラウザは census-small-2020 ドリルダウンへ統合済み。#census2020 直リンク互換の別名のみ残す
export function renderCensus2020List() { return renderCensusSmall2020(); }

// ---- 小地域ドリルダウンブラウザ -------------------------------------------
// 全国 → 都道府県 → 市区町村 → 小地域テーブル
// 各レベル: そのレベルのデータ（人口・チャート）+ 子リスト

export async function renderCensusSmall2020() {
    loadPopHistory();   // 人口推移データを先読み（初回の全国トレンドを速く）
    const ready = await isSmallAreaReady();
    if (!ready) { _csDrillFetch(); return; }
    _dNational(DRILL_YEARS['2020']);
}

// 初回取得パネル（census2020 移植で自動化：本人裁定「必要なデータはある程度最初に読んでいい」＝
// 同意ボタンを待たず取得開始。失敗時のみ再試行ボタンにフォールバック）
function _csDrillFetch() {
    ctx.setDetailHtml(`
        <div class="moj-list-wrap">
            <div class="moj-list-head">
                <h2>小地域 2020（町丁・字等）</h2>
                <p class="moj-subtitle">全国 251,142件の町丁・字等別人口データ（令和2年国勢調査）</p>
            </div>
            <div style="padding:24px 16px">
                <div id="cs-drill-sta" style="font-size:13px;color:#aaa">全国データ（約9MB）を取得しています… 初回のみ・次回以降は即時表示されます</div>
            </div>
        </div>
    `);
    (async () => {
        try { await prefetchSmallAreaIdb(); renderCensusSmall2020(); }
        catch (e) {
            const sta = document.getElementById('cs-drill-sta');
            if (!sta?.isConnected) return;
            sta.innerHTML = `エラー: ${escHtml(e.message)}<br><button id="cs-drill-btn" class="cs-sa-load" style="margin-top:12px;font-size:14px;padding:8px 20px">再試行</button>`;
            document.getElementById('cs-drill-btn').addEventListener('click', () => _csDrillFetch());
        }
    })();
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
// 北海道の市区町村は支庁（振興局）名を後置
function _shichoSuffix(code) {
    const s = CENSUS_SHICHO[code];
    return s ? ` <span class="cs-shicho">（${escHtml(s)}）</span>` : '';
}
// 町村は郡名を前置（住所順）
function _gunPrefix(code) {
    const g = CENSUS_GUN[code];
    return g ? `<span class="cs-gun">${escHtml(g)}</span>` : '';
}

const _crumbNat   = Y => ({ label: '全国', go: () => _dNational(Y) });
const _crumbPref  = (Y, prefCode) => ({ label: _prefFull(prefCode), go: () => _dPref(Y, prefCode) });
const _crumbDesig = (Y, code, prefCode) => ({ label: _wardName(code), go: () => _dDesignated(Y, code, prefCode) });
const _crumbCity  = (Y, code, prefCode, parentCode) => {
    const name   = _wardName(code);
    const parent = parentCode ? _wardName(parentCode) : '';
    return { label: _addrShort(name, parent), go: () => _dCity(Y, code, prefCode, parentCode) };
};

// 全国 → 都道府県 → (政令市) → 市区町村 までのクラム列
function _cityCrumbs(Y, cityCode, prefCode, parentCode) {
    const arr = [_crumbNat(Y), _crumbPref(Y, prefCode)];
    if (parentCode) arr.push(_crumbDesig(Y, parentCode, prefCode));
    arr.push(_crumbCity(Y, cityCode, prefCode, parentCode));
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
        <span class="cs-pl-item"><span class="cs-pl-sw" style="background:#8f0"></span><span class="cs-pl-sw" style="background:#f80"></span>年少 0-14</span>
        <span class="cs-pl-item"><span class="cs-pl-sw" style="background:#88f"></span><span class="cs-pl-sw" style="background:#fcc"></span>生産 15-64</span>
        <span class="cs-pl-item"><span class="cs-pl-sw" style="background:#80f"></span><span class="cs-pl-sw" style="background:#804"></span>老年 65+</span>
        ${hasRef ? '<span class="cs-pl-item cs-pl-ref"><span class="cs-pl-line"></span>全国平均</span>' : ''}
    </div>`;
}

// 人口の KV 行（総数・男・女）
function _popKvRows(label, year, [t, m, f]) {
    return `<div class="cs-kv"><span class="cs-k">${label} <span class="cs-year">${year}</span></span><span class="cs-v">${t.toLocaleString()} 人</span></div>` +
           `<div class="cs-kv"><span class="cs-k">男性</span><span class="cs-v">${m.toLocaleString()} 人</span></div>` +
           `<div class="cs-kv"><span class="cs-k">女性</span><span class="cs-v">${f.toLocaleString()} 人</span></div>`;
}

// 市区町村/政令市パネルの統計行（column-flow 2×3）
// 左列: 人口/男性/女性  右列: 世帯数/面積/密度
function _cityStatsRows(pop20, p25, entry) {
    const kv = (k, v) => `<div class="cs-kv"><span class="cs-k">${k}</span><span class="cs-v">${v}</span></div>`;
    const yr = y => `<span class="cs-year">${y}</span>`;
    const left = [], right = [];
    if (pop20) {
        left.push(kv(`人口 ${yr('2020年')}`, `${pop20[0].toLocaleString()} 人`));
        left.push(kv('男性', `${pop20[1].toLocaleString()} 人`));
        left.push(kv('女性', `${pop20[2].toLocaleString()} 人`));
    }
    if (p25?.hh2020) right.push(kv(`世帯数 ${yr('2020年')}`, `${p25.hh2020.toLocaleString()} 世帯`));
    if (entry?.area)    right.push(kv('面積',     `${entry.area.toLocaleString()} km²`));
    if (entry?.density) right.push(kv('人口密度', `${entry.density.toLocaleString()} 人/km²`));
    return [...left, ...right].join('');
}

// チャート1セクションの HTML（見出し＋SVG＋ピラミッド凡例）
function _sectionHtml(sec, hasRef, year = '2020') {
    const TITLE = { pyramid: '年齢別人口構成', trend: '人口推移', stats: '就業・世帯経済', household: '世帯・住宅' };
    const YEAR  = { pyramid: hasRef ? `${year}年（参考：全国平均）` : `${year}年`, trend: '2015 – 2025', stats: `${year}年`, household: `${year}年` };
    const hd = TITLE[sec.id] ? `<h3 class="cs-drill-sec-h3">${TITLE[sec.id]} <span class="cs-year">${YEAR[sec.id]}</span></h3>` : '';
    const lg = sec.id === 'pyramid' ? _pyramidLegend(hasRef) : '';
    return `<div class="cs-section cs-svg-wrap">${hd}${sec.svg}${lg}</div>`;
}
function _chartSections({ ages = null, refAges, popTrend = null, stat = null, year = '2020' }) {
    return buildCensusChartSections(stat, year, {
        ages:     ages?.length === 32 ? ages : null,
        refAges:  refAges?.length === 32 ? refAges : null,
        popTrend: popTrend?.length >= 2 ? popTrend : null,
    });
}
// 単体ピラミッド（最下位・集計ノード用）
function _fullChartHtml(opts, year = '2020') {
    const natAges = _natAges(year);
    const refAges = opts.refAges === undefined ? natAges : opts.refAges;
    return _chartSections({ ...opts, refAges, year }).map(s => _sectionHtml(s, !!refAges, year)).join('');
}
// ── 人口推移（長期時系列 1980-2020）: pop-history.json を非同期ロード ──────────
// 1MBのためバンドルせず静的配信をランタイムfetch。code→{year:[男少,男生,男老,女少,女生,女老]}
let _popHist = null, _popHistP = null;
export function loadPopHistory() {
    if (_popHist) return Promise.resolve(_popHist);
    if (!_popHistP) _popHistP = fetch(`${import.meta.env.BASE_URL}census/pop-history.json`)
        .then(r => r.ok ? r.json() : null)
        .then(j => { _popHist = j; return j; })
        .catch(e => { console.warn('[pop-history] load failed:', e); _popHistP = null; return null; });
    return _popHistP;
}
const _HYEARS = [1980, 1985, 1990, 1995, 2000, 2005, 2010, 2015, 2020];
// trendCode: 'national'（全47県000行を合算）| 'XX000'(都道府県) | 政令市/市区町村/区コード
function _trendSeries(tc) {
    if (!_popHist || !tc) return null;
    const pts = [];
    for (const y of _HYEARS) {
        const ys = String(y);
        let m = [0, 0, 0], f = [0, 0, 0], has = false;
        if (tc === 'national') {
            for (let p = 1; p <= 47; p++) {
                const v = _popHist[String(p).padStart(2, '0') + '000']?.[ys];
                if (v) { m[0] += v[0]; m[1] += v[1]; m[2] += v[2]; f[0] += v[3]; f[1] += v[4]; f[2] += v[5]; has = true; }
            }
        } else {
            const v = _popHist[tc]?.[ys];
            if (v) { m = [v[0], v[1], v[2]]; f = [v[3], v[4], v[5]]; has = true; }
        }
        if (has) pts.push({ year: y, m, f });
    }
    return pts.length ? pts : null;
}
// 表示中パネルの .cs-trend-slot を pop-history から描画（ロード完了後に後追い）
function _fillTrends() {
    const slots = [...document.querySelectorAll('.cs-trend-slot[data-tc]')];
    if (!slots.length) return;
    loadPopHistory().then(() => {
        for (const slot of slots) {
            const body = slot.querySelector('.cs-trend-body');
            if (!body?.isConnected) continue;
            let pts = _trendSeries(slot.dataset.tc);
            const maxYear = slot.dataset.maxYear ? +slot.dataset.maxYear : null;
            if (pts && maxYear) pts = pts.filter(p => p.year <= maxYear);
            body.innerHTML = pts?.length ? buildPopTrendSVG(pts) + popTrendLegendHtml()
                : '<span style="color:#666;font-size:12px">この地域の人口推移データはありません</span>';
        }
    });
}

// ── 市区町村の沿革（合併・市制施行・政令市/中核市移行・区新設） ──────────────
// コードは5桁文字列（旧整数でも padStart で吸収）。過去は不変・append-only。
const _cityHist = new Map();
for (const [date, code, desc] of CITY_HISTORY) {
    const c = String(code).padStart(5, '0');
    if (!_cityHist.has(c)) _cityHist.set(c, []);
    _cityHist.get(c).push({ date, desc });
}
function _cityHistoryHtml(code) {
    const h = code && _cityHist.get(code);
    if (!h?.length) return '';
    const fmt = d => { const s = String(d); return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`; };
    const items = [...h].sort((a, b) => b.date - a.date).map(e =>
        `<li><span class="cs-hist-date">${fmt(e.date)}</span> ${escHtml(e.desc).replace(/\r\+?/g, '<br>')}</li>`).join('');
    return `<div class="cs-section cs-hist">
        <h3 class="cs-drill-sec-h3">沿革（市区町村の変遷）</h3>
        <ul class="cs-hist-list">${items}</ul></div>`;
}

// 集計/市区町村の表示: 統計テーブル（2列）→ 改行 → SVG群（左寄せで縦に）
// 統計KV + 年齢ピラミッド + 人口推移 + 沿革 + 就業・世帯グラフ（2020/2015 共通）。
// SVG は _chartSections→buildCensusChartSections、セクション枠は _sectionHtml を全年共有。
// year は参考全国値・推移の上限年次・各見出しの年ラベルだけを切り替える。
function _levelDisplayHtml(statsHtml, opts, year = '2020') {
    const natAges = _natAges(year);
    const refAges = opts.refAges === undefined ? natAges : opts.refAges;
    const byId = {};
    for (const s of _chartSections({ ...opts, popTrend: null, refAges, year })) byId[s.id] = _sectionHtml(s, !!refAges, year);
    const maxYearAttr = year === '2015' ? ' data-max-year="2015"' : '';
    const trendRange  = year === '2015' ? '1980 – 2015' : '1980 – 2020';
    const trendSlot = opts.trendCode
        ? `<div class="cs-section cs-svg-wrap cs-trend-slot" data-tc="${opts.trendCode}"${maxYearAttr}>
             <h3 class="cs-drill-sec-h3">人口推移 <span class="cs-year">${trendRange}</span></h3>
             <div class="cs-trend-body"><span class="cs-sa-loading">読み込み中…</span></div>
           </div>`
        : '';
    const histHtml = opts.histCode ? _cityHistoryHtml(opts.histCode) : '';
    return statsHtml + (byId.pyramid || '') + trendSlot + histHtml + (byId.stats || '') + (byId.household || '');
}

// pred(code) を満たす市区町村を積み上げ（人口・世帯・面積・年齢・就業/世帯経済）
// 人口推移は pop-history.json（長期時系列）から trendCode で別途描画
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
        const hhd = CENSUS_2020_HOUSEHOLD[c];
        if (hhd) for (const k of ['fam', 'dwell', 'own']) if (hhd[k]) {
            if (!stat[k]) stat[k] = new Array(hhd[k].length).fill(0);
            hhd[k].forEach((x, i) => { stat[k][i] += x; });
        }
    }
    return {
        pop2020: p20, pop2025: has25 ? p25 : null, hh: hasHh ? hh : 0, area: hasArea ? area : 0, count: leaf.length,
        ages: hasAges ? ages : null, stat: Object.keys(stat).length ? stat : null,
    };
}

// 集計 KV（市区町村と同じ項目: 2020人口・2025人口＆増減率・世帯・面積・密度）
// 件数はセレクタ見出しに出るので KV には含めない
function _aggKvHtml(agg) {
    const rows = [_popKvRows('総人口', '2020年', agg.pop2020)];
    if (agg.hh)   rows.push(`<div class="cs-kv"><span class="cs-k">世帯数 <span class="cs-year">2020年</span></span><span class="cs-v">${agg.hh.toLocaleString()} 世帯</span></div>`);
    if (agg.area) {
        rows.push(`<div class="cs-kv"><span class="cs-k">面積</span><span class="cs-v">${Math.round(agg.area).toLocaleString()} km²</span></div>`);
        rows.push(`<div class="cs-kv"><span class="cs-k">人口密度</span><span class="cs-v">${Math.round(agg.pop2020[0] / agg.area).toLocaleString()} 人/km²</span></div>`);
    }
    return `<div class="cs-kv-grid">${rows.join('')}</div>`;
}

// 指定年の実データに存在する cityCode 配下の区一覧 [{code, name}]。
// manifest（現行境界）ではなく各年データのキーから作るので、政令市の区割り再編
// （例: 浜松市 2024年 7区→3区）があっても年ごとに正しい区が並ぶ。
function _wardsForYear(cityCode, year) {
    const data = year === '2025' ? CENSUS_2025_POP
               : year === '2015' ? CENSUS_2015_STATS
               : CENSUS_2020_POP;
    return Object.keys(data)
        .filter(k => _wardParent(k) === cityCode)
        .sort()
        .map(code => ({ code, name: _wardName(code) }));
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

// ==== 年度共通ドリルダウン骨格 ==============================================
// 全国→都道府県→(政令市)→市区町村 のナビは3世代で完全に同型＝骨格を1本にし、
// 年度差は DRILL_YEARS のアダプタに閉じる（政令指定都市・区→親市の解決は jp/codes.js 正本）。
//   leafPops()          全国合算に使う葉 [code, 人口] 列。2025の集約行（政令市+特別区部）除外もここ
//   hasCity(code)       都道府県チップに載せる条件
//   chipSub/chipExtra   チップの人口ラベル・増減バッジ
//   aggChartHtml()      集計レベル（全国/県/政令市）の統計+チャートHTML
//   cityBody(code)      市区町村（終端）の表示HTMLと小地域設定（saYear=null で小地域なし）
// 新年度の追加＝アダプタを1個足すだけ。葉集合の不変条件（集約行を混ぜない）はアダプタ内で守る。

const DRILL_YEARS = {
    '2020': {
        year: '2020',
        notice: '',
        nationalOpts: { ages: CENSUS_2020_AGES['_national'], refAges: null },   // 全国は precomputed（参考線なし）
        hasCity: () => true,
        leafPops: () => Object.entries(CENSUS_2020_POP).map(([c, v]) => [c, v[0]]),
        chipSub: code => _popLabel(_cityPop2020(code)?.[0]),
        chipExtra: () => '',
        aggChartHtml(pred, { trendCode, histCode, ages, refAges }) {
            const agg = _aggForLevel(pred);
            return _levelDisplayHtml(_aggKvHtml(agg), {
                ages: ages || agg.ages,
                refAges: refAges !== undefined ? refAges : CENSUS_2020_AGES['_national'],
                trendCode, histCode, stat: agg.stat,
            });
        },
        cityBody(cityCode) {
            const entry = MANIFEST_BY_CODE.get(cityCode);
            const statsHtml = `<div class="cs-kv-grid">${_cityStatsRows(CENSUS_2020_POP[cityCode], CENSUS_2025_POP[cityCode], entry)}</div>`;
            return {
                display: _levelDisplayHtml(statsHtml, {
                    ages: CENSUS_2020_AGES[cityCode], refAges: CENSUS_2020_AGES['_national'],
                    trendCode: cityCode, histCode: cityCode, stat: CENSUS_2020_STATS[cityCode],
                }),
                saYear: '2020', saAvailable: ESTAT_CODE_SET.has(cityCode),
                diffNote: _smallAreaDiffNoteHtml(cityCode),
            };
        },
    },
    '2015': {
        year: '2015',
        notice: '',
        nationalOpts: {},
        hasCity: code => !!(CENSUS_2015_STATS[code] || DESIGNATED_CITIES.has(code)),
        leafPops: () => Object.entries(CENSUS_2015_STATS).map(([c, t]) => [c, t.pop[0]]),
        chipSub(code) {
            let pop = CENSUS_2015_STATS[code]?.pop?.[0];
            if (!pop && DESIGNATED_CITIES.has(code)) {   // 政令市は区コードを合算
                for (const [k, t] of Object.entries(CENSUS_2015_STATS))
                    if (_wardParent(k) === code) pop = (pop || 0) + t.pop[0];
            }
            return pop ? _popLabel(pop) : '';
        },
        chipExtra: () => '',
        aggChartHtml(pred, { trendCode, histCode }) {
            const agg = _agg15ForLevel(pred);
            return _levelDisplayHtml(_agg15KvHtml(agg), { trendCode, histCode, stat: agg.stat, ages: agg.ages }, '2015');
        },
        cityBody(cityCode) {
            const entry = MANIFEST_BY_CODE.get(cityCode);
            const stat  = CENSUS_2015_STATS[cityCode];
            const hhd15 = CENSUS_2015_HOUSEHOLD[cityCode];
            const chartStat = stat ? { ...stat } : null;
            if (chartStat && hhd15) for (const k of ['fam', 'dwell', 'own']) if (hhd15[k]) chartStat[k] = hhd15[k];
            const statsHtml = `<div class="cs-kv-grid">${_city15StatsRows(stat, entry)}</div>`;
            return {
                display: _levelDisplayHtml(statsHtml, { trendCode: cityCode, histCode: cityCode, stat: chartStat, ages: CENSUS_2015_AGES[cityCode] }, '2015'),
                saYear: '2015', saAvailable: true, diffNote: '',
            };
        },
    },
    // 速報集計のみ（年齢・就業・住宅なし）。基本集計（2026年秋公開予定）が出たら
    // aggChartHtml/cityBody を _levelDisplayHtml ベースへ差し替え + saYear:'2025'
    // （小地域側の差し込み手順は census/small-area.js の YEARS 内 2025 テンプレコメント参照）
    '2025': {
        year: '2025',
        notice: `<p class="cs-notice">速報集計（人口・世帯）のみ公開中。人口等基本集計（年齢・世帯・住居）は 2026年9月、就業状態等基本集計は 2027年3月 公表予定。</p>`,
        nationalOpts: {},
        hasCity: code => !!CENSUS_2025_POP[code],
        leafPops() {   // 集約行（政令市20市+特別区部）を除外＝二重計上ガードの正本（_agg25ForLevel と同一集合）
            const out = [];
            for (const [c, p] of Object.entries(CENSUS_2025_POP))
                if (!c.endsWith('000') && !_AGG25_ROWS.has(c)) out.push([c, p.pop[0]]);
            return out;
        },
        chipSub(code) { const p = CENSUS_2025_POP[code]; return p ? _popLabel(p.pop[0]) : ''; },
        chipExtra(code) {
            const p = CENSUS_2025_POP[code];
            return p ? `<span class="pop-chg ${p.popChange >= 0 ? 'pos' : 'neg'} cs-chip-sub">${p.popChange >= 0 ? '+' : ''}${p.popChange.toFixed(1)}%</span>` : '';
        },
        aggChartHtml(pred, { trendCode, histCode }) {
            const agg = _agg25ForLevel(pred);
            return _level25DisplayHtml(_agg25KvHtml(agg), { trendCode, histCode });
        },
        cityBody(cityCode) {
            const entry = MANIFEST_BY_CODE.get(cityCode);
            const p25   = CENSUS_2025_POP[cityCode];
            const popTrend = [];
            const pop2015 = CENSUS_2015_STATS[cityCode];
            const pop2020 = CENSUS_2020_POP[cityCode];
            if (pop2015?.pop) popTrend.push({ year: 2015, male: pop2015.pop[1], female: pop2015.pop[2] });
            if (pop2020)      popTrend.push({ year: 2020, male: pop2020[1], female: pop2020[2] });
            if (p25?.pop)     popTrend.push({ year: 2025, male: p25.pop[1], female: p25.pop[2] });
            const ages2020 = CENSUS_2020_AGES[cityCode];
            const stat2020 = { ...(CENSUS_2020_STATS[cityCode] || {}), ...(CENSUS_2020_HOUSEHOLD[cityCode] || {}) };
            const has2020  = ages2020?.length === 32 || Object.keys(stat2020).length > 0;
            const statsHtml = `<div class="cs-kv-grid">${_city25StatsRows(p25, entry)}</div>`;
            return {
                display: _level25DisplayHtml(statsHtml, {
                    trendCode: cityCode, histCode: cityCode,
                    popTrend: popTrend.length >= 2 ? popTrend : null,
                    ref2020: has2020 ? { stat: stat2020, ages: ages2020, natAges: CENSUS_2020_AGES['_national'] } : null,
                }),
                saYear: null, saAvailable: false, diffNote: '',
            };
        },
    },
};

// 集計レベル（全国/都道府県/政令市）共通ビュー: 積み上げ統計＋全チャート＋子チップ
function _renderAggViewY(Y, { crumbs = null, title, pred, trendCode = null, histCode = null, listHtml, onChip, ...opts }) {
    ctx.setDetailHtml(_drillWrap({
        crumbs, title,
        chartHtml: Y.aggChartHtml(pred, { trendCode, histCode, ...opts }),
        listHtml,
    }));
    if (crumbs) _wireCrumbs(crumbs);
    _fillTrends();
    document.querySelectorAll('.cs-drill-chip[data-key]').forEach(el =>
        el.addEventListener('click', () => onChip(el.dataset.key)));
}

// 市区町村/区チップのリスト HTML（人口ラベル・増減バッジ付き）
function _chipsHtml(Y, headTitle, headCount, items) {
    return `<h3 class="cs-drill-sec-h3">${headTitle} <span class="cs-year">${headCount}</span></h3>
        <div class="cs-drill-chips">${items.map(c => {
            const sub = Y.chipSub(c.code);
            return `<span class="cs-drill-chip" data-key="${c.code}">${escHtml(c.name)}${sub ? `<span class="cs-chip-sub">${sub}</span>` : ''}${Y.chipExtra(c.code)}</span>`;
        }).join('')}</div>`;
}

// Level 0: 全国
function _dNational(Y) {
    const byPref = new Map();
    for (const [code, pop] of Y.leafPops()) {
        const pref = code.slice(0, 2);
        byPref.set(pref, (byPref.get(pref) || 0) + pop);
    }
    const listHtml = Y.notice + `<h3 class="cs-drill-sec-h3">都道府県 <span class="cs-year">47都道府県</span></h3>
        <div class="cs-drill-chips">${
        [...byPref.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([pref, pop]) =>
            `<span class="cs-drill-chip" data-key="${pref}">${PREFS[pref] || pref}<span class="cs-chip-sub">${_popLabel(pop)}</span></span>`
        ).join('')}</div>`;
    _renderAggViewY(Y, {
        title: _rubyHtml('全国', 'ぜんこく'), pred: () => true, trendCode: 'national',
        listHtml, onChip: pref => _dPref(Y, pref),
        ...Y.nationalOpts,
    });
    _emit({ level: 'national', year: Y.year });
}

// Level 1: 都道府県
function _dPref(Y, prefCode) {
    // 政令指定都市の区は除外（政令指定都市自体は残す）
    const topCities = CENSUS_MANIFEST.filter(e =>
        e.pref === prefCode && !e.code.endsWith('000') && !_wardParent(e.code) && Y.hasCity(e.code));
    _renderAggViewY(Y, {
        crumbs: [_crumbNat(Y), _crumbPref(Y, prefCode)],
        title: _rubyHtml(_prefFull(prefCode), CENSUS_KANA[prefCode]),
        pred: c => c.slice(0, 2) === prefCode, trendCode: prefCode + '000',
        listHtml: _chipsHtml(Y, '市区町村', `${topCities.length}件`, topCities),
        onChip: code => DESIGNATED_CITIES.has(code) ? _dDesignated(Y, code, prefCode) : _dCity(Y, code, prefCode, null),
    });
    _emit({ level: 'pref', code: prefCode, year: Y.year });
}

// Level 1.5: 政令指定都市 → 区一覧（区を積み上げ）
function _dDesignated(Y, cityCode, prefCode) {
    const wards = _wardsForYear(cityCode, Y.year);
    _renderAggViewY(Y, {
        crumbs: [_crumbNat(Y), _crumbPref(Y, prefCode), _crumbDesig(Y, cityCode, prefCode)],
        title: _rubyHtml(MANIFEST_BY_CODE.get(cityCode)?.name || cityCode, CENSUS_KANA[cityCode]) + _shichoSuffix(cityCode),
        pred: c => _wardParent(c) === cityCode, trendCode: cityCode, histCode: cityCode,
        listHtml: _chipsHtml(Y, '行政区', `${wards.length}区`, wards),
        onChip: code => _dCity(Y, code, prefCode, cityCode),
    });
    _emit({ level: 'designated', code: cityCode, pref: prefCode, year: Y.year });
}

// Level 2: 市区町村（終端）
function _dCity(Y, cityCode, prefCode, parentCode = null) {
    const cityName = MANIFEST_BY_CODE.get(cityCode)?.name || _wardName(cityCode);
    const crumbs   = _cityCrumbs(Y, cityCode, prefCode, parentCode);
    const { display, saYear, saAvailable, diffNote } = Y.cityBody(cityCode);
    ctx.setDetailHtml(`
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                ${_crumbBarHtml(crumbs)}
                <div class="cs-drill-title-row">
                    <h2>${_gunPrefix(cityCode)}${_rubyHtml(cityName, CENSUS_KANA[cityCode])}${_shichoSuffix(cityCode)}</h2>
                </div>
            </div>
            ${saYear ? _smallAreaListSectionHtml(saYear, saAvailable, diffNote) : ''}
            <div class="cs-drill-display">${display}</div>
        </div>
    `);
    _wireCrumbs(crumbs);
    _fillTrends();
    if (saYear && saAvailable)
        _attachSmallAreaGated(document.getElementById('cs-drill-sa'), cityCode, crumbs, saYear);
    _emit({ level: 'city', code: cityCode, pref: prefCode, parent: parentCode, year: Y.year });
}

// 小地域アタッチのゲート（裁定: 2020のボタン同意式に全年度統一。2015も無断9.6MB DLしない）
// 当該年の全国CSVが未取得なら同意ボタンを出し、取得済みなら即アタッチ（2回目以降は即時）。
async function _attachSmallAreaGated(saEl, cityCode, crumbs, year) {
    if (!saEl) return;
    if (await isSmallAreaReady(year)) { _attachSmallAreaList(saEl, cityCode, crumbs, year); return; }
    saEl.innerHTML = `
        <p style="color:#aaa;font-size:12px;margin:4px 0 8px">初回のみ全国データ（約9MB）をダウンロードしてブラウザに保存します。次回以降は即時表示されます。</p>
        <button class="cs-sa-load">全国データを取得</button>
        <div class="cs-sa-gate-sta" style="margin-top:8px;font-size:12px;color:#aaa"></div>`;
    saEl.querySelector('.cs-sa-load').addEventListener('click', async ev => {
        const sta = saEl.querySelector('.cs-sa-gate-sta');
        ev.target.disabled = true; sta.textContent = '取得中...';
        try {
            await prefetchSmallAreaIdb(year);
            if (!(await isSmallAreaReady(year))) throw new Error('取得に失敗しました');
            _attachSmallAreaList(saEl, cityCode, crumbs, year);
        } catch (e) { sta.textContent = `エラー: ${e.message}`; ev.target.disabled = false; }
    });
}

// 市区町村詳細に差し込む小地域セクションの枠（2020/2015 共通）。
// available=false（2020で境界データが無いコード）は静的に「データなし」を表示。
// diffNote: 2015からの小地域区分変更の注記HTML（該当市区町村のみ・任意）。
function _smallAreaListSectionHtml(year, available = true, diffNote = '') {
    const inner = available
        ? '<div id="cs-drill-sa"><span class="cs-sa-loading">小地域データ読み込み中…</span></div>'
        : '<div style="color:#666;font-size:12px;padding:4px 0">小地域データなし</div>';
    return `<div class="cs-drill-list">
                <h3 class="cs-drill-sec-h3">小地域（町丁・字等） <span class="cs-year">${year}年</span></h3>
                ${diffNote}
                ${inner}
            </div>`;
}

// 2015→2020 で小地域区分が変わった市区町村の中立注記（区域数のみ）。該当なしは空文字。
function _smallAreaDiffNoteHtml(cityCode) {
    const d = SMALL_AREA_DIFF[cityCode];
    if (!d) return '';
    return `<div style="color:#d9a441;font-size:11px;padding:2px 0 6px">⚠ 2015年から小地域区分が変更されています（区域数 ${d[0]} → ${d[1]}）</div>`;
}

// 市区町村の小地域一覧を saEl に流し込む（2020/2015 共通）。
// crumbs = 市区町村レベルのパンくず。クリックで町丁字グループ → テーブル → ピラミッドへドリルする。
async function _attachSmallAreaList(saEl, cityCode, crumbs, year = '2020') {
    if (!saEl) return;
    prefetchZip();   // 小地域に潜る前に郵便番号を先読み（非ブロッキング）
    try {
        const { items: allItems, popMap } = await fetchSmallAreaData(cityCode, year);
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
                onRowClick: _saRowClick(cityCode, popMap, subMap, crumbs, year),
                hasChild: c => subMap.has(c),
                year,
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
                const gc = crumbs.slice();   // 市区町村レベルから分岐する新パンくず
                // 単一町丁字＋子（丁目）あり → 中間の1行テーブルを挟まず丁目＋集計ピラミッドへ直行
                if (d.items.length === 1 && subMap.has(d.items[0][0])) {
                    const [code, name] = d.items[0];
                    gc.push({ label: name, go: () => _csDrillSmallAreaTable(cityCode, name, subMap.get(code), popMap, subMap, gc, code, year) });
                    _csDrillSmallAreaTable(cityCode, name, subMap.get(code), popMap, subMap, gc, code, year);
                    return;
                }
                gc.push({ label: g, go: () => _csDrillSmallAreaTable(cityCode, g, d.items, popMap, subMap, gc, null, year) });
                _csDrillSmallAreaTable(cityCode, g, d.items, popMap, subMap, gc, null, year);
            })
        );
    } catch (e) { saEl.textContent = `エラー: ${e.message}`; }
}

// 小地域テーブルの行クリック: 11桁の子（丁目/基本単位区）があればドリル、なければピラミッド
function _saRowClick(cityCode, popMap, subMap, crumbs, year = '2020') {
    return (areaCode, areaName, pyr) => {
        const kids = subMap.get(areaCode);
        if (kids?.length) {
            // グループ名＝町丁字名なら重複クラムを避けて置き換え
            const base = crumbs[crumbs.length - 1]?.label === areaName ? crumbs.slice(0, -1) : crumbs;
            const cc = [...base, { label: areaName }];
            cc[cc.length - 1].go = () => _csDrillSmallAreaTable(cityCode, areaName, kids, popMap, subMap, cc, areaCode, year);
            _csDrillSmallAreaTable(cityCode, areaName, kids, popMap, subMap, cc, areaCode, year);
        } else {
            const short = _addrShort(areaName, crumbs[crumbs.length - 1]?.label);
            _csDrillSmallAreaPyramid(areaName, areaCode, pyr, [...crumbs, { label: short }], year);
        }
    };
}

// Level 3: 小地域テーブル（町丁字グループ or その下の丁目/基本単位区）
// nodeCode を渡すと、そのノード自身（例: 茅ケ崎南 9桁集計）のピラミッドを頭に表示
function _csDrillSmallAreaTable(cityCode, title, items, popMap, subMap, crumbs, nodeCode = null, year = '2020') {
    ctx.setDetailHtml(`
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                ${_crumbBarHtml(crumbs)}
                <div class="cs-drill-title-row">
                    <h2>${escHtml(title)}</h2>
                </div>
                ${nodeCode ? `<div class="cs-sa-code">${escHtml(nodeCode)} <span data-zip-code="${escHtml(nodeCode)}"></span></div>` : ''}
                <div style="font-size:11px;color:#888;padding:2px 0">${items.length}件</div>
            </div>
            <div class="cs-drill-list" id="cs-sa-table-body"></div>
            <div class="cs-drill-display" id="cs-node-pyr"></div>
            <div class="cs-drill-display" id="cs-node-stats"></div>
        </div>
    `);
    _wireCrumbs(crumbs);
    fillZips();
    // ノード自身の集計ピラミッド・就業世帯経済を後追いで表示セクションに描画
    if (nodeCode) {
        fetchSmallAreaPyramid(cityCode, API_BASE, year).then(pm => {
            const el  = document.getElementById('cs-node-pyr');
            const pyr = pm?.get(nodeCode);
            if (el?.isConnected && pyr) el.innerHTML = _fullChartHtml({ ages: [...pyr.mAges, ...pyr.fAges] }, year);
        }).catch(() => {});
        fetchSmallAreaStats(cityCode, API_BASE, year).then(sm => {
            const el   = document.getElementById('cs-node-stats');
            const stat = sm?.get(nodeCode);
            if (el?.isConnected && stat) el.innerHTML = _chartSections({ stat, year })
                .filter(s => s.id === 'stats').map(s => _sectionHtml(s, false, year)).join('');
        }).catch(() => {});
    }
    _populateSmallAreaBody(document.getElementById('cs-sa-table-body'), cityCode, {
        preItems: items,
        prePopMap: popMap,
        onRowClick: _saRowClick(cityCode, popMap, subMap, crumbs, year),
        hasChild: c => subMap.has(c),
        year,
    });
    _emit({ level: 'sa-table', city: cityCode, code: nodeCode, title, year });
}

// Level 4: 小地域（最下位）→ 名称・コード・人口ピラミッドのみ。秘匿なら理由説明のみ
// ピラミッドは本文で主役として大きく表示（フロートしない）
function _csDrillSmallAreaPyramid(areaName, areaCode, pyr, crumbs, year = '2020') {
    const ages = pyr ? [...pyr.mAges, ...pyr.fAges] : null;
    const body = !ages?.some(v => v > 0)
        ? `<p class="cs-sa-suppressed">この地域は統計上の<b>秘匿</b>対象です。<br>
             対象となる人口が少なく個人が特定されるおそれがあるため、年齢別人口は公表されていません。</p>`
        : _fullChartHtml({ ages }, year);
    ctx.setDetailHtml(`
        <div class="cs-drill-wrap census-detail">
            <div class="cs-drill-head">
                ${_crumbBarHtml(crumbs)}
                <div class="cs-drill-title-row">
                    <h2>${escHtml(areaName)}</h2>
                </div>
                <div class="cs-sa-code">${escHtml(areaCode)} <span data-zip-code="${escHtml(areaCode)}"></span></div>
            </div>
            <div class="cs-drill-display cs-sa-leaf">${body}<div id="cs-sa-statslot"></div></div>
        </div>
    `);
    _wireCrumbs(crumbs);
    fillZips();
    _emit({ level: 'sa-leaf', code: areaCode, city: areaCode.slice(0, 5), name: areaName, year });
    // 就業・世帯経済は都道府県ZIP取得後に後追い描画
    fetchSmallAreaStats(areaCode.slice(0, 5), API_BASE, year).then(sm => {
        const stat = sm.get(areaCode);
        const slot = document.getElementById('cs-sa-statslot');
        if (!slot?.isConnected || !stat) return;
        slot.innerHTML = _chartSections({ stat, year })
            .filter(s => s.id === 'stats')
            .map(s => _sectionHtml(s, false, year)).join('');
    }).catch(() => {});
}

// ---- small area table renderer (shared) ------------------------------------

async function _populateSmallAreaBody(bodyEl, code, { withPyramid = true, preItems = null, prePopMap = null, onRowClick = null, hasChild = null, year = '2020' } = {}) {
    bodyEl.innerHTML = '<span class="cs-sa-loading">読み込み中…</span>';
    try {
        // 人口（IDB）は即時。年齢ピラミッド（T082）は待たずに後追い描画する。
        let items, popMap;
        if (preItems && prePopMap) {
            items = preItems; popMap = prePopMap;
        } else {
            const r = await fetchSmallAreaData(code, year);
            popMap = r.popMap;
            // 9桁＝町丁・字等（正準層）。11桁＝基本単位区は下位のため除外
            const nine = r.items.filter(([c]) => c.length === 9);
            items = nine.length ? nine : r.items;
        }

        if (!items.length) { bodyEl.textContent = 'データなし'; return; }

        const esc = escHtml;   // 属性位置（data-code="…"）にも使うため引用符も落とす共通版を使用

        // 年齢構成列は withPyramid 時に枠だけ用意（中身は後追いで流し込む）
        const bodyHtml = items.map(([kc, nm]) => {
            const p = popMap.get(kc);
            const sub = hasChild?.(kc);   // 11桁の子（丁目/基本単位区）を持つ行はドリル可
            const tdPop = `<td class="cs-sa-pop">${p?.total ? p.total.toLocaleString() : '—'}</td>`;
            const tdPyr = withPyramid ? '<td class="cs-sa-bar"></td>' : '';
            const nmCell = (sub ? `${esc(nm)} <span class="cs-sa-chev">▸</span>` : esc(nm)) +
                `<span class="cs-sa-ziprow" data-zip-code="${esc(kc)}"></span>`;
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
        fillZips(bodyEl);

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
                    _fullChartHtml({ ages: [...pyr.mAges, ...pyr.fAges] }, year);
            }
        });

        // 年齢構成（T082）を後追いで取得 → 該当セルに流し込み
        if (withPyramid) {
            fetchSmallAreaPyramid(code, API_BASE, year).then(pm => {
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

// ---- 国勢調査 2015 ドリルダウン -------------------------------------------
// 全国 → 都道府県 → 市区町村（小地域なし）
// データ: CENSUS_2015_STATS[code] = { pop:[t,m,f], hh, ind:[], occ:[], eco:[] }

function _agg15ForLevel(pred) {
    const pop = [0, 0, 0];
    const ages = new Array(32).fill(0);
    let hh = 0, area = 0, hasHh = false, hasArea = false, hasAges = false;
    const stat = {};
    for (const [code, s] of Object.entries(CENSUS_2015_STATS)) {
        if (!pred(code)) continue;
        pop[0] += s.pop[0]; pop[1] += s.pop[1]; pop[2] += s.pop[2];
        if (s.hh) { hh += s.hh; hasHh = true; }
        const m = MANIFEST_BY_CODE.get(code);
        if (m?.area) { area += m.area; hasArea = true; }
        for (const k of ['ind', 'occ', 'eco']) if (s[k]) {
            if (!stat[k]) stat[k] = new Array(s[k].length).fill(0);
            s[k].forEach((x, i) => { stat[k][i] += x; });
        }
        const a = CENSUS_2015_AGES[code];
        if (a?.length === 32) { a.forEach((x, i) => { ages[i] += x; }); hasAges = true; }
        const hhd = CENSUS_2015_HOUSEHOLD[code];
        if (hhd) for (const k of ['fam', 'dwell', 'own']) if (hhd[k]) {
            if (!stat[k]) stat[k] = new Array(hhd[k].length).fill(0);
            hhd[k].forEach((x, i) => { stat[k][i] += x; });
        }
    }
    return {
        pop, hh: hasHh ? hh : 0, area: hasArea ? area : 0,
        ages: hasAges ? ages : null, stat: Object.keys(stat).length ? stat : null,
    };
}

function _agg15KvHtml(agg) {
    const kv = (k, v) => `<div class="cs-kv"><span class="cs-k">${k}</span><span class="cs-v">${v}</span></div>`;
    const yr = y => `<span class="cs-year">${y}</span>`;
    const left = [
        kv(`総人口 ${yr('2015年')}`, `${agg.pop[0].toLocaleString()} 人`),
        kv('男性', `${agg.pop[1].toLocaleString()} 人`),
        kv('女性', `${agg.pop[2].toLocaleString()} 人`),
    ];
    const right = [];
    if (agg.hh)   right.push(kv(`世帯数 ${yr('2015年')}`, `${agg.hh.toLocaleString()} 世帯`));
    if (agg.area) {
        right.push(kv('面積', `${Math.round(agg.area).toLocaleString()} km²`));
        right.push(kv('人口密度', `${Math.round(agg.pop[0] / agg.area).toLocaleString()} 人/km²`));
    }
    return `<div class="cs-kv-grid">${[...left, ...right].join('')}</div>`;
}

function _city15StatsRows(stat, entry) {
    const kv = (k, v) => `<div class="cs-kv"><span class="cs-k">${k}</span><span class="cs-v">${v}</span></div>`;
    const yr = y => `<span class="cs-year">${y}</span>`;
    const left = [], right = [];
    if (stat?.pop) {
        left.push(kv(`人口 ${yr('2015年')}`, `${stat.pop[0].toLocaleString()} 人`));
        left.push(kv('男性', `${stat.pop[1].toLocaleString()} 人`));
        left.push(kv('女性', `${stat.pop[2].toLocaleString()} 人`));
    }
    if (stat?.hh)       right.push(kv(`世帯数 ${yr('2015年')}`, `${stat.hh.toLocaleString()} 世帯`));
    if (entry?.area)    right.push(kv('面積',     `${entry.area.toLocaleString()} km²`));
    if (entry?.density) right.push(kv('人口密度', `${entry.density.toLocaleString()} 人/km²`));
    return [...left, ...right].join('');
}

// ---- 国勢調査 2025 集計・表示（ナビ骨格は DRILL_YEARS['2025'] が駆動） ------
// データ: CENSUS_2025_POP[code] = { pop:[t,m,f], pop2020, popChange, hh, hh2020 }
// 政令市の区割り（浜松市 新3区）は _wardsForYear が 2025 データから自動生成済みで対応不要。

// 2025-pop.json は 2020/2015 と違い葉のみでない：政令市20市と東京特別区部(13100)の
// 集約行が区の葉と同居する。合算時に両方を足すと二重計上（全国が1.6億人になる）。
const _AGG25_ROWS = new Set([...DESIGNATED_CITIES, '13100']);

function _agg25ForLevel(pred) {
    const pop = [0, 0, 0];
    let hh = 0, hh20 = 0, pop20 = 0, area = 0;
    let hasHh = false, hasArea = false, hasPop20 = false;
    for (const [code, p] of Object.entries(CENSUS_2025_POP)) {
        if (code.endsWith('000') || _AGG25_ROWS.has(code)) continue;
        if (!pred(code)) continue;
        pop[0] += p.pop[0]; pop[1] += p.pop[1]; pop[2] += p.pop[2];
        if (p.hh)     { hh += p.hh; hh20 += (p.hh2020 || 0); hasHh = true; }
        if (p.pop2020){ pop20 += p.pop2020; hasPop20 = true; }
        const m = MANIFEST_BY_CODE.get(code);
        if (m?.area) { area += m.area; hasArea = true; }
    }
    return { pop, hh: hasHh ? hh : 0, hh20: hasHh ? hh20 : 0,
             pop20: hasPop20 ? pop20 : 0, area: hasArea ? area : 0 };
}

function _agg25KvHtml(agg) {
    const kv  = (k, v) => `<div class="cs-kv"><span class="cs-k">${k}</span><span class="cs-v">${v}</span></div>`;
    const yr  = y => `<span class="cs-year">${y}</span>`;
    const chgHtml = (val, ref) => {
        const r = ((val - ref) / ref * 100);
        const s = r >= 0 ? `+${r.toFixed(1)}` : r.toFixed(1);
        return ` <span class="pop-chg ${r >= 0 ? 'pos' : 'neg'}">${s}%</span>`;
    };
    const left = [
        kv(`総人口 ${yr('2025年')}`, `${agg.pop[0].toLocaleString()} 人`),
        kv('男性', `${agg.pop[1].toLocaleString()} 人`),
        kv('女性', `${agg.pop[2].toLocaleString()} 人`),
    ];
    if (agg.pop20 > 0)
        left.push(kv(`人口 ${yr('2020年')}`, `${agg.pop20.toLocaleString()} 人${chgHtml(agg.pop[0], agg.pop20)}`));
    const right = [];
    if (agg.hh) {
        right.push(kv(`世帯数 ${yr('2025年')}`, `${agg.hh.toLocaleString()} 世帯`));
        if (agg.hh20 > 0)
            right.push(kv(`世帯数 ${yr('2020年')}`, `${agg.hh20.toLocaleString()} 世帯${chgHtml(agg.hh, agg.hh20)}`));
    }
    if (agg.area) {
        right.push(kv('面積', `${Math.round(agg.area).toLocaleString()} km²`));
        right.push(kv('人口密度', `${Math.round(agg.pop[0] / agg.area).toLocaleString()} 人/km²`));
    }
    return `<div class="cs-kv-grid">${[...left, ...right].join('')}</div>`;
}

function _city25StatsRows(p25, entry) {
    const kv = (k, v) => `<div class="cs-kv"><span class="cs-k">${k}</span><span class="cs-v">${v}</span></div>`;
    const yr = y => `<span class="cs-year">${y}</span>`;
    const left = [], right = [];
    if (p25?.pop) {
        const chgSign = p25.popChange >= 0 ? `+${p25.popChange.toFixed(1)}` : p25.popChange.toFixed(1);
        const chgCl   = p25.popChange >= 0 ? 'pos' : 'neg';
        left.push(kv(`人口 ${yr('2025年')}`, `${p25.pop[0].toLocaleString()} 人 <span class="pop-chg ${chgCl}">${chgSign}%</span>`));
        left.push(kv('男性', `${p25.pop[1].toLocaleString()} 人`));
        left.push(kv('女性', `${p25.pop[2].toLocaleString()} 人`));
    }
    if (p25?.hh) {
        let hhStr = `${p25.hh.toLocaleString()} 世帯`;
        if (p25.hh2020) {
            const r = (p25.hh - p25.hh2020) / p25.hh2020 * 100;
            const s = r >= 0 ? `+${r.toFixed(1)}` : r.toFixed(1);
            hhStr += ` <span class="pop-chg ${r >= 0 ? 'pos' : 'neg'}">${s}%</span>`;
        }
        right.push(kv(`世帯数 ${yr('2025年')}`, hhStr));
        if (p25.hh2020) right.push(kv(`世帯数 ${yr('2020年')}`, `${p25.hh2020.toLocaleString()} 世帯`));
    }
    if (entry?.area)    right.push(kv('面積',     `${entry.area.toLocaleString()} km²`));
    if (entry?.density) right.push(kv('人口密度', `${entry.density.toLocaleString()} 人/km²`));
    return [...left, ...right].join('');
}

function _level25DisplayHtml(statsHtml, { trendCode = null, histCode = null, popTrend = null, ref2020 = null }) {
    let trendHtml = '';
    if (popTrend?.length >= 2) {
        // 市区町村: 2015→2020→2025 の3点グラフ（inline, pop-history不要）
        const secs = buildCensusChartSections(null, '2025', { popTrend });
        const sec  = secs.find(s => s.id === 'trend');
        if (sec?.svg) {
            trendHtml = `<div class="cs-section cs-svg-wrap">
                <h3 class="cs-drill-sec-h3">人口推移 <span class="cs-year">2015 – 2025</span></h3>
                ${sec.svg}${popTrendLegendHtml()}
            </div>`;
        }
    } else if (trendCode) {
        // 集計レベル: pop-history から非同期描画（1980–2020）
        trendHtml = `<div class="cs-section cs-svg-wrap cs-trend-slot" data-tc="${trendCode}">
             <h3 class="cs-drill-sec-h3">人口推移 <span class="cs-year">1980 – 2020</span></h3>
             <div class="cs-trend-body"><span class="cs-sa-loading">読み込み中…</span></div>
           </div>`;
    }
    const histHtml = histCode ? _cityHistoryHtml(histCode) : '';

    // 2020年参考データ（年齢ピラミッド・就業・世帯）
    let ref2020Html = '';
    if (ref2020) {
        const refSecs = buildCensusChartSections(ref2020.stat, '2020', {
            ages: ref2020.ages?.length === 32 ? ref2020.ages : null,
            refAges: ref2020.natAges?.length === 32 ? ref2020.natAges : null,
        });
        const refById = {};
        for (const s of refSecs) refById[s.id] = s.svg;
        const hasRef = !!ref2020.natAges?.length;
        const pyrLabel = hasRef ? '2020年（全国平均付）' : '2020年';
        if (refById.pyramid)
            ref2020Html += `<div class="cs-section cs-svg-wrap"><h3 class="cs-drill-sec-h3">年齢別人口構成 <span class="cs-year">${pyrLabel}</span></h3>${refById.pyramid}${_pyramidLegend(hasRef)}</div>`;
        if (refById.stats)
            ref2020Html += `<div class="cs-section cs-svg-wrap"><h3 class="cs-drill-sec-h3">就業・世帯経済 <span class="cs-year">2020年</span></h3>${refById.stats}</div>`;
        if (refById.household)
            ref2020Html += `<div class="cs-section cs-svg-wrap"><h3 class="cs-drill-sec-h3">世帯・住宅 <span class="cs-year">2020年</span></h3>${refById.household}</div>`;
    }

    return statsHtml + trendHtml + histHtml + ref2020Html;
}
