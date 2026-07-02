// 小地域統計データ
// ・T001081 (人口) → 初回のみ全国CSV download → IndexedDB に市区町村単位で格納
// ・以降は idbGet(cityCode5) で瞬時参照
// ・T001082 (年齢別) → 都道府県ZIPを初回のみ e-Stat 取得 → 市区町村単位で IDB 永続化
//   以降は pyrIdbGet(cityCode5) で瞬時参照。UIは人口を先に描画し年齢は後追い（非ブロッキング）

const GIS_STATS_BASE = 'https://www.e-stat.go.jp/gis/statmap-search/data';
const DB_NAME   = 'gishub-census';

// 年ごとの e-Stat GIS 小地域テーブル & IDB ストア設定。
//   sa   人口       key=市区町村5桁 → [[code,name,total,m,f], ...]（CSV を初回だけ取り込み）
//   pyr  年齢別     key=市区町村5桁 → Map<areaCode,{mAges,fAges}>（都道府県ZIPを初回取得）
//   stat 就業・世帯 key=市区町村5桁 → Map<areaCode,{ind,occ,eco,fam,own,dwell}>
//   pyr/stat とも各行 slice(7)。`__pref_NN` / `__pref6_NN` マーカーで都道府県取得済みを判定
const YEARS = {
    '2020': {
        csv: '2020-small.csv',
        sa: 'small2020', pyr: 'pyr2020', stat: 'stats2020',
        pyrT: 'T001082',
        ind: 'T001103', occ: 'T001104', eco: 'T001106',
        fam: 'T001084', own: 'T001085', dwell: 'T001086',
    },
    '2015': {
        csv: '2015-small.csv',
        sa: 'small2015', pyr: 'pyr2015', stat: 'stats2015',
        pyrT: 'T000849',
        ind: 'T000865', occ: 'T000866', eco: 'T000875',
        fam: 'T000851', own: 'T000852', dwell: 'T000853',
    },
    // ★2025基本集計（年齢・就業・住宅、2026年秋公開予定）が出たら下記を有効化するだけで
    //   2020/2015 と同じ小地域ドリルが 2025 でも動く。手順:
    //   1. e-Stat GIS で 2025 の各 statsId を確定（scripts の probe パターンで T-code 探索）。
    //      年齢表の列位置は 2015/2020 とも slice(28,43)+[46] / slice(48,63)+[66] で共通だったので
    //      2025 も同一と想定（要検証。違えば ensurePrefPyramid を年別に分岐）。
    //   2. scripts/build-2020-small.mjs を複製し statsId を 2025 人口表に変えて 2025-small.csv 生成。
    //   3. ui.js: CENSUS_2025_AGES/STATS/HOUSEHOLD を import、_NAT_AGES に '2025' 追加、
    //      _csDrill25City を _levelDisplayHtml(..., '2025') + _attachSmallAreaList(...,'2025') に切替、
    //      charts.mjs appendStatus に 2025 の就業地位カラム位置を追加（既定は2020と同じ）。
    // '2025': {
    //     csv: '2025-small.csv',
    //     sa: 'small2025', pyr: 'pyr2025', stat: 'stats2025',
    //     pyrT: 'T00XXXXX',
    //     ind: 'T00XXXXX', occ: 'T00XXXXX', eco: 'T00XXXXX',
    //     fam: 'T00XXXXX', own: 'T00XXXXX', dwell: 'T00XXXXX',
    // },
};
const _cfg = year => YEARS[year] || YEARS['2020'];

const STORES = Object.values(YEARS).flatMap(y => [y.sa, y.pyr, y.stat]);

// 読み込み確認用マーカー（このログが出れば stats2020 対応の最新版が実行されている）
console.info('[small-area] loaded — stats2020対応版（就業・世帯経済）');

// ---- IDB helpers -----------------------------------------------------------

let _db = null;

const _hasAllStores = db => STORES.every(s => db.objectStoreNames.contains(s));

// version 指定あり: 昇格して欠けているストアを作成。指定なし: 現行バージョンで開くだけ
function _rawOpen(version) {
    return new Promise((res, rej) => {
        const req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
        req.onupgradeneeded = ({ target: { result: db } }) => {
            for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        };
        req.onsuccess = ({ target: { result: db } }) => {
            db.onversionchange = () => { db.close(); if (_db === db) _db = null; };
            res(db);
        };
        req.onerror   = ({ target: { error } }) => rej(error);
        req.onblocked = () => console.warn('[small-area] IDB upgrade blocked — 別タブを閉じて再読み込みしてください');
    });
}

// バージョン番号に依存せず、必要ストアが揃うことを保証して開く。
// 既にオンディスクが最新バージョンでもストアが欠けていれば version+1 で強制アップグレードする
// （＝以前 v4 だが stats2020 未作成、のような状態からも自己修復する）
async function openDb() {
    if (_db && _hasAllStores(_db)) return _db;
    if (_db) { try { _db.close(); } catch {} _db = null; }
    let db = await _rawOpen();                 // 現行バージョンで開く
    if (!_hasAllStores(db)) {                  // ストアが欠けていれば強制昇格
        const next = db.version + 1;
        console.info(`[small-area] IDB自己修復: v${db.version} にストア欠落 → v${next} へ昇格`);
        db.close();
        db = await _rawOpen(next);
        console.info(`[small-area] 修復完了: v${db.version}`, [...db.objectStoreNames]);
    }
    _db = db;
    return db;
}

function idbCount(saStore) {
    return openDb().then(db => new Promise((res, rej) => {
        const req = db.transaction(saStore, 'readonly').objectStore(saStore).count();
        req.onsuccess = e => res(e.target.result);
        req.onerror   = e => rej(e.target.error);
    }));
}

function idbGet(saStore, key) {
    return openDb().then(db => new Promise((res, rej) => {
        const req = db.transaction(saStore, 'readonly').objectStore(saStore).get(key);
        req.onsuccess = e => res(e.target.result ?? []);
        req.onerror   = e => rej(e.target.error);
    }));
}

function idbPutAll(saStore, map) {
    return openDb().then(db => new Promise((res, rej) => {
        const tx    = db.transaction(saStore, 'readwrite');
        const store = tx.objectStore(saStore);
        for (const [key, val] of map) store.put(val, key);
        tx.oncomplete = res;
        tx.onerror    = e => rej(e.target.error);
    }));
}

// ---- CSV → IDB 一括ロード --------------------------------------------------

const _populatePromise = {};   // year → Promise

async function _populate(year) {
    const cfg = _cfg(year);
    if (await idbCount(cfg.sa) > 0) return;     // already stored

    const url  = `${import.meta.env.BASE_URL}census/${cfg.csv}`;
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
    await idbPutAll(cfg.sa, map);
}

export async function isSmallAreaReady(year = '2020') {
    try { return await idbCount(_cfg(year).sa) > 0; } catch { return false; }
}

// バックグラウンドで IDB に書き込み開始（年ごとに二重実行しない）
export function prefetchSmallAreaIdb(year = '2020') {
    if (!_populatePromise[year])
        _populatePromise[year] = _populate(year).catch(e => { console.warn(`[small-area] IDB populate failed (${year}):`, e); });
    return _populatePromise[year];
}

// ---- 小地域データ取得（IDB から） ------------------------------------------

// Returns { items: [[code, name], ...], popMap: Map<code, {total,m,f}> }
export async function fetchSmallAreaData(cityCode, year = '2020') {
    await prefetchSmallAreaIdb(year);
    const entries = await idbGet(_cfg(year).sa, cityCode);
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

function pyrIdbGet(pyrStore, cityCode) {
    return openDb().then(db => new Promise((res, rej) => {
        const req = db.transaction(pyrStore, 'readonly').objectStore(pyrStore).get(cityCode);
        req.onsuccess = e => res(e.target.result || null);
        req.onerror   = e => rej(e.target.error);
    }));
}

function pyrIdbHasPref(pyrStore, prefCode) {
    return openDb().then(db => new Promise((res, rej) => {
        const req = db.transaction(pyrStore, 'readonly').objectStore(pyrStore).get(`__pref_${prefCode}`);
        req.onsuccess = e => res(!!e.target.result);
        req.onerror   = e => rej(e.target.error);
    })).catch(() => false);
}

// 都道府県1件分の全市区町村マップをまとめて保存（+取得済みマーカー）
function pyrIdbPutPref(pyrStore, prefCode, byCity) {
    return openDb().then(db => new Promise((res, rej) => {
        const tx    = db.transaction(pyrStore, 'readwrite');
        const store = tx.objectStore(pyrStore);
        for (const [city, map] of byCity) store.put(map, city);
        store.put(1, `__pref_${prefCode}`);
        tx.oncomplete = res;
        tx.onerror    = e => rej(e.target.error);
    }));
}

// ---- T001082 フェッチ（都道府県ZIP → 市区町村単位で IDB 永続化） -----------

async function fetchStatRows(statsId, prefCode, apiBase) {
    const url  = `${GIS_STATS_BASE}?statsId=${statsId}&downloadType=2&code=${prefCode}`;
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

async function ensurePrefPyramid(prefCode, apiBase, year) {
    const cfg = _cfg(year);
    if (await pyrIdbHasPref(cfg.pyr, prefCode)) return;
    const key = `${year}_${prefCode}`;
    if (_prefLoading.has(key)) return _prefLoading.get(key);
    const p = (async () => {
        // 年齢別テーブル（2020 T001082 / 2015 T000849）。列位置は両年共通:
        // 男 col 28-42 + 46 = 16グループ、女 col 48-62 + 66
        const rows   = await fetchStatRows(cfg.pyrT, prefCode, apiBase);
        const byCity = new Map();   // 市区町村5桁 → Map<areaCode,{mAges,fAges}>
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
        await pyrIdbPutPref(cfg.pyr, prefCode, byCity);
    })().finally(() => _prefLoading.delete(key));
    _prefLoading.set(key, p);
    return p;
}

// 市区町村の小地域ピラミッド Map<areaCode,{mAges,fAges}>
// e-Stat 都道府県ZIP を直接取得 → 市区町村単位で IDB 永続化（初回のみ・以降は即時）
export async function fetchSmallAreaPyramid(cityCode, apiBase, year = '2020') {
    await ensurePrefPyramid(cityCode.slice(0, 2), apiBase, year);
    return (await pyrIdbGet(_cfg(year).pyr, cityCode)) || new Map();
}

// ---- 就業・世帯経済 IDB ヘルパー（stat ストア、pyr と同構造） ----------------

function statIdbGet(statStore, cityCode) {
    return openDb().then(db => new Promise((res, rej) => {
        const req = db.transaction(statStore, 'readonly').objectStore(statStore).get(cityCode);
        req.onsuccess = e => res(e.target.result || null);
        req.onerror   = e => rej(e.target.error);
    }));
}

function statIdbHasPref(statStore, prefCode) {
    return openDb().then(db => new Promise((res, rej) => {
        const req = db.transaction(statStore, 'readonly').objectStore(statStore).get(`__pref6_${prefCode}`);
        req.onsuccess = e => res(!!e.target.result);
        req.onerror   = e => rej(e.target.error);
    })).catch(() => false);
}

function statIdbPutPref(statStore, prefCode, byCity) {
    return openDb().then(db => new Promise((res, rej) => {
        const tx    = db.transaction(statStore, 'readwrite');
        const store = tx.objectStore(statStore);
        for (const [city, map] of byCity) store.put(map, city);
        store.put(1, `__pref6_${prefCode}`);   // 6表版マーカー（旧__pref_は再取得させる）
        tx.oncomplete = res;
        tx.onerror    = e => rej(e.target.error);
    }));
}

// ---- 就業(ind/occ/eco)+世帯住宅(fam/own/dwell) フェッチ（都道府県ZIP → 市区町村単位で IDB 永続化）----
// 2020: ind=T001103, occ=T001104, eco=T001106, fam=T001084, own=T001085, dwell=T001086
// 2015: ind=T000865, occ=T000866, eco=T000875, fam=T000851, own=T000852, dwell=T000853
// いずれも各行 slice(7)。
const _statLoading = new Map();

async function ensurePrefStats(prefCode, apiBase, year) {
    const cfg = _cfg(year);
    if (await statIdbHasPref(cfg.stat, prefCode)) return;
    const key = `${year}_${prefCode}`;
    if (_statLoading.has(key)) return _statLoading.get(key);
    const p = (async () => {
        // 就業(ind/occ/eco) + 世帯住宅(fam/dwell/own) を並列取得
        const [tInd, tOcc, tEco, tFam, tOwn, tDwell] = await Promise.all([
            fetchStatRows(cfg.ind, prefCode, apiBase),
            fetchStatRows(cfg.occ, prefCode, apiBase),
            fetchStatRows(cfg.eco, prefCode, apiBase),
            fetchStatRows(cfg.fam, prefCode, apiBase),
            fetchStatRows(cfg.own, prefCode, apiBase),
            fetchStatRows(cfg.dwell, prefCode, apiBase),
        ]);
        const byCity = new Map();   // 市区町村5桁 → Map<areaCode,{ind,occ,eco,fam,dwell,own}>
        const clean  = a => a.map(v => +v || 0);
        const merge  = (rows, key) => {
            for (const t of rows) {
                const code = String(t[0] || '');
                if (code.length <= 5) continue;     // 市区町村集計行は除外
                const city = code.slice(0, 5);
                let m = byCity.get(city);
                if (!m) { m = new Map(); byCity.set(city, m); }
                let o = m.get(code);
                if (!o) { o = {}; m.set(code, o); }
                o[key] = clean(t.slice(7));
            }
        };
        merge(tInd, 'ind'); merge(tOcc, 'occ'); merge(tEco, 'eco');
        merge(tFam, 'fam'); merge(tOwn, 'own'); merge(tDwell, 'dwell');
        await statIdbPutPref(cfg.stat, prefCode, byCity);
    })().finally(() => _statLoading.delete(key));
    _statLoading.set(key, p);
    return p;
}

// 市区町村の小地域就業・世帯経済 Map<areaCode,{ind,occ,eco,fam,own,dwell}>
export async function fetchSmallAreaStats(cityCode, apiBase, year = '2020') {
    await ensurePrefStats(cityCode.slice(0, 2), apiBase, year);
    return (await statIdbGet(_cfg(year).stat, cityCode)) || new Map();
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
    const W  = 140, H = 11;
    const yw = (young / total * W).toFixed(1);
    const ww = (work  / total * W).toFixed(1);
    const ow = (old   / total * W).toFixed(1);
    return `<svg width="${W}" height="${H}" style="vertical-align:middle;border-radius:2px;overflow:hidden">` +
        `<rect x="0" y="0" width="${yw}" height="${H}" fill="#5a9"/>` +
        `<rect x="${yw}" y="0" width="${ww}" height="${H}" fill="#579"/>` +
        `<rect x="${+yw + +ww}" y="0" width="${ow}" height="${H}" fill="#a65"/>` +
        '</svg>';
}
