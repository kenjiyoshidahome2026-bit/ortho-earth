import MAFF_MANIFEST from './manifest.json' with { type: 'json' };
import { PREFS, fmtBytes, escHtml } from '../ui/shared.js';
import { ctx } from '../ui/ctx.js';
import { renderMinistryList } from '../ui/ministry-list.js';

// ---- data -------------------------------------------------------

const MAFF_BY_PREF = (() => {
    const m = new Map();
    for (const e of MAFF_MANIFEST) {
        if (!m.has(e.prefCd)) m.set(e.prefCd, []);
        m.get(e.prefCd).push(e);
    }
    return m;
})();

// サイドバー項目は ui/entries.js（正本）へ移動。件数は scripts/gen-counts.mjs → ui/counts.json

// ---- list -------------------------------------------------------

function buildMaffCityList() {
    return MAFF_MANIFEST.map(e => ({
        code: e.prefCityCd,
        name: e.cityName,
        pref: e.prefCd,
        year: e.year,
        size: e.size || null,
        _raw: e,
    }));
}

function maffCityItemHtml(city) {
    const sizeBadge = city.size
        ? `<span class="file-sz">${fmtBytes(city.size)} <span class="size-note">PBF</span></span>`
        : '';
    return `
        <div class="moj-city-item" data-code="${escHtml(city.code)}" title="クリックで読込・描画">
            <span class="moj-city-code">${escHtml(city.code)}</span>
            <span class="moj-city-name">${escHtml(city.name)}</span>
            <span class="moj-city-file">${escHtml(city.year)}年度${sizeBadge}</span>
            <span class="badge fmt-geojson">GeoJSON</span>
        </div>
    `;
}

function maffToEntry(e) {
    return {
        name:        `${e.prefCityCd}_${e.year}`,
        description: `${e.prefName} ${e.cityName} 筆ポリゴン ${e.year}年度`,
        target:      `maff_${e.prefCityCd}.geopbf`,
        attribution: '農林水産省',
        license:     'CC BY 4.0',
        format:      'maff',
        _maff:       { prefCd:e.prefCd, prefName:e.prefName, cityCd:e.cityCd, cityName:e.cityName, year:e.year, prefCityCd:e.prefCityCd },
    };
}

let maffListSearch = '', maffExpandedPrefs = new Set();

export function renderMaffList() {
    const cities = buildMaffCityList();
    renderMinistryList({
        id:          'maff',
        title:       '農林水産省 筆ポリゴン',
        subtitle:    '筆ポリゴンオープンデータ（農林水産省）<span class="moj-fmt-note">GeoJSON = API→zip→json</span>',
        cities,
        expanded:    maffExpandedPrefs,
        getSearch:   () => maffListSearch,
        setSearch:   v  => { maffListSearch = v; },
        itemHtml:    maffCityItemHtml,
        groupFn:     c  => ({ key: c.pref, name: PREFS[c.pref] || c.pref }),
        toEntry:     c  => maffToEntry(c._raw),
        bulkByGroup: pref => (MAFF_BY_PREF.get(pref) || []).map(maffToEntry),
        allEntries:  () => MAFF_MANIFEST.map(maffToEntry),
        groupHeaderHtml: (_key, _name, items) => {
            const total = items.reduce((s, c) => s + (c.size || 0), 0);
            return total ? `<span class="pref-size">${fmtBytes(total)} <span class="size-note">PBF</span></span>` : '';
        },
        onItemClick: city => {
            const entry = maffToEntry(city._raw);
            ctx.renderExecView(entry, () => { history.replaceState(null, '', '#maff'); renderMaffList(); });
        },
    });
}

