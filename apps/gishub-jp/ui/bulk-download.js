import { fmtBytes, escHtml, showToast } from './shared.js';
import { geopbf } from './gpbf.js';

let _dlActive = false;
let _dlCancel = false;

export async function bulkDownload(entries, label, fetchFn = null, parallel = null, onComplete = null) {
    if (_dlActive || !entries.length) return;

    const isMoj = entries.some(e => e.format === 'moj');
    if (isMoj && entries.length > 1) {
        const totalZip = entries.reduce((s, e) => s + (e.size || 0), 0);
        const ok = window.confirm(
            `${label}\n\n` +
            (totalZip ? `ZIP合計: ${fmtBytes(totalZip)}\n推定メモリ使用: ${fmtBytes(totalZip * 20)} 程度\n\n` : '') +
            `MOJ（14条地図）は GML/XML 形式のため、ZIP サイズの\n` +
            `10〜30 倍のメモリを消費します。\n` +
            `${entries.length} 件を最大5件並列で処理します。\n\n続行しますか？`
        );
        if (!ok) return;
    }

    _dlActive = true;
    _dlCancel = false;

    const fn       = fetchFn ?? (e => e.format === 'moj' ? geopbf(e.target, { format: 'moj' }) : geopbf(e.target));
    const PARALLEL = parallel ?? 5;
    const total    = entries.length;
    let done = 0, errors = 0;
    const active = new Map();

    const modal = _openDlModal(label, total);
    modal.querySelector('.dl-cancel-btn').onclick = () => {
        _dlCancel = true;
        _dlActive = false;
        _closeDlModal(modal);
    };

    const refresh = () => _refreshDlModal(modal, done, total, errors, active);

    const onFetchProgress = ({ detail }) => {
        const name = (detail.name || '').replace(/\.[^.]+$/, '');
        if (!active.has(name)) return;
        const s = active.get(name);
        s.phase = 'fetch'; s.loaded = detail.loaded; s.total = detail.total;
        refresh();
    };
    const onConvertStart = ({ detail }) => {
        if (!active.has(detail.name)) return;
        active.get(detail.name).phase = 'convert';
        refresh();
    };
    const onConvertProgress = ({ detail }) => {
        if (!active.has(detail.name)) return;
        const s = active.get(detail.name);
        s.phase = 'convert'; s.loaded = detail.loaded; s.total = detail.total;
        refresh();
    };
    window.addEventListener('FetchProgress',   onFetchProgress);
    window.addEventListener('ConvertStart',    onConvertStart);
    window.addEventListener('ConvertProgress', onConvertProgress);

    const queue = [...entries];
    const runWorker = async () => {
        while (queue.length && !_dlCancel) {
            const entry = queue.shift();
            active.set(entry.name, { loaded: 0, total: 0, phase: 'fetch' });
            refresh();
            try {
                const pbf = await fn(entry);
                done++;
                if (onComplete && pbf) onComplete(pbf);
                const s = active.get(entry.name);
                if (s) {
                    s.phase = 'done';
                    const sz = pbf?.size || entry.size || s.total || s.loaded;
                    s.loaded = sz; s.total = sz;
                    // moj/ui.js は静的 import しない（マニフェスト4MB級が初期バンドルへ逆流するため）。
                    // moj の一括DL時点でモジュールは読込済み＝この import はキャッシュから即時解決
                    if (pbf?.size && entry.format === 'moj') {
                        import('../moj/ui.js').then(m => m.mojSavePbfSize(entry.name, pbf.size)).catch(() => {});
                    }
                }
            } catch {
                if (!_dlCancel) errors++;
                const s = active.get(entry.name);
                if (s) s.phase = 'error';
            }
            refresh();
            await new Promise(r => setTimeout(r, 200));
            active.delete(entry.name);
            refresh();
        }
    };

    try {
        await Promise.all(Array.from({ length: PARALLEL }, runWorker));
    } finally {
        window.removeEventListener('FetchProgress',   onFetchProgress);
        window.removeEventListener('ConvertStart',    onConvertStart);
        window.removeEventListener('ConvertProgress', onConvertProgress);
        _dlActive = false;
    }

    if (!_dlCancel) {
        _closeDlModal(modal);
        showToast(`${done.toLocaleString()}件をIDBに保存${errors ? ` (${errors}件エラー)` : ''}`);
    }
}

function _openDlModal(label, total) {
    const el = document.createElement('div');
    el.className = 'dl-modal';
    el.innerHTML = `
        <div class="dl-box">
            <div class="dl-header">
                <span class="dl-title">一括読込 → IDB</span>
                <span class="dl-label">${escHtml(label)}</span>
            </div>
            <div class="dl-bar-wrap"><div class="dl-bar-fill" id="dl-fill"></div></div>
            <div class="dl-stat">
                <span id="dl-pct" class="dl-pct">0%</span>
                <span id="dl-done">0</span> / <span class="dl-total">${total.toLocaleString()}</span>
                <span id="dl-err" class="dl-err"></span>
            </div>
            <div class="dl-active" id="dl-active-list"></div>
            <button class="dl-cancel-btn">キャンセル</button>
        </div>
    `;
    document.body.appendChild(el);
    return el;
}

function _refreshDlModal(modal, done, total, errors, active) {
    if (!modal.isConnected) return;
    const pct = (done / total * 100).toFixed(1);
    const fill  = modal.querySelector('#dl-fill');  if (fill)  fill.style.width = `${pct}%`;
    const pctEl = modal.querySelector('#dl-pct');   if (pctEl) pctEl.textContent = `${pct}%`;
    const doneEl = modal.querySelector('#dl-done'); if (doneEl) doneEl.textContent = done.toLocaleString();
    const errEl  = modal.querySelector('#dl-err');  if (errEl)  errEl.textContent = errors ? `${errors}件エラー` : '';
    const list = modal.querySelector('#dl-active-list');
    if (!list) return;
    list.innerHTML = [...active.entries()].map(([n, s]) => {
        const mark = s.phase === 'done' ? '✓' : s.phase === 'error' ? '✗' : s.phase === 'convert' ? '⚙' : '↓';
        const info = s.phase === 'convert' && s.total
            ? ` <span class="dl-bytes">${s.loaded} / ${s.total}</span>`
            : s.total  ? ` <span class="dl-bytes">${fmtBytes(s.loaded)} / ${fmtBytes(s.total)}</span>`
            : s.loaded ? ` <span class="dl-bytes">${fmtBytes(s.loaded)}</span>`
            : '';
        return `<div class="dl-item dl-item-${s.phase}">${mark} ${escHtml(n)}${info}</div>`;
    }).join('');
}

function _closeDlModal(modal) {
    modal.classList.add('dl-closing');
    setTimeout(() => modal.remove(), 200);
}
