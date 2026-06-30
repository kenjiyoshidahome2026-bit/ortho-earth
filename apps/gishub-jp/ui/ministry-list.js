import { PREFS, escHtml, fmtBytes } from './shared.js';
import { renderGroupedCities } from './grouped-list.js';
import { ctx } from './ctx.js';

export function renderMinistryList({
    id, title, subtitle, cities, expanded,
    getSearch, setSearch, itemHtml, groupFn,
    toEntry, bulkByGroup, allEntries, downloadFn = null,
    groupHeaderHtml = null, onItemClick = null,
}) {
    const totalSize = cities.reduce((s, c) => s + (c.size || 0), 0);
    const totalSizeLabel = totalSize
        ? `<span class="moj-total-size">${fmtBytes(totalSize)}</span>`
        : '';
    ctx.setDetailHtml(`
        <div class="moj-list-wrap">
            <div class="moj-list-head">
                <div class="moj-head-row">
                    <div>
                        <h2>${title}</h2>
                        <p class="moj-subtitle">${subtitle}<span class="moj-total">${cities.length.toLocaleString()}市区町村</span>${totalSizeLabel}</p>
                    </div>
                    <button class="bulk-dl-btn" id="${id}-bulk-all">一括↓IDB</button>
                </div>
                <input type="text" id="${id}-search" class="moj-search" placeholder="市区町村・都道府県を検索...">
            </div>
            <div class="grouped-list" id="${id}-cities"></div>
        </div>
    `);

    document.getElementById(`${id}-bulk-all`).addEventListener('click', function() {
        if (downloadFn) ctx.bulkDownload(allEntries(), title, downloadFn);
        else ctx.copyEntries(allEntries(), this);
    });

    const render = () => renderGroupedCities(cities, `${id}-cities`, expanded, itemHtml, {
        query:       getSearch(),
        groupFn,
        groupHeaderHtml,
        onBulkClick: (group, btn) => {
            if (downloadFn) ctx.bulkDownload(bulkByGroup(group), `${title} ${PREFS[group] || group}`, downloadFn);
            else ctx.copyEntries(bulkByGroup(group), btn);
        },
        onItemClick: e => {
            const row = e.target.closest('.moj-city-item');
            if (!row) return;
            const city = cities.find(c => c.code === row.dataset.code);
            if (!city) return;
            if (onItemClick) onItemClick(city);
            else ctx.copyEntries([toEntry(city)], null);
        },
    });

    document.getElementById(`${id}-search`).addEventListener('input', function() {
        setSearch(this.value); render();
    });

    render();
}
