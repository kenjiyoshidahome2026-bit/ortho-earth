import { PREFS, escHtml } from '../ui/shared.js';
import { ctx } from '../ui/ctx.js';
import { fetchDataset, NLFTP_SOURCE } from './catalog.js';
import { meshBulkDownload } from './mesh.js';
import { API_BASE } from '../ui/config.js';

// ---- 内部状態（このモジュールが所有） -------------------------------------------------------
let _currentDs = null;
let _currentFilteredFiles = [];

// ---- 公開 API -------------------------------------------------------

export function renderDetail(ds, showBack = false) {
    _currentDs = ds;

    const backHtml = showBack ? `<button class="back-btn" id="back-to-moj">← 一覧に戻る</button>` : '';

    // 旧形式(array)と新形式(object)の両方に対応
    const attrs = ds.attributes || {};
    const attrEntries = Array.isArray(attrs)
        ? attrs.map(a => [a.code, a.label])
        : Object.entries(attrs);
    const getCodelist = Array.isArray(attrs)
        ? (code, i) => { const a = attrs[i]; return Array.isArray(a?.codelist) ? a.codelist : null; }
        : (code) => ds.codelist?.[code] ?? null;

    const attrHtml = attrEntries.length ? `
        <section class="detail-section">
            <h3 class="section-title">
                属性 <span class="cnt">${attrEntries.length}</span>
                <span class="toggle-icon">▾</span>
            </h3>
            <div class="section-body">
                <table class="attr-table">
                    <thead><tr><th>コード</th><th>ラベル</th><th>コードリスト</th></tr></thead>
                    <tbody>
                        ${attrEntries.map(([code, label], i) => {
                            const cl = getCodelist(code, i);
                            const clCell = cl === 'admin-boundary'
                                ? `<button class="codelist-btn admin-boundary-btn">行政区域コード</button>`
                                : cl && typeof cl === 'object'
                                ? `<button class="codelist-btn" data-cl-code="${escHtml(code)}" data-cl-idx="${i}">参照</button>`
                                : '—';
                            return `<tr><td class="mono">${code}</td><td>${label}</td><td>${clCell}</td></tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </section>
    ` : '';

    ctx.setDetailHtml(`
        <div class="detail-inner">
            ${backHtml}
            <header class="detail-header">
                <h2>${ds.title}</h2>
                <div class="detail-meta">
                    <span class="badge lic-${_licKey(ds.license)}">${ds.license}</span>
                    <span class="mono" style="color:#888">${ds.dataset_code}</span>
                    <a href="${ds.page_url}" target="_blank" rel="noopener" class="ext-link">データページ →</a>
                </div>
            </header>
            ${attrHtml}
            ${_renderFiles(ds)}
        </div>
    `);

    document.getElementById('back-to-moj')?.addEventListener('click', () => {
        history.replaceState(null, '', '#moj');
        ctx.renderMojList();
    });
}

export async function nlftpSelectDataset(code) {
    history.replaceState(null, '', `#${code}`);
    ctx.setDetailHtml('<div class="loading-msg" style="padding:40px">読み込み中...</div>');
    try {
        const data = await fetchDataset(code);
        renderDetail(data);
    } catch (e) {
        ctx.setDetailHtml(`<div class="error-msg">エラー: ${e.message}</div>`);
    }
}

export function applyFileFilters() {
    if (!_currentDs?.files?.length) return;
    const year = document.getElementById('ff-year')?.value || 'all';
    const fmt  = document.getElementById('ff-fmt')?.value  || 'all';
    const pref = document.getElementById('ff-pref')?.value || 'all';

    const raw = _currentDs.files.some(f => f.format === 'geojson')
        ? _currentDs.files.filter(f => f.format !== 'shp')
        : _currentDs.files;

    const filtered = _sortFiles(raw.filter(f => {
        if (year !== 'all' && String(f.year) !== year) return false;
        if (fmt  !== 'all' && f.format !== fmt)        return false;
        if (pref !== 'all' && String(f.pref_code) !== pref) return false;
        return true;
    }));

    _currentFilteredFiles = filtered;
    document.getElementById('files-cnt').textContent = filtered.length;
    document.getElementById('files-list').innerHTML  = _buildFileRows(filtered, _currentDs);
}

export function initDetailEventListeners() {
    document.getElementById('detail').addEventListener('change', e => {
        if (e.target.classList.contains('file-filter')) applyFileFilters();
    });

    document.getElementById('detail').addEventListener('click', async e => {
        if (e.target.classList.contains('load-more-btn')) { _handleLoadMore(e.target); return; }

        const title = e.target.closest('.section-title');
        if (title) { title.parentElement.classList.toggle('collapsed'); return; }

        if (e.target.classList.contains('codelist-btn')) {
            if (e.target.classList.contains('admin-boundary-btn')) {
                _showAdminBoundaryPopup(e.target);
                return;
            }
            const attrs = _currentDs.attributes || {};
            let cl;
            if (Array.isArray(attrs)) {
                cl = attrs[parseInt(e.target.dataset.clIdx)]?.codelist || [];
                const entries = Array.isArray(cl) ? cl : Object.entries(cl).map(([c,l])=>({code:c,label:l}));
                _showCodelistPopup(entries, e.target);
            } else {
                cl = _currentDs.codelist?.[e.target.dataset.clCode] || {};
                _showCodelistPopup(Object.entries(cl).map(([c,l])=>({code:c,label:l})), e.target);
            }
            return;
        }

        if (e.target.id === 'files-dl-all') {
            const files   = _currentFilteredFiles.length ? _currentFilteredFiles : (_currentDs?.files || []);
            const entries = files.map(f => _fileEntry(f, _currentDs));
            const label   = _currentDs?.title || '国土数値情報';
            if (_isMesh(_currentDs)) {
                meshBulkDownload(entries, label);
            } else {
                ctx.bulkDownload(entries, label);
            }
            return;
        }

        const row = e.target.closest('.file-row');
        if (row?.dataset.entry) {
            const entry = JSON.parse(row.dataset.entry);
            ctx.renderExecView(entry, () => renderDetail(_currentDs));
            return;
        }
    });
}

// ---- 内部関数 -------------------------------------------------------

function _isMesh(ds) {
    return ds?.files?.some(f => f.scope?.includes('メッシュ'));
}

function _licKey(lic) {
    if (!lic) return 'ng';
    if (lic.includes('商用可') || lic.includes('CC BY') || lic.includes('CC_BY')) return 'ok';
    return 'ng';
}

function _renderFiles(ds) {
    if (!ds.files?.length) return '<p class="no-files">GISファイルなし</p>';

    const raw      = ds.files.some(f => f.format === 'geojson')
        ? ds.files.filter(f => f.format !== 'shp')
        : ds.files;
    const allFiles  = _sortFiles(raw);
    const years     = [...new Set(allFiles.map(f => f.year).filter(Boolean))].sort().reverse();
    const formats   = [...new Set(allFiles.map(f => f.format))].sort();
    const prefCodes = [...new Set(allFiles.filter(f => f.pref_code).map(f => f.pref_code))].sort();

    const yearOpts = ['all', ...years].map(y =>
        `<option value="${y}">${y === 'all' ? '年度: すべて' : y}</option>`).join('');
    const fmtOpts  = ['all', ...formats].map(f =>
        `<option value="${f}">${f === 'all' ? '形式: すべて' : f.toUpperCase()}</option>`).join('');
    const prefOpts = prefCodes.length ? `
        <select class="file-filter" id="ff-pref">
            <option value="all">都道府県: すべて</option>
            ${prefCodes.map(c => `<option value="${c}">${PREFS[String(c).padStart(2,'0')] || c}</option>`).join('')}
        </select>` : '';

    return `
        <section class="detail-section" id="files-section">
            <h3 class="section-title">
                ファイル <span class="cnt" id="files-cnt">${allFiles.length}</span>
                <span class="toggle-icon">▾</span>
            </h3>
            <div class="section-body">
                <div class="file-filters">
                    ${years.length > 1   ? `<select class="file-filter" id="ff-year">${yearOpts}</select>` : ''}
                    ${formats.length > 1 ? `<select class="file-filter" id="ff-fmt">${fmtOpts}</select>`  : ''}
                    ${prefOpts}
                    ${allFiles.length > 1 ? `<button class="bulk-dl-btn" id="files-dl-all">一括↓IDB</button>` : ''}
                </div>
                <div class="file-list">
                    <div class="file-list-header">
                        <span>年度</span><span>エリア</span><span>ファイル</span><span>形式</span>
                    </div>
                    <div id="files-list">${_buildFileRows(allFiles, ds)}</div>
                </div>
            </div>
        </section>
    `;
}

function _buildFileRows(files, ds, limit = 200) {
    const shown = files.slice(0, limit);
    const rest  = files.length - shown.length;
    return shown.map(f => _fileRow(f, ds)).join('') +
        (rest ? `<div class="more-row"><span>…残り ${rest} 件</span> <button class="load-more-btn">すべて表示</button></div>` : '');
}

function _scopeLabel(f) {
    const scope = f.scope || '全国';
    if (scope === '全国') return f.location_code || '全国';
    if (scope === '都道府県') {
        const code = String(f.pref_code || '').padStart(2, '0');
        return PREFS[code] || f.pref_code || '都道府県';
    }
    if (scope.includes('メッシュ')) return f.location_code || scope;
    return f.location_code || f.pref_code || scope;
}

function _sortFiles(files) {
    return [...files].sort((a, b) => {
        const order = s => s === '全国' ? 0 : s === '都道府県' ? 1 : s.includes('メッシュ') ? 2 : 3;
        const so = order(a.scope || '全国') - order(b.scope || '全国');
        if (so !== 0) return so;
        const ka = a.pref_code || a.location_code || '';
        const kb = b.pref_code || b.location_code || '';
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

function _fileEntry(f, ds) {
    const zipUrl   = f.target.split('#')[0];
    const zipName  = zipUrl.split('/').pop();
    const fileName = f.target.split('#')[1] || '';
    const name     = fileName.replace(/\.[^.]+$/, '') || zipName.replace(/\.[^.]+$/, '');
    const area     = _scopeLabel(f);
    const desc     = `${ds.title}${area !== '全国' ? ' (' + area + ')' : ''}${f.year ? ':' + f.year : ''}`;
    return {
        name,
        description: desc,
        target:      f.target,
        link:        ds.page_url,
        attribution: (ds._source || {}).attribution || '',
        license:     ds.license,
        ...(f.format === 'moj' ? { format: 'moj' } : {}),
    };
}

function _fileRow(f, ds) {
    const entry    = _fileEntry(f, ds);
    const zipUrl   = f.target.split('#')[0];
    const zipName  = zipUrl.split('/').pop();
    const fileName = f.target.split('#')[1] || '';
    const area     = _scopeLabel(f);
    return `
        <div class="file-row" data-entry="${escHtml(JSON.stringify(entry))}">
            <span class="file-year">${f.year || '—'}</span>
            <span class="file-area">${area}</span>
            <span class="file-name">${zipName}${fileName ? `<br><span class="file-sub">${fileName}</span>` : ''}</span>
            <span class="file-fmt"><span class="badge fmt-${f.format}">${f.format.toUpperCase()}</span></span>
        </div>
    `;
}

function _showCodelistPopup(entries, btn) {
    document.querySelectorAll('.codelist-popup').forEach(el => el.remove());
    const popup = document.createElement('div');
    popup.className = 'codelist-popup';
    popup.innerHTML = entries.length ? `
        <div class="cl-header">
            <span>${entries.length}件</span>
            <button class="cl-close" onclick="this.closest('.codelist-popup').remove()">✕</button>
        </div>
        <div class="cl-body">
            <table>
                <thead><tr><th>コード</th><th>名称</th></tr></thead>
                <tbody>${entries.map(r => `<tr><td class="mono">${escHtml(r.code)}</td><td>${escHtml(r.label)}</td></tr>`).join('')}</tbody>
            </table>
        </div>` : '<div class="cl-loading">データなし</div>';

    document.body.appendChild(popup);
    const rect = btn.getBoundingClientRect();
    const pw = 320;
    let left = rect.right - pw; if (left < 4) left = 4;
    let top  = rect.bottom + 4; if (top + 340 > window.innerHeight) top = rect.top - 340;
    popup.style.left = `${left}px`;
    popup.style.top  = `${top}px`;

    const close = e => { if (!popup.contains(e.target) && e.target !== btn) { popup.remove(); document.removeEventListener('click', close, true); } };
    setTimeout(() => document.addEventListener('click', close, true), 0);
}

// --- 行政区域コードポップアップ ---
let _adminBoundaryRows = null; // キャッシュ

async function _showAdminBoundaryPopup(btn) {
    document.querySelectorAll('.codelist-popup').forEach(el => el.remove());

    if (!_adminBoundaryRows) {
        btn.disabled = true;
        btn.textContent = '読み込み中...';
        try {
            const res = await fetch(`${API_BASE}/bucket/${NLFTP_SOURCE.bucket}/admin-boundary.csv`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf  = await res.arrayBuffer();
            const head = new Uint8Array(buf, 0, 2);
            let text;
            if (head[0] === 0x1f && head[1] === 0x8b) {
                const stream = new DecompressionStream('gzip');
                text = await new Response(new Blob([buf]).stream().pipeThrough(stream)).text();
            } else {
                text = new TextDecoder().decode(buf);
            }
            const lines = text.trim().split(/\r?\n/).slice(1); // skip header
            _adminBoundaryRows = lines.map(line => {
                const cols = line.split(',');
                return { code: cols[0], pref: cols[1], city: cols[2], status: cols[5] };
            }).filter(r => r.code);
        } catch (e) {
            btn.disabled = false;
            btn.textContent = '行政区域コード';
            alert('読み込みエラー: ' + e.message);
            return;
        }
        btn.disabled = false;
        btn.textContent = '行政区域コード';
    }

    const prefs = [...new Set(_adminBoundaryRows.map(r => r.pref).filter(Boolean))];

    const popup = document.createElement('div');
    popup.className = 'codelist-popup ab-popup';
    popup.innerHTML = `
        <div class="cl-header">
            <span class="ab-title">行政区域コード</span>
            <button class="cl-close" onclick="this.closest('.codelist-popup').remove()">✕</button>
        </div>
        <div class="ab-filters">
            <select class="ab-pref-sel">
                <option value="">都道府県: すべて</option>
                ${prefs.map(p => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join('')}
            </select>
            <label class="ab-obsolete-label">
                <input type="checkbox" class="ab-obsolete-chk"> 欠番含む
            </label>
            <input type="text" class="ab-search" placeholder="コード・名称で検索">
        </div>
        <div class="cl-body">
            <table>
                <thead><tr><th>コード</th><th>都道府県</th><th>市区町村</th></tr></thead>
                <tbody class="ab-tbody"></tbody>
            </table>
        </div>`;

    document.body.appendChild(popup);

    // 位置
    const rect = btn.getBoundingClientRect();
    const pw = 420;
    let left = rect.right - pw; if (left < 4) left = 4;
    let top  = rect.bottom + 4; if (top + 480 > window.innerHeight) top = rect.top - 480;
    popup.style.left = `${left}px`;
    popup.style.top  = `${top}px`;

    const tbody = popup.querySelector('.ab-tbody');
    const prefSel = popup.querySelector('.ab-pref-sel');
    const obsoleteChk = popup.querySelector('.ab-obsolete-chk');
    const searchInput = popup.querySelector('.ab-search');

    function render() {
        const pref    = prefSel.value;
        const showObs = obsoleteChk.checked;
        const q       = searchInput.value.trim().toLowerCase();
        const rows    = _adminBoundaryRows.filter(r => {
            if (!showObs && r.status === '欠番') return false;
            if (pref && r.pref !== pref) return false;
            if (q && !r.code.includes(q) && !r.pref.toLowerCase().includes(q) && !r.city.toLowerCase().includes(q)) return false;
            return true;
        });
        tbody.innerHTML = rows.map(r => {
            const cls = r.status === '欠番' ? ' class="ab-obsolete"' : '';
            return `<tr${cls}><td class="mono">${r.code}</td><td>${escHtml(r.pref)}</td><td>${escHtml(r.city)}</td></tr>`;
        }).join('');
    }

    prefSel.addEventListener('change', render);
    obsoleteChk.addEventListener('change', render);
    searchInput.addEventListener('input', render);
    render();

    const close = e => { if (!popup.contains(e.target) && e.target !== btn) { popup.remove(); document.removeEventListener('click', close, true); } };
    setTimeout(() => document.addEventListener('click', close, true), 0);
}

async function _handleLoadMore(btn) {
    const row = btn.closest('.more-row');
    btn.disabled = true; btn.textContent = '読み込み中...';
    try {
        const files = _currentDs.files.some(f => f.format === 'geojson')
            ? _currentDs.files.filter(f => f.format !== 'shp')
            : _currentDs.files;
        row.insertAdjacentHTML('beforebegin', _sortFiles(files).slice(200).map(f => _fileRow(f, _currentDs)).join(''));
        row.remove();
    } catch { btn.textContent = 'エラー'; }
}
