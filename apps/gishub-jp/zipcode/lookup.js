// 郵便番号ルックアップ（独立モジュール）
// 出所は日本郵便（utf_ken_all.csv）。census とは別権威・別更新周期のため分離。
// データは小地域コード（9桁=町丁・字等 / 11桁=丁目・基本単位区）→ 郵便番号 の crosswalk。
//   値: "1000005" | "1000005,1000006"（丁目で複数）| "~0600000"（市代表番号を近似で当てた印）
// 生成: scripts/build-zip-by-area.mjs → public/zipcode/area-zip.json（2.2MB, ランタイムfetch）
//
// 依存方向は一方向: census/ui.js → 本モジュール。本モジュールは census を参照しない。
// 公開API: prefetchZip()（先読み）, fillZips(root)（[data-zip-code]スロット埋め）

let _map = null, _mapP = null;

// 2.2MBのためバンドルせずランタイムfetch（多重実行しない）
export function prefetchZip() {
    if (_map) return Promise.resolve(_map);
    if (!_mapP) _mapP = fetch(`${import.meta.env.BASE_URL}zipcode/area-zip.json`)
        .then(r => r.ok ? r.json() : null)
        .then(j => { _map = j || {}; return _map; })
        .catch(e => { console.warn('[zipcode] load failed:', e); _mapP = null; return {}; });
    return _mapP;
}

const _fmt = z => z.length === 7 ? `${z.slice(0, 3)}-${z.slice(3)}` : z;

// 小地域コード(9桁/11桁)→ 〒表示HTML。11桁は9桁親の番号を継承。~接頭は市代表番号（近似）
export function zipHtml(code) {
    const raw = _map?.[code] || _map?.[code?.slice(0, 9)];
    if (!raw) return '';
    const approx = raw[0] === '~';
    const zips = (approx ? raw.slice(1) : raw).split(',').map(_fmt);
    return `<span class="cs-zip${approx ? ' cs-zip-approx' : ''}">〒${zips.join(' / ')}` +
        `${approx ? '<span class="cs-zip-note">市代表</span>' : ''}</span>`;
}

// [data-zip-code] スロットを郵便番号ロード後に埋める（非ブロッキング）
export function fillZips(root = document) {
    const slots = [...root.querySelectorAll('[data-zip-code]')];
    if (!slots.length) return;
    prefetchZip().then(() => {
        for (const el of slots) if (el.isConnected) el.innerHTML = zipHtml(el.dataset.zipCode);
    });
}
