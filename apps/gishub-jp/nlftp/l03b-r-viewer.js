/**
 * L03-b_r（土地利用細分メッシュ ラスタ版）ビューワー
 * NLFTPからTIF ZIPを4ワーカー並列でダウンロード → WebPに変換 →
 * 日本地図キャンバスにリアルタイム描画 + 地球儀に貼り付け → WebP ZIPとしてダウンロード
 */
import { API_BASE } from '../ui/config.js';
import { getMapInst } from '../ui/globe.js';

const NLFTP_BASE  = 'https://nlftp.mlit.go.jp';
const PAGE_PATH   = '/ksj/gml/datalist/KsjTmplt-L03-b_r.html';
const CONCURRENCY = 4;

// 日本地図の表示範囲 (equirectangular)
const MAP = { west: 122, east: 154, south: 20, north: 47 };

function nlftp2proxy(nlftpUrl) {
    return `${API_BASE}/proxy/?url=${encodeURIComponent(nlftpUrl)}`;
}

// ---- ZIP builder (STORE method: WebP は既に圧縮済み) ---------------------------

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
    const crcs  = entries.map((e, i) => crc32(e.data));

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

// ---- メイン -------------------------------------------------------------------

export function openL03bRViewer() {
    // ---- 地球儀レイヤーセットアップ ----------------------------------------
    const mapInst  = getMapInst();
    let globeLayer = null;

    if (mapInst) {
        // 既存の CATALOG レイヤーを保存して後で復元する必要はない（L03-b_r 専用ビューワー）
        mapInst.removeLayer?.('L03bR-Raster'); // 二重起動ガード
        mapInst.createRemoteLayer({ name: 'L03bR-Raster', type: 'image' }).then(layer => {
            globeLayer = layer;
            layer.opacity(0.85);
            // 日本中心にズーム
            mapInst.autoRotate(false);
            mapInst.setView([137, 36], 4);
            mapInst.draw();
            document.getElementById('app')?.classList.add('viewing');
        }).catch(() => { globeLayer = null; });
    }

    // ---- 2D ビューワー UI --------------------------------------------------
    const overlay = document.createElement('div');
    overlay.className = 'l03br-overlay';
    overlay.innerHTML = `
        <div class="l03br-panel">
            <div class="l03br-header">
                <span class="l03br-title">土地利用細分メッシュ（ラスタ版）— WebP ZIP 変換・ダウンロード</span>
                <button class="l03br-close-btn" id="l03br-close">✕</button>
            </div>
            <div class="l03br-status" id="l03br-status">NLFTPからファイルリストを取得中...</div>
            <canvas class="l03br-canvas" id="l03br-canvas" width="880" height="528"></canvas>
            <div class="l03br-footer">
                <span class="l03br-prog" id="l03br-prog"></span>
                <button class="l03br-dl-btn" id="l03br-dl-btn" disabled>WebP ZIP をダウンロード</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const canvas  = document.getElementById('l03br-canvas');
    const mapCtx  = canvas.getContext('2d');
    const statusEl = document.getElementById('l03br-status');
    const progEl   = document.getElementById('l03br-prog');
    const dlBtn    = document.getElementById('l03br-dl-btn');
    let   alive    = true;
    const workers  = new Set();

    function geo2px(lon, lat) {
        return [
            (lon - MAP.west)  / (MAP.east  - MAP.west)  * canvas.width,
            (MAP.north - lat) / (MAP.north - MAP.south) * canvas.height,
        ];
    }

    // 暗い背景 + グリッド
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

    document.getElementById('l03br-close').addEventListener('click', () => {
        alive = false;
        for (const w of workers) w.terminate();
        overlay.remove();
        // 地球儀のラスターレイヤーをクリア
        if (globeLayer) { globeLayer.destroy(); globeLayer = null; }
        mapInst?.draw();
    });

    const webpStore = {}; // meshCode → Uint8Array
    let   total = 0, done = 0, errors = 0;

    const workerUrl = new URL('./l03b-r-worker.js', import.meta.url);

    function onTileDone(data) {
        if (!alive) return;
        if (data.error) {
            errors++;
            console.warn(`[L03-b_r] ${data.meshCode}: ${data.error}`);
        } else {
            done++;
            const { meshCode, webpData, bbox } = data;
            webpStore[meshCode] = webpData;

            if (bbox) {
                // 2D キャンバスに描画
                const blobUrl = URL.createObjectURL(new Blob([webpData], { type: 'image/webp' }));
                const img     = new Image();
                img.onload = () => {
                    const [x0, y0] = geo2px(bbox[0], bbox[3]);
                    const [x1, y1] = geo2px(bbox[2], bbox[1]);
                    mapCtx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
                    URL.revokeObjectURL(blobUrl);
                };
                img.src = blobUrl;

                // 地球儀に貼り付け（ArrayBuffer をゼロコピー転送）
                if (globeLayer) {
                    const buf = webpData.buffer.slice(webpData.byteOffset, webpData.byteOffset + webpData.byteLength);
                    globeLayer.set('overlay', buf, { bbox, id: meshCode }, [buf]);
                    mapInst.draw();
                }
            }
        }
        progEl.textContent = `${done + errors} / ${total}  ✓${done}  ✗${errors}`;
        if (done + errors >= total) {
            statusEl.textContent = `完了: ${done}件変換  ${errors ? '/ ' + errors + '件エラー' : ''}`;
            dlBtn.disabled = false;
            dlBtn.textContent = `WebP ZIP をダウンロード (${done}件)`;
        }
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
            const pageRes = await fetch(nlftp2proxy(NLFTP_BASE + PAGE_PATH));
            if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
            const html = await pageRes.text();

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
            statusEl.textContent = `${total}件のTIFをWebPに変換中（${CONCURRENCY}ワーカー並列）...`;
            progEl.textContent   = `0 / ${total}`;

            const queue = [...items];
            for (let i = 0; i < CONCURRENCY && queue.length; i++) startWorker(queue.shift(), queue);
        } catch (e) {
            statusEl.textContent = `エラー: ${e.message}`;
        }
    })();

    dlBtn.addEventListener('click', async () => {
        dlBtn.disabled  = true;
        dlBtn.textContent = 'ZIP作成中...';
        try {
            const entries = Object.entries(webpStore)
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([name, data]) => ({ name: `${name}.webp`, data }));
            const zipData = buildZip(entries);
            const a       = document.createElement('a');
            a.href        = URL.createObjectURL(new Blob([zipData], { type: 'application/zip' }));
            a.download    = 'L03-b_r-webp.zip';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(a.href), 30000);
        } finally {
            dlBtn.disabled    = false;
            dlBtn.textContent = `WebP ZIP をダウンロード (${done}件)`;
        }
    });
}
