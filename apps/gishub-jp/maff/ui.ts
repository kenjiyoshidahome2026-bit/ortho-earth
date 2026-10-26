import MAFF_MANIFEST from './manifest.json' with { type: 'json' };
import { PREFS, fmtBytes, escHtml } from '../ui/shared.ts';
import { ctx } from '../ui/ctx.ts';
import { renderMinistryList } from '../ui/ministry-list.ts';

// ---- data -------------------------------------------------------

type MaffRec = typeof MAFF_MANIFEST[number];
type MaffCity = ReturnType<typeof buildMaffCityList>[number];

const MAFF_BY_PREF = (() => {
    const m = new Map<string, MaffRec[]>();
    for (const e of MAFF_MANIFEST) {
        if (!m.has(e.prefCd)) m.set(e.prefCd, []);
        m.get(e.prefCd)!.push(e);
    }
    return m;
})();

// 筆ポリゴンの無い区＝bucket に maff_<code>.geopbf が無い（農地の無い都心区等・manifest は size 無し）。
// 押すと 404 で「読めない」になっていた＝一覧には「データ無し」で出し、押せない・一括にも入れない（2026-10-26 の全件点検で 404 の 22 区）
const MAFF_NO_DATA = new Set([
    '121061', '122271',                                                   // 千葉市美浜区・浦安市
    '131016', '131024', '131032', '131041', '131059', '131067', '131075', '131083', '131091', '131130', '131164', '131181',   // 東京 12 区
    '231061', '261041', '271063', '271080', '271276', '271284', '281026', '281107',   // 名古屋中・京都中京・大阪 西/大正/北/中央・神戸 灘/中央
]);
const hasData = (e: MaffRec) => !MAFF_NO_DATA.has(e.prefCityCd);

// サイドバー項目は ui/entries.ts（正本）へ移動。件数は scripts/gen-counts.mjs → ui/counts.json

// ---- list -------------------------------------------------------

function buildMaffCityList() {
    return MAFF_MANIFEST.map(e => ({
        code: e.prefCityCd,
        name: e.cityName,
        pref: e.prefCd,
        year: e.year,
        size: e.size || null,
        none: !hasData(e),
        _raw: e,
    }));
}

function maffCityItemHtml(city: MaffCity) {
    if (city.none) return `
        <div class="moj-city-item disabled" title="この区には筆ポリゴン（農地）がありません">
            <span class="moj-city-code">${escHtml(city.code)}</span>
            <span class="moj-city-name">${escHtml(city.name)}</span>
            <span class="moj-city-file">データ無し</span>
        </div>
    `;
    const sizeBadge = city.size
        ? `<span class="file-sz">${fmtBytes(city.size)} <span class="size-note">PBF</span></span>`
        : '';
    return `
        <div class="moj-city-item" data-code="${escHtml(city.code)}" title="クリックで読込・描画">
            <span class="moj-city-code">${escHtml(city.code)}</span>
            <span class="moj-city-name">${escHtml(city.name)}</span>
            <span class="moj-city-file">${escHtml(city.year)}年度${sizeBadge}</span>
            <span class="badge fmt-pbf">GeoPBF</span>
        </div>
    `;
}

function maffToEntry(e: MaffRec) {
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

let maffListSearch = '', maffExpandedPrefs = new Set<string>();

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
        bulkByGroup: pref => (MAFF_BY_PREF.get(pref) || []).filter(hasData).map(maffToEntry),
        allEntries:  () => MAFF_MANIFEST.filter(hasData).map(maffToEntry),
        groupHeaderHtml: (_key, _name, items) => {
            const total = items.reduce((s, c) => s + (c.size || 0), 0);
            return total ? `<span class="pref-size">${fmtBytes(total)} <span class="size-note">PBF</span></span>` : '';
        },
        onItemClick: city => {
            if (city.none) return;
            const entry = maffToEntry(city._raw);
            ctx.renderExecView(entry, () => { history.replaceState(null, '', '#maff'); renderMaffList(); });
        },
    });
}

