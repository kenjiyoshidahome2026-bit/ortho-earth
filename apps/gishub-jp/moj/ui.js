import MOJ_MANIFEST         from './manifest.json'      with { type: 'json' };
import MOJ_GEOJSON_MANIFEST from './geojson.json'       with { type: 'json' };
import MOJ_PBF_MANIFEST     from './pbf-manifest.json'  with { type: 'json' };
import { PREFS, escHtml, fmtBytes, cityArea } from '../ui/shared.js';
import { ctx } from '../ui/ctx.js';
import { renderGroupedCities } from '../ui/grouped-list.js';

// ---- data maps -------------------------------------------------------

function _buildCities() {
    const m = new Map();
    for (const e of MOJ_MANIFEST) {
        if (!m.has(e.cityCode)) m.set(e.cityCode, []);
        m.get(e.cityCode).push(e);
    }
    return m;
}
function _buildGeojsonMap() {
    const m = new Map();
    for (const e of MOJ_GEOJSON_MANIFEST) m.set(e.name.slice(0, 5), e);
    return m;
}

export const MOJ_CITIES      = _buildCities();
export const MOJ_GEOJSON_MAP = _buildGeojsonMap();
export const MOJ_PBF_MAP     = new Map(MOJ_PBF_MANIFEST.map(e => [e.cityCode, e]));

// ---- size cache -------------------------------------------------------

const MOJ_SIZE_KEY = 'moj-pbf-sizes';
function mojSavedSizes() {
    try { return JSON.parse(localStorage.getItem(MOJ_SIZE_KEY) || '{}'); } catch { return {}; }
}
export function mojSavePbfSize(name, bytes) {
    try {
        const saved = mojSavedSizes();
        saved[name] = bytes;
        localStorage.setItem(MOJ_SIZE_KEY, JSON.stringify(saved));
    } catch {}
}

// ---- sidebar entry -------------------------------------------------------

export function mojSidebarEntry() {
    return { dataset_code:'moj', title:'登記所備付地図（14条地図）', file_count:MOJ_CITIES.size, license:'CC BY 4.0', _sourceId:'moj' };
}

// ---- city list -------------------------------------------------------

function buildMojCityList() {
    const saved = mojSavedSizes();
    return [...MOJ_CITIES.entries()].map(([code, entries]) => {
        const e = entries[0];
        const name = e.title.replace(/（[^）]*）.*$/, '').replace(/\s*登記所備付地図.*$/, '').trim();
        const pref = code.slice(0, 2);
        const validSize = entries.reduce((s, x) => s + (x.size > 1000 ? x.size : 0), 0);
        const geojson = MOJ_GEOJSON_MAP.get(code);
        const pbf     = MOJ_PBF_MAP.get(code);
        const fastEntry = geojson || pbf;
        const savedPbf = fastEntry
            ? (saved[fastEntry.name] || 0)
            : entries.map(x => saved[x.filename.replace(/\.zip$/i, '')] || 0).reduce((s, v) => s + v, 0);
        return {
            code, name, pref, prefName: PREFS[pref] || pref, area: cityArea(code),
            filename: e.filename, extra: entries.length - 1,
            size:       validSize || null,
            pbfSize:    savedPbf  || null,
            hasGeojson: !!geojson,
            hasPbf:     !geojson && !!pbf,
        };
    });
}

function mojCityItemHtml(city) {
    const extra = !city.hasGeojson && city.extra > 0 ? `<span class="extra-cnt">+${city.extra}</span>` : '';
    const badge = city.hasGeojson
        ? `<span class="badge fmt-geojson">GeoJSON</span>`
        : city.hasPbf
        ? `<span class="badge fmt-pbf">PBF</span>`
        : `<span class="badge fmt-moj">MOJ</span>`;
    const fname = city.hasGeojson
        ? escHtml(MOJ_GEOJSON_MAP.get(city.code)?.name || city.filename)
        : city.hasPbf
        ? escHtml(MOJ_PBF_MAP.get(city.code)?.name || city.filename)
        : escHtml(city.filename);
    const sizeBadge = city.pbfSize
        ? `<span class="file-sz">${fmtBytes(city.pbfSize)} <span class="size-note">PBF</span></span>`
        : city.size && !city.hasGeojson
        ? `<span class="file-sz">${fmtBytes(city.size)} <span class="size-note">ZIP</span></span>`
        : '';
    return `
        <div class="moj-city-item" data-code="${city.code}" title="クリックで読込・描画">
            <span class="moj-city-code">${city.code}</span>
            <span class="moj-city-name">${escHtml(city.name)}<span class="area-tag">平面直角座標系:${city.area}</span></span>
            <span class="moj-city-file">${fname}${extra}${sizeBadge}</span>
            ${badge}
        </div>
    `;
}

// ---- list render -------------------------------------------------------

let mojListSearch = '';
let mojExpandedPrefs = new Set();

export function renderMojList() {
    const cities = buildMojCityList();
    const totalPbfBytes = cities.reduce((s, c) => s + (c.pbfSize || 0), 0);
    const totalZipBytes = cities.reduce((s, c) => s + (c.size   || 0), 0);
    const totalSizeLabel = totalPbfBytes
        ? `<span class="moj-total-size">${fmtBytes(totalPbfBytes)} <span class="size-note">PBF</span></span>`
        : totalZipBytes
        ? `<span class="moj-total-size">${fmtBytes(totalZipBytes)} <span class="size-note">ZIP</span></span>`
        : '';
    ctx.setDetailHtml(`
        <div class="moj-list-wrap">
            <div class="moj-list-head">
                <div class="moj-head-row">
                    <div>
                        <h2>法務省 登記所備付地図</h2>
                        <p class="moj-subtitle">登記所備付地図データ（14条地図）<span class="moj-total">${cities.length.toLocaleString()}市区町村</span>${totalSizeLabel}<span class="moj-fmt-note"><span class="badge fmt-geojson">GeoJSON</span>${MOJ_GEOJSON_MAP.size.toLocaleString()}市区町村 / <span class="badge fmt-moj">MOJ</span>残り</span></p>
                    </div>
                    <button class="bulk-dl-btn" id="moj-bulk-all">全国一括読込(→IDB)</button>
                </div>
                <input type="text" id="moj-search" class="moj-search" placeholder="市区町村・都道府県を検索..." value="${escHtml(mojListSearch)}">
            </div>
            <div class="grouped-list" id="moj-cities"></div>
        </div>
    `);
    const mojRender = () => renderGroupedCities(cities, 'moj-cities', mojExpandedPrefs, mojCityItemHtml, {
        query:       mojListSearch,
        groupFn:     c => ({ key: c.pref, name: PREFS[c.pref] || c.pref }),
        onBulkClick: (pref, _btn) => ctx.bulkDownload(mojPrefEntries(pref), `法務省 ${PREFS[pref] || pref}`),
        onItemClick: e => {
            const item = e.target.closest('.moj-city-item');
            if (!item) return;
            const entries = mojCityEntries(item.dataset.code);
            if (!entries.length) return;
            ctx.renderExecView(entries[0], () => { history.replaceState(null, '', '#moj'); renderMojList(); });
        },
        groupHeaderHtml: (_key, _name, items) => {
            const areas = [...new Set(items.map(c => c.area))].sort((a, b) => a - b);
            const totalPbf = items.reduce((s, c) => s + (c.pbfSize || 0), 0);
            const totalZip = items.reduce((s, c) => s + (c.size   || 0), 0);
            const sizeHtml = totalPbf
                ? `<span class="pref-size">${fmtBytes(totalPbf)} <span class="size-note">PBF</span></span>`
                : totalZip
                ? `<span class="pref-size">${fmtBytes(totalZip)} <span class="size-note">ZIP</span></span>`
                : '';
            return `<span class="pref-coord-sys">直角座標系:${areas.join(',')}</span>` + sizeHtml;
        },
    });
    document.getElementById('moj-bulk-all').addEventListener('click', () => {
        ctx.bulkDownload(mojAllEntries(), '法務省 登記所備付地図 全国');
    });
    document.getElementById('moj-search').addEventListener('input', function() {
        mojListSearch = this.value;
        mojRender();
    });
    mojRender();
}

// ---- entry helpers -------------------------------------------------------

export function mojCityEntries(cityCode) {
    const geojson = MOJ_GEOJSON_MAP.get(cityCode);
    if (geojson) return [{ ...geojson, precision: 7 }];
    const pbf = MOJ_PBF_MAP.get(cityCode);
    if (pbf) return [{ ...pbf }];
    return (MOJ_CITIES.get(cityCode) || []).map(e => ({
        name:        e.filename.replace(/\.zip$/i, ''),
        description: e.title.replace(/\s*登記所備付地図.*$/, '').trim(),
        target:      e.url,
        link:        `https://www.geospatial.jp/ckan/dataset/${e.packageName}`,
        attribution: '法務省',
        license:     'CC BY 4.0',
        format:      'moj',
        size:        e.size || null,
    }));
}

export function mojPrefEntries(prefCode) {
    const result = [];
    for (const code of MOJ_CITIES.keys()) {
        if (code.slice(0, 2) === prefCode) result.push(...mojCityEntries(code));
    }
    return result;
}

export function mojAllEntries() {
    const result = [];
    for (const code of MOJ_CITIES.keys()) result.push(...mojCityEntries(code));
    return result;
}
