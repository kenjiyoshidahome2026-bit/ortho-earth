// 小地域統計データ
// ・T001081 (人口) → 初回のみ全国CSV download → IndexedDB に市区町村単位で格納
// ・以降は idbGet(cityCode5) で瞬時参照
// ・T001082 (年齢別) → 都道府県ZIPを初回のみ e-Stat 取得 → 市区町村単位で IDB 永続化
//   以降は pyrIdbGet(cityCode5) で瞬時参照。UIは人口を先に描画し年齢は後追い（非ブロッキング）

const GIS_STATS_BASE = 'https://www.e-stat.go.jp/gis/statmap-search/data';
const DB_NAME   = 'gishub-census';
const DB_VER    = 2;
const SA_STORE  = 'small2020';   // 人口 T001081: key=市区町村5桁 → [[code,name,total,m,f], ...]
const PYR_STORE = 'pyr2020';     // 年齢 T001082: key=市区町村5桁 → Map<areaCode,{mAges,fAges}>
                                 //   `__pref_NN` マーカーで都道府県取得済みを判定

// ---- IDB helpers -----------------------------------------------------------

let _db = null;

function openDb() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
        const req = indexedDB.open(DB_NAME, DB_VER);
        req.onupgradeneeded = ({ target: { result: db } }) => {
            if (!db.objectStoreNames.contains(SA_STORE))
                db.createObjectStore(SA_STORE);
            if (!db.objectStoreNames.contains(PYR_STORE))
                db.createObjectStore(PYR_STORE);
        };
        req.onsuccess = ({ target: { result: db } }) => { _db = db; res(db); };
        req.onerror   = ({ target: { error } }) => rej(error);
    });
}

function idbCount() {
    return openDb().then(db => new Promise((res, rej) => {
        const req = db.transaction(SA_STORE, 'readonly').objectStore(SA_STORE).count();
        req.onsuccess = e => res(e.target.result);
        req.onerror   = e => rej(e.target.error);
    }));
}

function idbGet(key) {
    return openDb().then(db => new Promise((res, rej) => {
        const req = db.transaction(SA_STORE, 'readonly').objectStore(SA_STORE).get(key);
        req.onsuccess = e => res(e.target.result ?? []);
        req.onerror   = e => rej(e.target.error);
    }));
}

function idbPutAll(map) {
    return openDb().then(db => new Promise((res, rej) => {
        const tx    = db.transaction(SA_STORE, 'readwrite');
        const store = tx.objectStore(SA_STORE);
        for (const [key, val] of map) store.put(val, key);
        tx.oncomplete = res;
        tx.onerror    = e => rej(e.target.error);
    }));
}

// ---- CSV → IDB 一括ロード --------------------------------------------------

let _populatePromise = null;

async function _populate() {
    if (await idbCount() > 0) return;           // already stored

    const url  = `${import.meta.env.BASE_URL}census/2020-small.csv`;
    const text = await (await fetch(url)).text();
    const map  = new Map();
    for (const line of text.split('\n')) {
        if (!line) continue;
        const ci   = line.indexOf(',');
        const code = line.slice(0, ci);
        const rest = line.slice(ci + 1);
        let name, tail;
        if (rest.charCodeAt(0) === 34) {        // quoted name
            const end = rest.indexOf('"', 1);
            name = rest.slice(1, end);
            tail = rest.slice(end + 2).split(',');
        } else {
            const p = rest.indexOf(',');
            name    = rest.slice(0, p);
            tail    = rest.slice(p + 1).split(',');
        }
        const total = +tail[0] || 0, male = +tail[1] || 0, fem = +tail[2] || 0;
        const city  = code.slice(0, 5);
        if (!map.has(city)) map.set(city, []);
        map.get(city).push([code, name, total, male, fem]);
    }
    await idbPutAll(map);
}

export async function isSmallAreaReady() {
    try { return await idbCount() > 0; } catch { return false; }
}

// バックグラウンドで IDB に書き込み開始（二重実行しない）
export function prefetchSmallAreaIdb() {
    if (!_populatePromise)
        _populatePromise = _populate().catch(e => { console.warn('[small-area] IDB populate failed:', e); });
    return _populatePromise;
}

// ---- 小地域データ取得（IDB から） ------------------------------------------

// Returns { items: [[code, name], ...], popMap: Map<code, {total,m,f}> }
export async function fetchSmallAreaData(cityCode) {
    await prefetchSmallAreaIdb();
    const entries = await idbGet(cityCode);
    const items   = entries.map(([code, name]) => [code, name]);
    const popMap  = new Map(entries.map(([code, , total, male, fem]) =>
        [code, { total, m: male, f: fem }]));
    return { items, popMap };
}

// ---- T001082 フェッチ（都道府県キャッシュ付き） ----------------------------

async function unzipFirstEntry(blob) {
    const buf = await blob.arrayBuffer();
    const u8  = new Uint8Array(buf);
    const v   = new DataView(buf);
    if (v.getUint32(0, true) !== 0x04034b50) throw new Error('Not a ZIP');
    const method = v.getUint16(8, true);
    const fnLen  = v.getUint16(26, true);
    const exLen  = v.getUint16(28, true);
    const start  = 30 + fnLen + exLen;
    let comp = v.getUint32(18, true);
    if (comp === 0) {
        for (let i = start + 4; i < u8.length - 4; i++) {
            const sig = v.getUint32(i, true);
            if (sig === 0x02014b50 || sig === 0x04034b50 || sig === 0x08074b50) { comp = i - start; break; }
        }
    }
    const slice = u8.subarray(start, start + comp);
    if (method === 0) return slice;
    if (method === 8) return new Uint8Array(
        await new Response(new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()
    );
    throw new Error(`ZIP method ${method}`);
}

// ---- ピラミッド IDB ヘルパー -----------------------------------------------

function pyrIdbGet(cityCode) {
    return openDb().then(db => new Promise((res, rej) => {
        const req = db.transaction(PYR_STORE, 'readonly').objectStore(PYR_STORE).get(cityCode);
        req.onsuccess = e => res(e.target.result || null);
        req.onerror   = e => rej(e.target.error);
    }));
}

function pyrIdbHasPref(prefCode) {
    return openDb().then(db => new Promise((res, rej) => {
        const req = db.transaction(PYR_STORE, 'readonly').objectStore(PYR_STORE).get(`__pref_${prefCode}`);
        req.onsuccess = e => res(!!e.target.result);
        req.onerror   = e => rej(e.target.error);
    })).catch(() => false);
}

// 都道府県1件分の全市区町村マップをまとめて保存（+取得済みマーカー）
function pyrIdbPutPref(prefCode, byCity) {
    return openDb().then(db => new Promise((res, rej) => {
        const tx    = db.transaction(PYR_STORE, 'readwrite');
        const store = tx.objectStore(PYR_STORE);
        for (const [city, map] of byCity) store.put(map, city);
        store.put(1, `__pref_${prefCode}`);
        tx.oncomplete = res;
        tx.onerror    = e => rej(e.target.error);
    }));
}

// ---- T001082 フェッチ（都道府県ZIP → 市区町村単位で IDB 永続化） -----------

async function fetchT082Rows(prefCode, apiBase) {
    const url  = `${GIS_STATS_BASE}?statsId=T001082&downloadType=2&code=${prefCode}`;
    const resp = await fetch(`${apiBase}/proxy/?url=${encodeURIComponent(url)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = await unzipFirstEntry(await resp.blob());
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('shift-jis').decode(bytes); }
    return text.split(/\r?\n/).map(l => l.split(',').map(s => s.replace(/^"|"$/g, '')));
}

// 都道府県分を取得・パースして IDB に格納（二重取得は in-flight で dedup）
const _prefLoading = new Map();

async function ensurePrefPyramid(prefCode, apiBase) {
    if (await pyrIdbHasPref(prefCode)) return;
    if (_prefLoading.has(prefCode)) return _prefLoading.get(prefCode);
    const p = (async () => {
        const rows   = await fetchT082Rows(prefCode, apiBase);
        const byCity = new Map();   // 市区町村5桁 → Map<areaCode,{mAges,fAges}>
        // T001082: 男 col 28-42 + 46 = 16グループ、女 col 48-62 + 66
        for (const t of rows) {
            const code = String(t[0] || '');
            if (code.length <= 5) continue;         // 市区町村集計行は除外
            const city  = code.slice(0, 5);
            const clean = a => a.map(v => +v || 0);
            let m = byCity.get(city);
            if (!m) { m = new Map(); byCity.set(city, m); }
            m.set(code, {
                mAges: clean([...t.slice(28, 43), t[46]]),
                fAges: clean([...t.slice(48, 63), t[66]]),
            });
        }
        await pyrIdbPutPref(prefCode, byCity);
    })().finally(() => _prefLoading.delete(prefCode));
    _prefLoading.set(prefCode, p);
    return p;
}

// 市区町村の小地域ピラミッド Map<areaCode,{mAges,fAges}>
// e-Stat 都道府県ZIP を直接取得 → 市区町村単位で IDB 永続化（初回のみ・以降は即時）
export async function fetchSmallAreaPyramid(cityCode, apiBase) {
    await ensurePrefPyramid(cityCode.slice(0, 2), apiBase);
    return (await pyrIdbGet(cityCode)) || new Map();
}

// ---- SVG 描画 ---------------------------------------------------------------

export function miniAgeBar(mAges, fAges) {
    if (!mAges?.length) return '';
    const all   = mAges.map((m, i) => m + fAges[i]);
    const total = all.reduce((s, v) => s + v, 0);
    if (!total) return '';
    const young = all.slice(0, 3).reduce((s, v) => s + v, 0);
    const work  = all.slice(3, 13).reduce((s, v) => s + v, 0);
    const old   = all.slice(13).reduce((s, v) => s + v, 0);
    const W  = 60;
    const yw = (young / total * W).toFixed(1);
    const ww = (work  / total * W).toFixed(1);
    const ow = (old   / total * W).toFixed(1);
    return `<svg width="${W}" height="8" style="vertical-align:middle;border-radius:2px;overflow:hidden">` +
        `<rect x="0" y="0" width="${yw}" height="8" fill="#5a9"/>` +
        `<rect x="${yw}" y="0" width="${ww}" height="8" fill="#579"/>` +
        `<rect x="${+yw + +ww}" y="0" width="${ow}" height="8" fill="#a65"/>` +
        '</svg>';
}
