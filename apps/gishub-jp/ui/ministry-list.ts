import { PREFS, escHtml, fmtBytes } from './shared.ts';
import { renderGroupedCities } from './grouped-list.ts';
import { ctx } from './ctx.ts';
import type { GroupItem, GroupedOpts } from './grouped-list.ts';
import type { BulkEntry } from './bulk-download.ts';
import type { Ctx } from './ctx.ts';

export interface MinistryListOpts<T extends GroupItem> {
    id: string; title: string; subtitle: string; cities: T[]; expanded: Set<string>;
    getSearch: () => string; setSearch: (v: string) => void; itemHtml: (c: T) => string; groupFn?: GroupedOpts<T>['groupFn'];
    toEntry: (c: T) => BulkEntry; bulkByGroup: (group: string) => BulkEntry[]; allEntries: () => BulkEntry[]; downloadFn?: Parameters<Ctx['bulkDownload']>[2];
    groupHeaderHtml?: GroupedOpts<T>['groupHeaderHtml']; onItemClick?: ((city: T) => void) | null; noBulk?: boolean;
}

export function renderMinistryList<T extends GroupItem>({
    id, title, subtitle, cities, expanded,
    getSearch, setSearch, itemHtml, groupFn,
    toEntry, bulkByGroup, allEntries, downloadFn = null,
    groupHeaderHtml = null, onItemClick = null, noBulk = false,   // noBulk＝一括ボタンを出さない（市区町村のオープンデータ等＝束の中身が種類ばらばら）
}: MinistryListOpts<T>) {
    const bulkLabel = noBulk ? null : downloadFn ? '一括↓IDB' : '一括コピー';   // 表記は実挙動（downloadFn無しはクリップボードコピー）に一致させる
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
                    ${bulkLabel ? `<button class="bulk-dl-btn" id="${id}-bulk-all">${bulkLabel}</button>` : ''}
                </div>
                <input type="text" id="${id}-search" class="moj-search" placeholder="市区町村・都道府県を検索...">
            </div>
            <div class="grouped-list" id="${id}-cities"></div>
        </div>
    `);

    document.getElementById(`${id}-bulk-all`)?.addEventListener('click', function() {
        if (downloadFn) ctx.bulkDownload(allEntries(), title, downloadFn);
        else ctx.copyEntries(allEntries(), this);
    });

    const render = () => renderGroupedCities(cities, `${id}-cities`, expanded, itemHtml, {
        query:       getSearch(),
        groupFn,
        groupHeaderHtml,
        bulkLabel,
        onBulkClick: (group, btn) => {
            if (downloadFn) ctx.bulkDownload(bulkByGroup(group), `${title} ${PREFS[group] || group}`, downloadFn);
            else ctx.copyEntries(bulkByGroup(group), btn);
        },
        onItemClick: e => {
            const row = (e.target as Element).closest<HTMLElement>('.moj-city-item');
            if (!row) return;
            const city = cities.find(c => c.code === row.dataset.code);
            if (!city) return;
            if (onItemClick) onItemClick(city);
            else ctx.copyEntries([toEntry(city)], null);
        },
    });

    (document.getElementById(`${id}-search`) as HTMLInputElement).addEventListener('input', function() {
        setSearch(this.value); render();
    });

    render();
}
