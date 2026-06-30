/**
 * L03-b_r（土地利用細分メッシュ ラスタ版）ビューワー
 *
 * 変換中：オーバーレイ上の 2D キャンバスにタイルをリアルタイムプレビュー
 * 完了後：「地球に描画」「ZIP ダウンロード」ボタンが出現
 * 「地球に描画」：オーバーレイを閉じて地球儀へ転送、X ボタンで復帰
 */
import { API_BASE } from '../ui/config.js';
import { getMapInst, enterGlobeView } from '../ui/globe.js';

const NLFTP_BASE  = 'https://nlftp.mlit.go.jp';
const PAGE_PATH   = '/ksj/gml/datalist/KsjTmplt-L03-b_r.html';
const CONCURRENCY = 4;
const DB_NAME     = 'gishub-jp';
const DB_VERSION  = 1;
const STORE_NAME  = 'L03bR-raster';

const MAP = { west: 122, east: 154, south: 20, north: 47 };

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

// ---- ZIP builder (STORE method) ----------------------------------------

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
    if (document.querySelector('.l03br-overlay')) return;

    // IDB（失敗しても続行）
    let db = null;
    try { db = await openDB(); } catch (e) { console.warn('[L03-b_r] IDB 利用不可:', e); }

    // ---- オーバーレイ UI -----------------------------------------------
    const overlay = document.createElement('div');
    overlay.className = 'l03br-overlay';
    overlay.innerHTML = `
        <div class="l03br-panel">
            <div class="l03br-header">
                <span class="l03br-title">土地利用細分メッシュ（ラスタ版）— プレビュー</span>
                <button class="l03br-close-btn" id="l03br-close">✕</button>
            </div>
            <div class="l03br-status" id="l03br-status">初期化中...</div>
            <canvas class="l03br-canvas" id="l03br-canvas" width="880" height="528"></canvas>
            <div class="l03br-footer">
                <span class="l03br-prog" id="l03br-prog"></span>
                <div class="l03br-btns" id="l03br-btns" style="display:none">
                    <button class="l03br-redo-btn" id="l03br-redo-btn" style="display:none">再変換</button>
                    <button class="l03br-dl-btn"   id="l03br-dl-btn">ZIP ダウンロード</button>
                    <button class="l03br-globe-btn" id="l03br-globe-btn">地球に描画</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const canvas    = document.getElementById('l03br-canvas');
    const mapCtx    = canvas.getContext('2d');
    const statusEl  = document.getElementById('l03br-status');
    const progEl    = document.getElementById('l03br-prog');
    const btnsEl    = document.getElementById('l03br-btns');
    const globeBtn  = document.getElementById('l03br-globe-btn');
    const dlBtn     = document.getElementById('l03br-dl-btn');
    const redoBtn   = document.getElementById('l03br-redo-btn');

    let alive = true;
    const workers = new Set();
    const webpMap = new Map(); // meshCode → { webpData: Uint8Array, bbox: [w,s,e,n] }
    let total = 0, done = 0, errors = 0;

    // ---- キャンバス描画ヘルパー ----------------------------------------
    function geo2px(lon, lat) {
        return [
            (lon - MAP.west)  / (MAP.east  - MAP.west)  * canvas.width,
            (MAP.north - lat) / (MAP.north - MAP.south) * canvas.height,
        ];
    }

    function drawBackground() {
        mapCtx.fillStyle = '#0d1117';
        mapCtx.fillRect(0, 0, canvas.width, canvas.height);
        mapCtx.strokeStyle = 'rgba(255,255,255,0.06)';
        mapCtx.lineWidth   = 0.5;
        for (let lon = 125; lon <= 150; lon += 5) {
            const [x] = geo2px(lon, MAP.north);
            mapCtx.beginPath(); mapCtx.moveTo(x, 0); mapCtx.lineTo(x, canvas.height); mapCtx.stroke();
        }
        for (let lat = 25; lat <= 45; lat += 5) {
            const [, y] = geo2px(MAP.west, lat);
            mapCtx.beginPath(); mapCtx.moveTo(0, y); mapCtx.lineTo(canvas.width, y); mapCtx.stroke();
        }
    }

    function drawTileOnCanvas(webpData, bbox) {
        const blobUrl = URL.createObjectURL(new Blob([webpData], { type: 'image/webp' }));
        const img = new Image();
        img.onload = () => {
            const [x0, y0] = geo2px(bbox[0], bbox[3]);
            const [x1, y1] = geo2px(bbox[2], bbox[1]);
            mapCtx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
            URL.revokeObjectURL(blobUrl);
        };
        img.src = blobUrl;
    }

    function showDoneButtons() {
        progEl.textContent  = '';
        btnsEl.style.display = '';
    }

    function updateProgress() {
        const fin = done + errors;
        progEl.textContent = total > 0
            ? `${fin} / ${total}  ✓${done}${errors ? `  ✗${errors}` : ''}`
            : '';
        if (total > 0 && fin >= total) {
            statusEl.textContent = `完了: ${done} 件変換済み${errors ? ` (${errors} 件エラー)` : ''}`;
            showDoneButtons();
        }
    }

    drawBackground();

    // ---- 閉じる --------------------------------------------------------
    document.getElementById('l03br-close').addEventListener('click', () => {
        alive = false;
        for (const w of workers) w.terminate();
        overlay.remove();
    });

    // ---- IDB キャッシュ確認 -------------------------------------------
    let cachedRecords = [];
    if (db) {
        try { cachedRecords = await idbGetAll(db); } catch (e) {}
    }

    if (cachedRecords.length > 0) {
        total = cachedRecords.length;
        statusEl.textContent = `IDBキャッシュ: ${total} 件`;
        for (const rec of cachedRecords) {
            webpMap.set(rec.meshCode, { webpData: rec.webpData, bbox: rec.bbox });
            drawTileOnCanvas(rec.webpData, rec.bbox);
            done++;
        }
        progEl.textContent = `${done} / ${total}`;
        redoBtn.style.display = '';
        showDoneButtons();
    } else {
        startConversion();
    }

    // ---- 変換処理 ------------------------------------------------------
    function startConversion() {
        done = 0; errors = 0; total = 0;
        webpMap.clear();
        drawBackground();
        btnsEl.style.display  = 'none';
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
                drawTileOnCanvas(webpData, bbox);
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

    // ---- 地球に描画 ----------------------------------------------------
    globeBtn.addEventListener('click', async () => {
        if (webpMap.size === 0) return;
        overlay.remove();
        alive = false;
        for (const w of workers) w.terminate();

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
            return;
        }

        // X ボタン・Escape で exitGlobeView → クリーンアップ
        enterGlobeView(() => {
            if (globeLayer) { globeLayer.destroy(); globeLayer = null; }
        });

        for (const [meshCode, { webpData, bbox }] of webpMap) {
            const buf = webpData.buffer.slice(
                webpData.byteOffset,
                webpData.byteOffset + webpData.byteLength
            );
            globeLayer.set('overlay', buf, { bbox, id: meshCode }, [buf]);
        }
        mapInst.draw();
    });

    // ---- ZIP ダウンロード ----------------------------------------------
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
            dlBtn.textContent = 'ZIP ダウンロード';
        }
    });

    // ---- 再変換 --------------------------------------------------------
    redoBtn.addEventListener('click', async () => {
        for (const w of workers) w.terminate();
        workers.clear();
        if (db) await idbClear(db).catch(() => {});
        startConversion();
    });
}
