/**
 * L03-b_r（土地利用細分メッシュ ラスタ版）ビューワー
 *
 * モーダルなし。背面の地球に直接描画し、X ボタン（または Escape）で復帰。
 * 変換進捗は画面下部の HUD に表示。IDB にキャッシュして再訪時は即表示。
 */
import { API_BASE } from '../ui/config.js';
import { getMapInst, enterGlobeView } from '../ui/globe.js';

const NLFTP_BASE  = 'https://nlftp.mlit.go.jp';
const PAGE_PATH   = '/ksj/gml/datalist/KsjTmplt-L03-b_r.html';
const CONCURRENCY = 4;
const DB_NAME     = 'gishub-jp';
const DB_VERSION  = 1;
const STORE_NAME  = 'L03bR-raster';

function nlftp2proxy(url) {
    return `${API_BASE}/proxy/?url=${encodeURIComponent(url)}`;
}

// ---- IDB ---------------------------------------------------------------

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME))
                db.createObjectStore(STORE_NAME, { keyPath: 'meshCode' });
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
    });
}
function idbGetAll(db) {
    return new Promise((resolve, reject) => {
        const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = e => reject(e.target.error);
    });
}
function idbPut(db, record) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = resolve;
        tx.onerror    = e => reject(e.target.error);
    });
}
function idbClear(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = resolve;
        tx.onerror    = e => reject(e.target.error);
    });
}

// ---- ZIP builder (STORE method: WebP は既に圧縮済み) -------------------

function buildCrcTable() {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
    }
    return t;
}
const CRC_TABLE = buildCrcTable();

function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ data[i]) & 0xff];
    return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
    const enc   = new TextEncoder();
    const names = entries.map(e => enc.encode(e.name));
    const crcs  = entries.map(e => crc32(e.data));

    let totalSize = 0;
    for (let i = 0; i < entries.length; i++) totalSize += 30 + names[i].length + entries[i].data.length;
    const cdStart = totalSize;
    for (let i = 0; i < entries.length; i++) totalSize += 46 + names[i].length;
    totalSize += 22;

    const out = new Uint8Array(totalSize);
    const dv  = new DataView(out.buffer);
    const w16 = (o, v) => dv.setUint16(o, v, true);
    const w32 = (o, v) => dv.setUint32(o, v, true);
    let pos = 0;
    const offsets = [];

    for (let i = 0; i < entries.length; i++) {
        offsets.push(pos);
        w32(pos,    0x04034b50); w16(pos+4,  20); w16(pos+6, 0); w16(pos+8, 0);
        w16(pos+10, 0); w16(pos+12, 0);
        w32(pos+14, crcs[i]);
        w32(pos+18, entries[i].data.length); w32(pos+22, entries[i].data.length);
        w16(pos+26, names[i].length); w16(pos+28, 0);
        out.set(names[i], pos + 30);
        out.set(entries[i].data, pos + 30 + names[i].length);
        pos += 30 + names[i].length + entries[i].data.length;
    }
    for (let i = 0; i < entries.length; i++) {
        w32(pos,    0x02014b50); w16(pos+4, 20); w16(pos+6, 20);
        w16(pos+8,  0); w16(pos+10, 0); w16(pos+12, 0); w16(pos+14, 0);
        w32(pos+16, crcs[i]);
        w32(pos+20, entries[i].data.length); w32(pos+24, entries[i].data.length);
        w16(pos+28, names[i].length); w16(pos+30, 0); w16(pos+32, 0);
        w16(pos+34, 0); w16(pos+36, 0); w32(pos+38, 0); w32(pos+42, offsets[i]);
        out.set(names[i], pos + 46);
        pos += 46 + names[i].length;
    }
    w32(pos, 0x06054b50); w16(pos+4, 0); w16(pos+6, 0);
    w16(pos+8, entries.length); w16(pos+10, entries.length);
    w32(pos+12, pos - cdStart); w32(pos+16, cdStart); w16(pos+20, 0);

    return out;
}

// ---- メイン ------------------------------------------------------------

export async function openL03bRViewer() {
    // 二重起動防止
    if (document.getElementById('l03br-hud')) return;

    // IDB（失敗しても続行）
    let db = null;
    try { db = await openDB(); } catch (e) { console.warn('[L03-b_r] IDB 利用不可:', e); }

    // ---- HUD（画面下部の常時表示バー）----------------------------------
    const hud = document.createElement('div');
    hud.className = 'l03br-hud';
    hud.id        = 'l03br-hud';
    hud.innerHTML = `
        <span class="l03br-hud-status" id="l03br-hud-status">初期化中...</span>
        <span class="l03br-hud-prog"   id="l03br-hud-prog"></span>
        <button class="l03br-hud-dl"   id="l03br-hud-dl"   disabled>ZIP DL</button>
        <button class="l03br-hud-redo" id="l03br-hud-redo" style="display:none">再変換</button>
    `;
    document.body.appendChild(hud);

    const statusEl = document.getElementById('l03br-hud-status');
    const progEl   = document.getElementById('l03br-hud-prog');
    const dlBtn    = document.getElementById('l03br-hud-dl');
    const redoBtn  = document.getElementById('l03br-hud-redo');

    // ---- 地球レイヤー --------------------------------------------------
    const mapInst = getMapInst();
    mapInst.autoRotate(false);
    mapInst.setView([137, 36], 4);
    mapInst.removeLayer?.('L03bR-Raster');

    let globeLayer = null;
    try {
        globeLayer = await mapInst.createRemoteLayer({ name: 'L03bR-Raster', type: 'image' });
        globeLayer.opacity(0.85);
    } catch (e) {
        console.error('[L03-b_r] レイヤー作成失敗:', e);
        hud.remove();
        return;
    }

    // ---- 状態管理 ------------------------------------------------------
    let alive = true;
    const workers = new Set();
    const webpMap = new Map(); // meshCode → { webpData: Uint8Array, bbox: [w,s,e,n] }
    let total = 0, done = 0, errors = 0;

    // X ボタン・Escape で exitGlobeView() → このクリーンアップが呼ばれる
    enterGlobeView(() => {
        alive = false;
        for (const w of workers) w.terminate();
        if (globeLayer) { globeLayer.destroy(); globeLayer = null; }
        hud.remove();
    });

    // ---- 地球にタイル転送 ----------------------------------------------
    function sendToGlobe(meshCode, webpData, bbox) {
        if (!globeLayer) return;
        const buf = webpData.buffer.slice(
            webpData.byteOffset,
            webpData.byteOffset + webpData.byteLength
        );
        globeLayer.set('overlay', buf, { bbox, id: meshCode }, [buf]);
    }

    // ---- 進捗更新 ------------------------------------------------------
    function updateProgress() {
        const fin = done + errors;
        progEl.textContent = total > 0
            ? `${fin} / ${total}  ✓${done}${errors ? `  ✗${errors}` : ''}`
            : '';
        if (total > 0 && fin >= total) {
            statusEl.textContent = `完了: ${done} 件${errors ? ` (${errors} 件エラー)` : ''}`;
            dlBtn.disabled    = false;
            dlBtn.textContent = `ZIP DL (${done}件)`;
        }
    }

    // ---- IDB キャッシュ確認 -------------------------------------------
    let cachedRecords = [];
    if (db) {
        try { cachedRecords = await idbGetAll(db); } catch (e) {}
    }

    if (cachedRecords.length > 0) {
        total = cachedRecords.length;
        statusEl.textContent = `IDBキャッシュ: ${total} 件を地球に表示中...`;
        for (const rec of cachedRecords) {
            webpMap.set(rec.meshCode, { webpData: rec.webpData, bbox: rec.bbox });
            sendToGlobe(rec.meshCode, rec.webpData, rec.bbox);
            done++;
        }
        statusEl.textContent = `IDBキャッシュ: ${done} 件`;
        progEl.textContent   = `${done} / ${total}`;
        dlBtn.disabled       = false;
        dlBtn.textContent    = `ZIP DL (${done}件)`;
        redoBtn.style.display = '';
    } else {
        startConversion();
    }

    // ---- 変換処理 ------------------------------------------------------
    function startConversion() {
        done = 0; errors = 0; total = 0;
        webpMap.clear();
        dlBtn.disabled    = true;
        dlBtn.textContent = 'ZIP DL';
        redoBtn.style.display = 'none';
        statusEl.textContent  = 'NLFTPからファイルリストを取得中...';
        progEl.textContent    = '';

        const workerUrl = new URL('./l03b-r-worker.js', import.meta.url);

        function onTileDone(data) {
            if (!alive) return;
            if (data.error) {
                errors++;
                console.warn(`[L03-b_r] ${data.meshCode}: ${data.error}`);
            } else {
                done++;
                const { meshCode, webpData, bbox } = data;
                webpMap.set(meshCode, { webpData, bbox });
                sendToGlobe(meshCode, webpData, bbox);
                if (db) idbPut(db, { meshCode, webpData, bbox }).catch(() => {});
            }
            updateProgress();
        }

        function startWorker(item, queue) {
            if (!alive || !item) return;
            const { meshCode, url } = item;
            const w = new Worker(workerUrl, { type: 'module' });
            workers.add(w);
            w.postMessage({ meshCode, proxyUrl: nlftp2proxy(url) });
            w.onmessage = ({ data }) => {
                workers.delete(w); w.terminate();
                onTileDone(data);
                startWorker(queue.shift(), queue);
            };
            w.onerror = e => {
                workers.delete(w); w.terminate();
                onTileDone({ meshCode, error: e.message || 'worker error' });
                startWorker(queue.shift(), queue);
            };
        }

        (async () => {
            try {
                const res = await fetch(nlftp2proxy(NLFTP_BASE + PAGE_PATH));
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const html = await res.text();

                const zipRe = /L03-b_r\/[^\s"'<>]+\.zip/g;
                const paths = [...new Set([...html.matchAll(zipRe)].map(m => m[0]))];
                if (!paths.length) throw new Error('ZIPファイルが見つかりませんでした');

                const items = paths.map(path => {
                    const m = path.match(/_(\d{4}(?:_\d+)?)\.zip$/i);
                    return {
                        meshCode: m ? m[1] : path.split('/').pop().replace('.zip', ''),
                        url:      `${NLFTP_BASE}/ksj/gml/data/${path}`,
                    };
                });

                total = items.length;
                statusEl.textContent = `${total} 件を変換中（${CONCURRENCY} ワーカー並列）...`;
                progEl.textContent   = `0 / ${total}`;

                const queue = [...items];
                for (let i = 0; i < CONCURRENCY && queue.length; i++) startWorker(queue.shift(), queue);
            } catch (e) {
                statusEl.textContent = `エラー: ${e.message}`;
            }
        })();
    }

    // ---- ZIP DL --------------------------------------------------------
    dlBtn.addEventListener('click', async () => {
        if (webpMap.size === 0) return;
        dlBtn.disabled    = true;
        dlBtn.textContent = 'ZIP 作成中...';
        try {
            const entries = [...webpMap.entries()]
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([name, { webpData }]) => ({ name: `${name}.webp`, data: webpData }));
            const zipData = buildZip(entries);
            const a = document.createElement('a');
            a.href     = URL.createObjectURL(new Blob([zipData], { type: 'application/zip' }));
            a.download = 'L03-b_r-webp.zip';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(a.href), 30000);
        } finally {
            dlBtn.disabled    = false;
            dlBtn.textContent = `ZIP DL (${done}件)`;
        }
    });

    // ---- 再変換 --------------------------------------------------------
    redoBtn.addEventListener('click', async () => {
        for (const w of workers) w.terminate();
        workers.clear();
        if (db) await idbClear(db).catch(() => {});
        if (globeLayer) globeLayer.set('clear');
        startConversion();
    });
}
