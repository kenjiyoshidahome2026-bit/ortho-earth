import ESTAT_MANIFEST from './manifest.json' with { type: 'json' };
import { PREFS, fmtBytes } from '../ui/shared.js';
import { ctx } from '../ui/ctx.js';
import { renderMinistryList } from '../ui/ministry-list.js';
import { geopbf } from '../ui/gpbf.js';
import { API_BASE } from '../ui/config.js';

export { ESTAT_MANIFEST };

// ---- constants -------------------------------------------------------

const ESTAT_DL_BASE = 'https://www.e-stat.go.jp/gis/statmap-search/data';
export const ESTAT_SURVEY = 'A002005212020';

export function estatDlUrl(code) {
    return `${ESTAT_DL_BASE}?dlserveyId=${ESTAT_SURVEY}&code=${code}&coordSys=1&format=shape&downloadType=5&datum=2011`;
}

// ---- data -------------------------------------------------------

const ESTAT_BY_PREF = (() => {
    const m = new Map();
    for (const e of ESTAT_MANIFEST) {
        if (!m.has(e.prefCode)) m.set(e.prefCode, []);
        m.get(e.prefCode).push(e);
    }
    return m;
})();

export function estatSidebarEntry() {
    return { dataset_code:'estat', title:'統計GIS 小地域境界', file_count:ESTAT_MANIFEST.length, license:'CC BY', _sourceId:'estat' };
}

// ---- list -------------------------------------------------------

function buildEstatCityList() {
    return ESTAT_MANIFEST.map(e => ({
        code: e.code,
        name: e.name,
        pref: e.prefCode,
        size: e.size || null,
        _raw: e,
    }));
}

function estatCityItemHtml(city) {
    const sizeBadge = city.size
        ? `<span class="file-sz">${fmtBytes(city.size)} <span class="size-note">ZIP</span></span>`
        : '';
    return `
        <div class="moj-city-item" data-code="${city.code}" title="クリックでコピー">
            <span class="moj-city-code">${city.code}</span>
            <span class="moj-city-name">${city.name}</span>
            <span class="moj-city-file">A002005212020_${city.code}.zip${sizeBadge}</span>
            <span class="badge fmt-shp">SHP</span>
        </div>
    `;
}

export function estatToEntry(e) {
    return {
        name:        `${e.code}_${ESTAT_SURVEY}`,
        description: `${PREFS[e.prefCode] || e.prefCode} ${e.name} 小地域（国勢調査2020）`,
        target:      estatDlUrl(e.code),
        attribution: '総務省統計局',
        license:     'CC BY',
    };
}

let estatListSearch = '', estatExpandedPrefs = new Set();

export function renderEstatList() {
    const cities = buildEstatCityList();
    renderMinistryList({
        id:          'estat',
        title:       '総務省 統計GIS 小地域',
        subtitle:    '国勢調査2020 小地域（町丁・字等）境界データ<span class="moj-fmt-note">SHP = zip/shp</span>',
        cities,
        expanded:    estatExpandedPrefs,
        getSearch:   () => estatListSearch,
        setSearch:   v  => { estatListSearch = v; },
        itemHtml:    estatCityItemHtml,
        groupFn:     c  => ({ key: c.pref, name: PREFS[c.pref] || c.pref }),
        toEntry:     c  => estatToEntry(c._raw),
        bulkByGroup: pref => (ESTAT_BY_PREF.get(pref) || []).map(e => estatToEntry(e)),
        allEntries:  () => ESTAT_MANIFEST.map(estatToEntry),
        downloadFn:  estatGeopbf,
        groupHeaderHtml: (_key, _name, items) => {
            const total = items.reduce((s, c) => s + (c.size || 0), 0);
            return total ? `<span class="pref-size">${fmtBytes(total)} <span class="size-note">ZIP</span></span>` : '';
        },
        onItemClick: city => {
            const entry = estatToEntry(city._raw);
            const estatFetch = async (target, _opts) => {
                const proxyUrl = `${API_BASE}/proxy/?url=${encodeURIComponent(target)}`;
                const resp = await fetch(proxyUrl);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const blob = await resp.blob();
                return geopbf(new File([blob], `${entry.name}.zip`), { name: entry.name });
            };
            ctx.renderExecView(entry, () => { history.replaceState(null, '', '#estat'); renderEstatList(); }, estatFetch);
        },
    });
}

export async function estatGeopbf(entry) {
    const proxyUrl = `${API_BASE}/proxy/?url=${encodeURIComponent(entry.target)}`;
    const resp = await fetch(proxyUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    return geopbf(new File([blob], `${entry.name}.zip`), { name: entry.name });
}
