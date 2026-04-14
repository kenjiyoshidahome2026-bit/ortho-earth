import './demo.scss';
import { geopbf } from '../src/geopbf.js';

const urlField = document.getElementById('url-field');
const runUrlBtn = document.getElementById('run-url');
const dropZone = document.getElementById('drop-zone');
const filePicker = document.getElementById('file-picker');
const testList = document.getElementById('test-list');

// --- Events ---
runUrlBtn.onclick = () => {
    const url = urlField.value.trim();
    if (url) runTest({ name: url.split('/').pop() || "Remote Data", data: url });
};

dropZone.onclick = () => filePicker.click();
filePicker.onchange = (e) => processFiles(e.target.files);

dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); };
dropZone.ondragleave = () => dropZone.classList.remove('drag-over');
dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    processFiles(e.dataTransfer.files);
};

async function processFiles(files) {
    for (const file of Array.from(files)) {
        await runTest({ name: file.name, data: file });
    }
}

// --- 簡易描画 ---
function drawPreview(canvas, pbf) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.offsetWidth * devicePixelRatio;
    const h = canvas.height = canvas.offsetHeight * devicePixelRatio;
    const limit = Math.min(pbf.length, 1000);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const features = [];
    for (let i = 0; i < limit; i++) {
        const feat = pbf.getFeature(i);
        features.push(feat);
        const coords = feat.geometry.type === 'Point' ? [feat.geometry.coordinates] : feat.geometry.coordinates.flat(Infinity);
        for (let j = 0; j < coords.length; j += 2) {
            const x = coords[j], y = coords[j + 1];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
    }
    const pad = 20;
    const scale = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY));
    const tx = (w - (maxX - minX) * scale) / 2 - minX * scale;
    const ty = (h - (maxY - minY) * scale) / 2 - minY * scale;
    ctx.strokeStyle = '#818cf8'; ctx.lineWidth = 1.5; ctx.beginPath();
    features.forEach(f => {
        const geom = f.geometry;
        if (geom.type === 'LineString' || geom.type === 'Polygon') {
            const pts = geom.type === 'Polygon' ? geom.coordinates[0] : geom.coordinates;
            pts.forEach((p, i) => {
                const px = p[0] * scale + tx, py = h - (p[1] * scale + ty);
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            });
        }
    });
    ctx.stroke();
}

// --- Main Tinker Logic ---
async function runTest(test) {
    const id = Math.random().toString(36).substring(2, 9);
    const card = document.createElement('div');
    card.className = 'test-card';
    card.innerHTML = `
        <div class="card-header">
            <h3>${test.name}</h3>
            <span id="status-${id}" class="status-badge">READY</span>
        </div>
        <div id="stats-${id}" class="stats-bar">Waiting for data...</div>
        <div id="preview-container-${id}" class="preview-container">
            <canvas id="canvas-${id}"></canvas>
        </div>
        <div id="log-${id}" class="log-window"></div>
        <div id="btns-${id}" class="download-btns"></div>
    `;
    testList.prepend(card);

    const logEl = document.getElementById(`log-${id}`);
    const statusEl = document.getElementById(`status-${id}`);
    const statsEl = document.getElementById(`stats-${id}`);
    const btnsEl = document.getElementById(`btns-${id}`);
    const previewContainer = document.getElementById(`preview-container-${id}`);

    const log = (msg) => {
        if (!logEl) return;
        logEl.innerText += `\n> ${msg}`;
        logEl.scrollTop = logEl.scrollHeight;
    };

    try {
        statusEl.innerText = "RUNNING";
        statusEl.className = "status-badge RUNNING";
        log(`Analyzing source stream...`);

        let source = test.data;
        if (source instanceof File) {
            const head = new Uint8Array(await source.slice(0, 2).arrayBuffer());
            if (head[0] === 0x1f && head[1] === 0x8b) {
                const ds = new DecompressionStream("gzip");
                const blob = await new Response(source.stream().pipeThrough(ds)).blob();
                source = new File([blob], source.name.replace(/\.gz$/i, ""), { type: source.type });
                log(`Auto-decompressed.`);
            }
        }

        const pbf = await geopbf(source, { name: test.name, cors: true });

        // 簡易描画
        drawPreview(document.getElementById(`canvas-${id}`), pbf);
        previewContainer.onclick = () => alert("高速描画システムを起動します");

        statsEl.innerHTML = `Features: <b>${pbf.length}</b> | PBF: <b>${(pbf.size / 1024).toFixed(1)} KB</b>`;
        log(pbf.lint);

        // PBFのダウンロードボタン
        const pbfBlob = new Blob([pbf.arrayBuffer], { type: "application/octet-stream" });
        addDownloadButton(btnsEl, new File([pbfBlob], `${test.name}.pbf`), "PBF");

        const formats = [
            { id: 'GeoJSON', fn: () => pbf.geojsonFile() },
            { id: 'Shapefile', fn: () => pbf.shape() },
            { id: 'KMZ', fn: () => pbf.kmz() },
            { id: 'GML', fn: () => pbf.gml() }
        ];

        for (const format of formats) {
            try {
                const file = await format.fn();
                if (file) addDownloadButton(btnsEl, file, format.id);
            } catch (err) { log(`!! ${format.id} Error: ${err.message}`); }
        }

        // --- 「消える仕掛け」の追加 ---
        statusEl.innerText = "DONE ×"; // ×をつけて閉じれることを示唆
        statusEl.className = "status-badge DONE clickable";
        statusEl.title = "Click to dismiss this card";
        statusEl.onclick = () => {
            // アニメーションさせてから削除
            card.style.opacity = '0';
            card.style.transform = 'scale(0.9) translateY(-20px)';
            card.style.transition = 'all 0.3s ease';
            setTimeout(() => card.remove(), 300);
        };
        log(`Completed. Click DONE to dismiss.`);

    } catch (e) {
        log(`!! FATAL: ${e.message}`);
        statusEl.innerText = "FAILED ×";
        statusEl.className = "status-badge ERROR clickable";
        statusEl.onclick = () => card.remove();
    }
}

function addDownloadButton(container, file, label) {
    const btn = document.createElement('button');
    btn.innerText = `↓ ${label}`;
    btn.onclick = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = file.name; a.click();
        URL.revokeObjectURL(a.href);
    };
    container.appendChild(btn);
}