import { PREFS, escHtml } from './shared.js';

export function renderGroupedCities(cities, containerId, expandedSet, itemHtml, {
    query           = '',
    groupFn         = c => ({ key: c.pref, name: PREFS[c.pref] || c.pref }),
    onBulkClick     = null,
    onItemClick     = null,
    groupHeaderHtml = null,
    bulkLabel       = '一括↓IDB',
} = {}) {
    const q = query.toLowerCase();
    const container = document.getElementById(containerId);
    if (!container) return;

    const groups = new Map();
    for (const c of cities) {
        const { key, name } = groupFn(c);
        if (!groups.has(key)) groups.set(key, { name, items: [] });
        groups.get(key).items.push(c);
    }

    const isSearching = q.length > 0;
    const html = [];

    for (const [key, { name: groupName, items: members }] of groups) {
        const groupMatch = isSearching && groupName.toLowerCase().includes(q);
        const matched = isSearching
            ? members.filter(c => groupMatch || c.name?.toLowerCase().includes(q) || c.code?.includes(q) || c.prefName?.toLowerCase().includes(q))
            : members;

        if (isSearching && matched.length === 0) continue;

        const isExpanded = isSearching || expandedSet.has(key);

        const extraHtml = groupHeaderHtml ? groupHeaderHtml(key, groupName, matched) : '';
        html.push(`
            <div class="detail-section pref-group" data-group="${escHtml(key)}">
                <div class="pref-header${isExpanded ? '' : ' collapsed'}" data-group="${escHtml(key)}">
                    <span class="pref-arrow">▾</span>
                    <span class="pref-name">${escHtml(groupName)}</span>
                    ${extraHtml}
                    <span class="cnt">${matched.length}</span>
                    <button class="pref-bulk-btn" data-group="${escHtml(key)}">${escHtml(bulkLabel)}</button>
                </div>
                <div class="pref-cities${isExpanded ? '' : ' hidden'}">
                    ${matched.map(c => itemHtml(c)).join('')}
                </div>
            </div>
        `);
    }

    if (!html.length) {
        container.innerHTML = '<div class="empty-msg" style="padding:24px">該当なし</div>';
        return;
    }

    container.innerHTML = html.join('');

    container.onclick = e => {
        const bulkBtn = e.target.closest('.pref-bulk-btn');
        if (bulkBtn) {
            onBulkClick?.(bulkBtn.dataset.group, bulkBtn);
            return;
        }
        const header = e.target.closest('.pref-header');
        if (header) {
            const key = header.dataset.group;
            const citiesDiv = header.nextElementSibling;
            const expanding = header.classList.contains('collapsed');
            header.classList.toggle('collapsed', !expanding);
            citiesDiv.classList.toggle('hidden', !expanding);
            expanding ? expandedSet.add(key) : expandedSet.delete(key);
            return;
        }
        onItemClick?.(e);
    };
}
