This file is a merged representation of the entire codebase, combined into a single document by Repomix.

# File Summary

## Purpose
This file contains a packed representation of the entire repository's contents.
It is designed to be easily consumable by AI systems for analysis, code review,
or other automated processes.

## File Format
The content is organized as follows:
1. This summary section
2. Repository information
3. Directory structure
4. Repository files (if enabled)
5. Multiple file entries, each consisting of:
  a. A header with the file path (## File: path/to/file)
  b. The full contents of the file in a code block

## Usage Guidelines
- This file should be treated as read-only. Any changes should be made to the
  original repository files, not this packed version.
- When processing this file, use the file path to distinguish
  between different files in the repository.
- Be aware that this file may contain sensitive information. Handle it with
  the same level of security as you would the original repository.

## Notes
- Some files may have been excluded based on .gitignore rules and Repomix's configuration
- Binary files are not included in this packed representation. Please refer to the Repository Structure section for a complete list of file paths, including binary files
- Files matching patterns in .gitignore are excluded
- Files matching default ignore patterns are excluded
- Files are sorted by Git change count (files with more changes are at the bottom)

# Directory Structure
```
demo/
  demo.js
  demo.scss
  index.html
src/
  decoder/
    gml.js
    gpx.js
    json.js
    kmz.js
    shape.js
  encoder/
    fgb.js
    geojson.js
    geopbf.js
    gml.js
    gpx.js
    kmz.js
    shape.js
    topojson.js
  extension/
    contain.js
    dissolve.js
    gint.js
    manipulate.js
    nearPoint.js
    purifier.js
    simplify.js
    spatial.js
    topojson.js
    topology.js
    view.js
  modules/
    bufferTub.js
    topo2geo.js
  index.js
  pbf-base.js
  pbf-io.js
  pbf.js
.gitignore
package.json
pbf spec.md
README.md
reference.md
vite.config.js
```

# Files

## File: demo/demo.js
````javascript
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
````

## File: demo/demo.scss
````scss
:root { --bg: #0b0f1a; --card: #2b344f; --primary: #4f46e5; --ok: #10b981; 
		--err: #ef4444; --txt: #e2e8f0; --brd: #2d3748; }
body { background: var(--bg); color: var(--txt); font-family: sans-serif;
	padding: 2rem 1rem; display: flex; flex-direction: column; align-items: center; }
.container, .control-panel, .test-card { width: 100%; max-width: 800px; }
header { text-align: center; margin-bottom: 2%; 
	h1 span { color: var(--primary); } 
	p { color: #bec7d2; font-style: italic; } 
}
.control-panel { 
	background: var(--card); border: 1px solid var(--brd); border-radius: 16px; padding: 2rem; display: flex; flex-direction: column; gap: 1.5rem; margin-bottom: 3rem; 
	.url-input-group { display: flex; gap: .5rem;
		input { flex: 1; background: var(--bg); border: 1px solid var(--brd); border-radius: 8px; color: #fff; padding: .8rem; } 
	}
}
.drop-zone { 
	border: 2px dashed var(--brd); border-radius: 12px; padding: 2rem; text-align: center; cursor: pointer; transition: .3s;
	&:hover, &.drag-over { border-color: var(--primary); background: rgba(79, 70, 229, .1); }
	p { margin: 0; font-weight: bold; }
	small { color: #64748b; }
}
.test-feed { display: flex; flex-direction: column; gap: 2rem; width: 100%; align-items: center; }
.test-card {
	background: var(--card); border: 1px solid var(--brd); border-radius: 16px; padding: 1.5rem; animation: slide .4s ease-out;
	.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
	.stats-bar { font-size: .85rem; color: #94a3b8; border-bottom: 1px solid var(--brd); padding-bottom: 1rem; margin-bottom: 1rem; b { color: var(--ok); } }
	.log-window { background: #000; color: #818cf8; padding: 1rem; border-radius: 8px; font: .8rem monospace; height: 180px; overflow-y: auto; white-space: pre-wrap; margin-bottom: 1rem; }
	.preview-container { 
		height: 200px; background: #000; border-radius: 8px; margin: 1rem 0; cursor: pointer; border: 1px solid var(--brd); position: relative;
		canvas { width: 100%; height: 100%; }
		&:hover::after { content: '🚀 Launch System'; position: absolute; inset: 0; background: rgba(79, 70, 229, .5);
			display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px); }
	}
}
.download-btns { display: flex; flex-wrap: wrap; gap: .5rem;
	button { background: #1e293b; color: #fff; border: 1px solid var(--brd); padding: .6rem 1rem;
		border-radius: 8px; cursor: pointer; font-size: .75rem; 
		&:hover { background: var(--primary); transform: translateY(-2px); } 
	} 
}
.btn-primary { background: var(--primary); color: #fff; border: none; border-radius: 8px; padding: .8rem 1.5rem; cursor: pointer; font-weight: bold; }
.status-badge { 
  font: 800 .7rem sans-serif; padding: .3rem .7rem; border-radius: 6px; transition: .2s;
  &.RUNNING { background: var(--primary); } &.DONE { background: var(--ok); } &.ERROR { background: var(--err); }
  &.clickable { cursor: pointer; &:hover { transform: scale(1.1); filter: brightness(1.2); } }
}
@keyframes slide { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
````

## File: demo/index.html
````html
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <fabicon></fabicon>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GeoPBF Hub - GIS Tinker Station</title>
</head>
<body>
    <div class="container">
        <header>
            <h1>GeoPBF <span>Hub</span></h1>
            <p>~ new GIS File solution ~</p>
        </header>
        <main class="stream-layout">
            <section class="control-panel">
                <div class="input-section">
                    <label>Remote Resource: [ CORS free / (url name)#(file name) is available for zip. ]</label>
                    <div class="url-input-group">
                        <input type="text" id="url-field" placeholder="https://" />
                        <button id="run-url" class="btn-primary">Fetch & Process</button>
                    </div>
                </div>
                <div class="input-section">
                    <label>Local Files:</label>
                    <div id="drop-zone" class="drop-zone">
                        <div class="dz-content">
                            <span class="icon">🔬</span>
                            <p>Drop <strong>GIS Files</strong> here (or Click here to select your file)</p>
                            <small>GeoJSON/TopoJSON/Shape(zip)/KMZ/KML/GML and GeoPBF (width gzip/zip available)</small>
                        </div>
                        <input type="file" id="file-picker" multiple style="display:none" />
                    </div>
                </div>
                <div>Examples:</div>
                <div><span>https://</span></div>
            </section>
            <div id="test-list" class="test-feed"></div>
        </main>
    </div>
    <script type="module" src="./demo.js"></script>
</body>
</html>
````

## File: src/decoder/gml.js
````javascript
import { GeoPBF } from "../pbf-base.js";
import { decodeZIP } from "native-bucket";

function* getTags(src, tag) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match;
    while ((match = regex.exec(src)) !== null) yield match[1];
}

onmessage = async (e) => {
    const { file, precision } = e.data;
    let gmlStr = "";
    if (file.name.match(/\.zip$/i)) {
        const entries = await decodeZIP(file);
        const gmlFile = entries.find(f => f.name.match(/\.gml$/i));
        if (!gmlFile) return;
        gmlStr = await gmlFile.text();
    } else {
        gmlStr = await file.text();
    }

    const geometryCache = new Map();
    const keySet = new Set(["bbox"]);
    const featureTagMatch = /<([^:>\s]+:[^:>\s]+)\s+gml:id="/.exec(gmlStr);
    const featureTag = featureTagMatch ? featureTagMatch[1] : null;

    const geoRegex = /<(gml:(?:Surface|Curve|Point|MultiCurve|MultiSurface))\s+gml:id="([^"]+)">([\s\S]+?)<\/\1>/gi;
    let gMatch;
    while ((gMatch = geoRegex.exec(gmlStr)) !== null) {
        const id = gMatch[2];
        const posList = /<gml:posList[^>]*>([\s\S]+?)<\/gml:posList>/i.exec(gMatch[3]);
        const pos = /<gml:pos[^>]*>([\s\S]+?)<\/gml:pos>/i.exec(gMatch[3]);
        if (posList) {
            const coords = posList[1].trim().split(/[\s\n\r]+/).map(Number);
            const pts = [];
            for (let i = 0; i < coords.length; i += 2) pts.push([coords[i + 1], coords[i]]);
            geometryCache.set(id, pts);
        } else if (pos) {
            const c = pos[1].trim().split(/[\s\n\r]+/).map(Number);
            geometryCache.set(id, [c[1], c[0]]);
        }
    }

    if (featureTag) {
        for (const pm of getTags(gmlStr, featureTag)) {
            const attrRegex = /<([^:>\s]+:[^:>\s]+)>([^<]+)<\/\1>/gi;
            let aMatch;
            while ((aMatch = attrRegex.exec(pm)) !== null) {
                if (!aMatch[1].match(/(pos|geometry|location|bound)/i)) {
                    keySet.add(aMatch[1].replace(/:/g, '_'));
                }
            }
        }
    }

    const pbf = new GeoPBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision: precision || 7 });
    pbf.setHead(Array.from(keySet).sort());

    pbf.setBody(() => {
        if (!featureTag) return;
        for (const pm of getTags(gmlStr, featureTag)) {
            const props = {};
            const attrRegex = /<([^:>\s]+:[^:>\s]+)>([^<]+)<\/\1>/gi;
            let aMatch;
            while ((aMatch = attrRegex.exec(pm)) !== null) {
                const key = aMatch[1].replace(/:/g, '_');
                if (keySet.has(key)) props[key] = aMatch[2].trim();
            }
            const ref = /xlink:href=["']#([^"']+)["']/.exec(pm);
            if (ref) {
                const coords = geometryCache.get(ref[1]);
                if (coords) {
                    const isPoint = !Array.isArray(coords[0]);
                    pbf.setFeature({
                        type: "Feature", properties: props,
                        geometry: { type: isPoint ? "Point" : "Polygon", coordinates: isPoint ? coords : [coords] }
                    });
                }
            }
        }
    });

    pbf.close();
    const res = pbf.arrayBuffer;
    postMessage({ type: "gmldec", data: res }, [res]);
};
````

## File: src/decoder/gpx.js
````javascript
import { GeoPBF } from "../pbf-base.js"; //

onmessage = async (e) => {
	const { file, precision } = e.data;
	const text = await file.text();
	const pbf = new GeoPBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision: precision || 6 });

	// 1. ヘッダー情報の定義（name, time などの属性を想定）
	pbf.setHead(["name", "time", "ele"]);

	pbf.setBody(() => {
		// 2. trkpt (トラックポイント) の抽出
		const ptRegex = /<trkpt lat="([^"]+)" lon="([^"]+)">([\s\S]*?)<\/trkpt>/gi;
		let match, coords = [];
		while ((match = ptRegex.exec(text)) !== null) {
			coords.push([+match[2], +match[1]]); // [lon, lat]
		}
		if (coords.length > 0) {
			pbf.setFeature({
				type: "Feature",
				geometry: { type: "LineString", coordinates: coords },
				properties: { name: file.name }
			});
		}
	});

	pbf.close();
	const res = pbf.arrayBuffer;
	postMessage({ type: "gpxdec", data: res }, [res]); //
};
````

## File: src/decoder/json.js
````javascript
import { GeoPBF } from "../pbf-base.js";

// ASCIIコードの定数化
const CHAR_QUOTE = 34;    // "
const CHAR_SLASH = 92;    // \
const CHAR_LBRACE = 123;  // {
const CHAR_RBRACE = 125;  // }
const CHAR_LBRACKET = 91; // [

// "features" のASCIIバイト列: [ '"', 'f', 'e', 'a', 't', 'u', 'r', 'e', 's', '"' ]
const FEAT_BYTES = [34, 102, 101, 97, 116, 117, 114, 101, 115, 34];

const getFeaturesFast = (file, callback, isSync = false) => {
    const decoder = new TextDecoder();
    const chunkSize = 2 * 1024 * 1024; // 2MB
    
    const chunks = [];
    let totalBytes = 0;
    
    // ステート管理
    let inFeatures = false;
    let featMatchIdx = 0; // "features" 検索用マッチカウント
    
    let braceCount = 0;
    let inString = false;
    let isEscaped = false;
    
    let scanPos = 0;
    let featureStartPos = -1;

    // ★高速化：現在参照しているチャンク位置をキャッシュ（O(1)でバイトアクセスするため）
    let currentChunkIdx = 0;
    let currentChunkBase = 0;

    const getByteAt = (pos) => {
        // 基本的にポインタは前にしか進まないため、キャッシュ位置から走査を展開
        while (currentChunkIdx < chunks.length) {
            const c = chunks[currentChunkIdx];
            if (pos < currentChunkBase + c.length) {
                return c[pos - currentChunkBase];
            }
            currentChunkBase += c.length;
            currentChunkIdx++;
        }
        // 万が一ポインタが前に戻った場合のセーフティリセット
        currentChunkIdx = 0;
        currentChunkBase = 0;
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            if (pos < currentChunkBase + c.length) {
                currentChunkIdx = i;
                return c[pos - currentChunkBase];
            }
            currentChunkBase += c.length;
        }
        return -1;
    };

    const extractJsonString = (start, end) => {
        const length = end - start;
        let currentOffset = 0;

        // 1. 【高速化ルート】単一チャンク内に完全に収まっているかの判定
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            const cStart = currentOffset;
            const cEnd = currentOffset + c.length;

            // 要求範囲がこのチャンク内に完全に包含されている場合
            if (start >= cStart && end <= cEnd) {
                const localStart = start - cStart;
                const localEnd = end - cStart;
                // subarray はメモリを再確保せず元のバッファのビューを作るため、ゼロコピーで極めて高速
                return decoder.decode(c.subarray(localStart, localEnd));
            }

            currentOffset += c.length;
            // 探索中のオフセットが要求終端を超えたら、単一チャンク包含の可能性はないので抜ける
            if (currentOffset >= end) break;
        }

        // 2. 【安全ルート】複数のチャンクを跨いでいる場合のバッファ結合処理
        const res = new Uint8Array(length);
        currentOffset = 0;
        let resOffset = 0;

        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            const cStart = currentOffset;
            const cEnd = currentOffset + c.length;

            if (start < cEnd && end > cStart) {
                const copyStart = Math.max(0, start - cStart);
                const copyEnd = Math.min(c.length, end - cStart);
                res.set(c.subarray(copyStart, copyEnd), resOffset);
                resOffset += (copyEnd - copyStart);
            }
            currentOffset += c.length;
            if (resOffset >= length) break;
        }

        return decoder.decode(res);
    };

    const pruneChunks = (uptoPos) => {
        while (chunks.length > 0 && uptoPos >= chunks[0].length) {
            const removedLen = chunks[0].length;
            uptoPos -= removedLen;
            scanPos -= removedLen;
            if (featureStartPos !== -1) featureStartPos -= removedLen;
            totalBytes -= removedLen;
            
            // キャッシュ位置のズレも追従させる
            currentChunkBase -= removedLen;
            if (currentChunkIdx > 0) currentChunkIdx--;
            
            chunks.shift(); // 処理済みバッファを完全破棄
        }
    };

    const processBinary = () => {
        // 1. 100%バイナリセーフな "features": [ の検索
        if (!inFeatures) {
            while (scanPos < totalBytes) {
                const b = getByteAt(scanPos);
                
                // '"features"' というバイト列との合致を確認
                if (featMatchIdx < FEAT_BYTES.length) {
                    if (b === FEAT_BYTES[featMatchIdx]) {
                        featMatchIdx++;
                    } else {
                        // 不一致ならリセット（現在のバイトが先頭文字なら1から再開）
                        featMatchIdx = (b === FEAT_BYTES[0]) ? 1 : 0;
                    }
                } 
                // "features" を見つけた後、開始の '[' を探す
                else {
                    if (b === CHAR_LBRACKET) {
                        inFeatures = true;
                        scanPos++; // '[' の直後へポインタを移動
                        pruneChunks(scanPos); // ヘッダー部分をメモリから解放
                        break;
                    }
                }
                scanPos++;
            }
            if (!inFeatures) return; // まだ見つからなければ次のチャンクを待つ
        }

        // 2. 高速バイナリスキャン（マルチバイト完全無視）
        while (scanPos < totalBytes) {
            const b = getByteAt(scanPos);

            if (isEscaped) {
                isEscaped = false;
                scanPos++;
                continue;
            }
            if (b === CHAR_SLASH) {
                isEscaped = true;
                scanPos++;
                continue;
            }

            if (b === CHAR_QUOTE) {
                inString = !inString;
                scanPos++;
                continue;
            }

            if (!inString) {
                if (b === CHAR_LBRACE) {
                    if (braceCount === 0) featureStartPos = scanPos;
                    braceCount++;
                } else if (b === CHAR_RBRACE) {
                    braceCount--;

                    // 1つのFeatureオブジェクトの終わりを検知
                    if (braceCount === 0 && featureStartPos !== -1) {
                        const jsonStr = extractJsonString(featureStartPos, scanPos + 1);
                        try {
                            callback(JSON.parse(jsonStr));
                        } catch (e) {
                            console.warn("Parse Error:", e);
                        }
                        
                        scanPos++;
                        pruneChunks(scanPos); // 抽出完了した部分まで即座にGCへ回す
                        featureStartPos = -1;
                        continue;
                    }
                }
            }
            scanPos++;
        }
    };

    if (isSync) {
        let offset = 0;
        const reader = new FileReaderSync();
        while (offset < file.size) {
            const chunk = new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, offset + chunkSize)));
            chunks.push(chunk);
            totalBytes += chunk.length;
            processBinary();
            offset += chunkSize;
        }
    } else {
        return new Promise(async (resolve) => {
            const stream = file.stream().getReader();
            while (true) {
                const { done, value } = await stream.read();
                if (done) break;
                chunks.push(value);
                totalBytes += value.length;
                processBinary();
            }
            resolve();
        });
    }
};
onmessage = async (e) => {
    const { file, precision } = e.data;
    const threshold = 50 * 1024 * 1024;
    if (file.size < threshold) {
        const json = JSON.parse(await file.text());
        const pbf = new GeoPBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision });
        await pbf.set(json);
        const res = pbf.arrayBuffer;
        postMessage({ type: "jsondec", data: res }, [res]);
    } else {
        const keySet = new Set();
        await getFeaturesFast(file, f => { //console.log("Feature:", f);
            if (f.properties) {
                for (const k in f.properties) {
                    keySet.add(k);
                    const v = f.properties[k];
                    if (v && typeof v === 'object' && !Array.isArray(v)) {
                        for (const sk in v) keySet.add(`${k}.${sk}`);
                    }
                }
            }
        }, false);
        const pbf = new GeoPBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision });
        pbf.setHead(Array.from(keySet).sort());
        pbf.setBody(() => {
            getFeaturesFast(file, f => pbf.setFeature(f), true);
        });
        pbf.close();
        const res = pbf.arrayBuffer;
        postMessage({ type: "jsondec", data: res }, [res]);
    }
};
````

## File: src/decoder/kmz.js
````javascript
import { GeoPBF } from "../pbf-base.js";
import { decodeZIP } from "native-bucket";

const parseCoords = (s) => s.trim().split(/\s+/).map(t => t.split(",").map(Number).slice(0, 2));

const kmlToFeatures = (text, nameToRes) => {
    const features = [];
    const placemarks = text.match(/<Placemark[\s\S]*?<\/Placemark>/g) || [];
    placemarks.forEach(pm => {
        const props = {};
        const nm = pm.match(/<name>(.*?)<\/name>/);
        if (nm) props.name = nm[1].trim();
        const ds = pm.match(/<description>(.*?)<\/description>/);
        if (ds) props.description = ds[1].trim();
        const sd = pm.match(/<SimpleData name="(.*?)">(.*?)<\/SimpleData>/g);
        if (sd) sd.forEach(t => {
            const m = t.match(/<SimpleData name="(.*?)">(.*?)<\/SimpleData>/);
            if (m) props[m[1]] = m[2];
        });
        const hr = pm.match(/<href>(.*?)<\/href>/);
        if (hr) {
            const path = hr[1].trim();
            if (nameToRes[path]) props.icon = nameToRes[path];
        }
        let geometry = null;
        if (pm.includes("<Point>")) {
            const c = pm.match(/<coordinates>(.*?)<\/coordinates>/);
            if (c) geometry = { type: "Point", coordinates: parseCoords(c[1])[0] };
        } else if (pm.includes("<LineString>")) {
            const c = pm.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
            if (c) geometry = { type: "LineString", coordinates: parseCoords(c[1]) };
        } else if (pm.includes("<Polygon>")) {
            const c = pm.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
            if (c) geometry = { type: "Polygon", coordinates: [parseCoords(c[1])] };
        }
        if (geometry) features.push({ type: "Feature", geometry, properties: props });
    });
    return features;
};

onmessage = async (e) => {
    const { file, precision } = e.data;
    const entries = await decodeZIP(file);
    if (!entries) return;
    const nameToRes = {};
    entries.forEach(f => {
        if (!f.name.endsWith(".kml")) nameToRes[f.name] = f;
    });
    const kmlEntries = entries.filter(t => t.name.endsWith(".kml"));
    const allFeatures = [];
    for (const entry of kmlEntries) {
        const text = await entry.text();
        allFeatures.push(...kmlToFeatures(text, nameToRes));
    }
    const [keys, bufs] = await GeoPBF.makeKeys(allFeatures.map(f => f.properties));
    const pbf = new GeoPBF({ name: file.name.replace(/\.kmz$/, ""), precision });
    pbf.setHead(keys, bufs);
    pbf.setBody(() => {
        allFeatures.forEach(f => pbf.setFeature(f));
    });
    pbf.close();
    const res = pbf.arrayBuffer;
    postMessage({ type: "kmzdec", data: res }, [res]);
};
````

## File: src/decoder/shape.js
````javascript
import { GeoPBF } from "../pbf-base.js";
import { decodeZIP } from "native-bucket";

const view = a => new DataView(a.buffer, a.byteOffset, a.byteLength);
const thenMap = async (a, f) => {
	const r = [];
	for (let i = 0; i < a.length; i++) r.push(await f(a[i], i).catch(console.error));
	return r;
};
const getbbox = r => {
	let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
	r.forEach(p => {
		if (p[0] < xmin) xmin = p[0]; if (p[0] > xmax) xmax = p[0];
		if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1];
	});
	return [xmin, ymin, xmax, ymax];
};
const includes = (b, pt) => !(b[0] > pt[0] || b[2] < pt[0] || b[1] > pt[1] || b[3] < pt[1]);
const contains = (ring, pt) => {
	let [x, y] = pt, inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		let xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
		if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
	}
	return inside;
};
class DBF {
	constructor(s, enc) {
		const h = view(s.subarray(0, 32)), l = h.getUint16(8, true);
		const b = view(s.subarray(32, l));
		this.source = s.subarray(l); this.len = h.getUint16(10, true);
		this.dec = new TextDecoder(enc); this.fields = [];
		for (let n = 0; b.getUint8(n) !== 0x0d; n += 32) {
			let j = 0; while (j < 11 && b.getUint8(n + j) !== 0) j++;
			this.fields.push({
				name: this.dec.decode(new Uint8Array(b.buffer, b.byteOffset + n, j)).trim(),
				type: String.fromCharCode(b.getUint8(n + 11)),
				length: b.getUint8(n + 16)
			});
		}
	}
	read() {
		const value = this.source.subarray(0, this.len); this.source = this.source.subarray(this.len);
		if (!value || value[0] === 0x1a) return null;
		const q = {}, parse = {
			B: v => +v.trim(), F: v => +v.trim(), N: v => +v.trim(),
			L: v => /^[yt]$/i.test(v), D: v => new Date(v.replace(/(....)(..)(..)/, "$1-$2-$3")),
			C: v => { v = v.trim().replace(/\x00/g, ""); return v.length ? v : null; }
		};
		let i = 1;
		this.fields.forEach(f => {
			const raw = this.dec.decode(value.subarray(i, i += f.length));
			const v = (parse[f.type] || parse.C)(raw);
			if (v !== null) q[f.name] = v;
		});
		return q;
	}
}
const Point = q => ({ type: "Point", coordinates: [q.getFloat64(4, true), q.getFloat64(12, true)] });
const PolyLine = q => {
	let p = 44, n = q.getInt32(36, true), m = q.getInt32(40, true);
	const parts = [], pts = [];
	for (let i = 0; i < n; i++, p += 4) parts.push(q.getInt32(p, true));
	for (let i = 0; i < m; i++, p += 16) pts.push([q.getFloat64(p, true), q.getFloat64(p + 8, true)]);
	const lines = parts.map((st, i) => pts.slice(st, parts[i + 1]));
	return n === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines };
};
const Polygon = q => {
	let p = 44, n = q.getInt32(36, true), m = q.getInt32(40, true);
	const parts = [], pts = [], polys = [], holes = [];
	for (let i = 0; i < n; i++, p += 4) parts.push(q.getInt32(p, true));
	for (let i = 0; i < m; i++, p += 16) pts.push([q.getFloat64(p, true), q.getFloat64(p + 8, true)]);
	parts.forEach((st, i) => {
		const ring = pts.slice(st, parts[i + 1]);
		let s = 0;
		for (let j = 0, l = ring.length; j < l; j++) {
			const a = ring[j], b = ring[(j + 1) % l];
			s += (b[0] - a[0]) * (b[1] + a[1]);
		}
		s >= 0 ? polys.push([ring]) : holes.push(ring);
	});

	const bboxes = polys.map(t => getbbox(t[0]));
	holes.forEach(hole => {
		const pt = hole[0];
		const idx = polys.findIndex((_, i) => includes(bboxes[i], pt) && contains(polys[i][0], pt));
		if (idx !== -1) polys[idx].push(hole);
	});
	return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
};
class SHP {
	constructor(s) {
		const h = view(s.subarray(0, 100));
		this.type = h.getInt32(32, true); this.source = s.subarray(100);
		this.parse = { 1: Point, 3: PolyLine, 5: Polygon, 8: Point, 11: Point, 13: PolyLine, 15: Polygon }[this.type];
	}
	read() {
		if (!this.source.byteLength) return null;
		const len = view(this.source.subarray(4, 8)).getInt32(0, false) * 2;
		const type = view(this.source.subarray(8, 12)).getInt32(0, true);
		const s = this.source.subarray(8, 8 + len); this.source = this.source.subarray(8 + len);
		return type === this.type ? this.parse(view(s)) : this.read();
	}
}
onmessage = async (e) => {
	const { file, encoding, precision } = e.data, name = file.name;
	const entries = await decodeZIP(file);
	const keySet = new Set();
	const shpFiles = entries.filter(t => t.name.match(/\.shp$/i));
	const dbs = await Promise.all(shpFiles.map(async f => {
		const base = f.name.replace(/\.shp$/i, "");
		const dbfFile = entries.find(t => t.name === base + ".dbf");
		const cpgFile = entries.find(t => t.name === base + ".cpg");
		if (!dbfFile) return null;
		const shpBuf = new Uint8Array(await f.arrayBuffer());
		const dbfBuf = new Uint8Array(await dbfFile.arrayBuffer());
		const enc = (cpgFile ? await cpgFile.text() : (dbfBuf[29] === 0x13 ? 'sjis' : encoding)).trim();
		const dbf = new DBF(dbfBuf, enc);
		dbf.fields.forEach(field => keySet.add(field.name)); // プロパティ名を全収集
		return [new SHP(shpBuf), dbf];
	}));
	const pbf = new GeoPBF({ name, precision });
	pbf.setHead(Array.from(keySet).sort());
	pbf.setBody(() => {
		dbs.filter(t => t).forEach(([shp, dbf]) => {
			while (1) {
				const s = shp.read(), d = dbf.read();
				if (!s || !d) break;
				pbf.setFeature({ type: "Feature", geometry: s, properties: d });
			}
		});
	});
	pbf.close();
	const res = pbf.arrayBuffer;
	postMessage({ type: "shpdec", data: res }, [res]);
};
````

## File: src/encoder/fgb.js
````javascript
import { GeoPBF } from "../pbf-base.js";

// FlatGeobuf 識別用マジックバイト [V3]
const MAGIC = new Uint8Array([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00]);
const GeometryType = { Unknown: 0, Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6 };
const ColumnType = {
	Bool: 0,     // 修正：スペックでは 0 です
	Int: 5,      // OK
	Double: 10,  // OK
	String: 11,  // OK
	Json: 12,    // 補強：geopbf のリッチな属性を活かすならこれ！
	DateTime: 14 // 補強：GPX の time タグを活かすならこれ！
};
onmessage = async (e) => {
	const { buf, name, gz } = e.data;
	try {
		// 解析済みの GeoPBF インスタンスを再現
		const pbf = await new GeoPBF().name(name).set(buf);
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();

		const out = gz ? readable.pipeThrough(new CompressionStream("gzip")) : readable;
		const bPromise = new Response(out).blob();

		(async () => {
			// 1. マジックバイトの書き込み
			await writer.write(MAGIC);

			// 2. Header の書き出し
			// Topology解析済みなので、pbf.bbox や pbf.length が正確に取得できる
			const header = buildFGBHeader(pbf);
			await writer.write(header);

			// 3. Features の書き出し (ストリーミング)
			for (let i = 0, len = pbf.length; i < len; i++) {
				const f = pbf.getFeature(i);
				// 浄化済みの座標データを FGB Feature バイナリへ変換
				const featureBin = encodeFGBFeature(f, pbf._precision);
				await writer.write(featureBin);
			}

			await writer.close();
		})();

		const b = await bPromise;
		postMessage(new File([b], `${name}.fgb${gz ? ".gz" : ""}`, {
			type: gz ? "application/gzip" : "application/octet-stream"
		}));
	} catch (err) {
		postMessage(null);
	}
};

function buildFGBHeader(pbf) {
	const keys = pbf._head; // プロパティのキー配列
	const bbox = pbf.bbox; // [minX, minY, maxX, maxY]

	// 簡略化したFlatBuffer構築ロジック
	// 本来はFlatBufferの公式ライブラリを使うが、構造が固定的なので手動で組める
	const builder = new FlatBufferBuilder();

	// Columnsの定義
	const columnOffsets = keys.map(key => {
		const nameOff = builder.createString(key);
		builder.startObject(2);
		builder.addFieldOffset(0, nameOff);
		builder.addFieldInt8(1, ColumnType.String); // 全てStringとして扱う例
		return builder.endObject();
	});
	const columnsOff = builder.createVector(columnOffsets);

	// Headerの構築
	builder.startObject(11);
	builder.addFieldStruct(2, bbox); // Envelope
	builder.addFieldInt8(3, GeometryType.Unknown); // 混合型を許容
	builder.addFieldNumber(8, pbf.length); // features_count
	builder.addFieldOffset(7, columnsOff);
	builder.addFieldInt16(9, 0); // index_node_size (0 = インデックスなし)

	const headerOff = builder.endObject();
	builder.finish(headerOff);

	return builder.asUint8Array();
}
function encodeFGBFeature(f, keys) {
	const builder = new FlatBufferBuilder();

	// 1. プロパティのエンコード
	const propBytes = [];
	keys.forEach((key, index) => {
		const val = f.properties[key];
		if (val !== undefined && val !== null) {
			// [ushort keyIndex] + [string value] の形式
			const buf = new TextEncoder().encode(String(val));
			const view = new DataView(new ArrayBuffer(2 + 4 + buf.byteLength));
			view.setUint16(0, index, true);
			view.setUint32(2, buf.byteLength, true);
			propBytes.push(new Uint8Array(view.buffer));
			propBytes.push(buf);
		}
	});
	const propsOff = builder.createByteVector(concatUint8(propBytes));

	// 2. ジオメトリのエンコード
	const coords = flattenCoordinates(f.geometry);
	const coordsOff = builder.createDoubleVector(coords);

	// Geometryオブジェクト
	builder.startObject(4);
	builder.addFieldOffset(0, coordsOff);
	if (f.geometry.type === "Polygon") {
		const ends = [f.geometry.coordinates[0].length * 2]; // 簡易的なリング終端処理
		builder.addFieldOffset(1, builder.createUIntVector(ends));
	}
	const geomOff = builder.endObject();

	// Featureオブジェクト
	builder.startObject(3);
	builder.addFieldOffset(0, geomOff);
	builder.addFieldOffset(1, propsOff);

	const featureOff = builder.endObject();
	builder.finish(featureOff);

	return builder.asUint8ArrayWithLengthPrefix(); // 先頭4バイトにサイズを付与
}

function flattenCoordinates(geometry) {
	const pts = [];
	const walk = coords => {
		if (typeof coords[0] === 'number') pts.push(...coords);
		else coords.forEach(walk);
	};
	walk(geometry.coordinates);
	return new Float64Array(pts);
}

const concatUint8 = arrays => {
	const total = arrays.reduce((acc, a) => acc + a.byteLength, 0);
	const res = new Uint8Array(total);
	let off = 0;
	arrays.forEach(a => { res.set(a, off); off += a.byteLength; });
	return res;
};

// 簡易版 FlatBuffer ビルダー（スペックに準拠したバイナリ生成用）
class FlatBufferBuilder {
	// ...ここにバイナリ構築ロジックが必要...
}
````

## File: src/encoder/geojson.js
````javascript
import { GeoPBF } from "../pbf-base.js";
const enc = new TextEncoder();

onmessage = async (e) => {
    const { buf, name, gz } = e.data;
    try {
        const pbf = await new GeoPBF().name(name).set(buf);
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const out = gz ? readable.pipeThrough(new CompressionStream("gzip")) : readable;
        const promise = new Response(out).blob();

        (async () => {
            await writer.write(enc.encode('{"type":"FeatureCollection","features":[\n'));
            for (let i = 0, len = pbf.length; i < len; i++) {
                const f = pbf.getFeature(i);
                let s = JSON.stringify({ type: "Feature", geometry: f.geometry, properties: f.properties });
                if (i < len - 1) s += ",\n";
                await writer.write(enc.encode(s));
            }
            await writer.write(enc.encode('\n]}'));
            await writer.close();
        })();

        const b = await promise;
        postMessage(new File([b], `${name}.geojson${gz ? ".gz" : ""}`, { type: gz ? "application/gzip" : "application/geo+json" }));
    } catch (err) { postMessage(null); }
};
````

## File: src/encoder/geopbf.js
````javascript
onmessage = async (e) => {
    const { buf, name, gz } = e.data;
    try {
        let blob = new Blob([buf]);
        if (gz !== false) blob = await (new Response(blob.stream().pipeThrough(new CompressionStream("gzip")))).blob();
        postMessage(new File([blob], `${name}.geopbf`, { type: "application/x-geopbf" }));
    } catch (err) { postMessage(null); }
};
````

## File: src/encoder/gml.js
````javascript
import { GeoPBF } from "../pbf-base.js";
import { encodeZIP } from "native-bucket";

onmessage = async (e) => {
    const { buf, name, gz } = e.data; // gzフラグをZIP/GZIPの切り替えに流用
    try {
        const pbf = await new GeoPBF().name(name).set(buf);
        const pos = c => `${c[1]} ${c[0]}`;
        const posList = r => r.map(pos).join(" ");

        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gml:FeatureCollection xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n`;

        for (let i = 0, len = pbf.length; i < len; i++) {
            const f = pbf.getFeature(i);
            const { type, coordinates: c } = f.geometry;
            const fid = f.id || `f${i}`;

            xml += `  <gml:featureMember>\n    <gml:GenericFeature gml:id="${fid}">\n      <gml:geometryProperty>\n`;
            if (type === "Point") {
                xml += `        <gml:Point gml:id="p${i}"><gml:pos>${pos(c)}</gml:pos></gml:Point>\n`;
            } else if (type === "LineString") {
                xml += `        <gml:LineString gml:id="l${i}"><gml:posList>${posList(c)}</gml:posList></gml:LineString>\n`;
            } else if (type === "Polygon") {
                xml += `        <gml:Polygon gml:id="s${i}">\n`;
                c.forEach((ring, j) => {
                    const tag = j === 0 ? "exterior" : "interior";
                    xml += `          <gml:${tag}><gml:LinearRing><gml:posList>${posList(ring)}</gml:posList></gml:LinearRing></gml:${tag}>\n`;
                });
                xml += `        </gml:Polygon>\n`;
            }
            xml += `      </gml:geometryProperty>\n`;

            for (const [k, v] of Object.entries(f.properties)) {
                if (v !== null && typeof v !== 'object' && k !== "id") {
                    const sk = k.replace(/[^a-zA-Z0-9_]/g, '_');
                    xml += `      <${sk}>${v}</${sk}>\n`;
                }
            }
            xml += `    </gml:GenericFeature>\n  </gml:featureMember>\n`;
        }
        xml += `</gml:FeatureCollection>`;

        const gmlFile = new File([xml], `${name}.gml`, { type: "application/gml+xml" });

        // gzフラグが立っていればZIP圧縮、そうでなければ生のGML
        if (gz) {
            const zip = await encodeZIP([gmlFile], `${name}_gml.zip`);
            postMessage(zip);
        } else {
            postMessage(gmlFile);
        }
    } catch (err) { postMessage(null); }
};
````

## File: src/encoder/gpx.js
````javascript
import { GeoPBF } from "../pbf-base.js"; //
const enc = new TextEncoder();

onmessage = async (e) => {
	const { buf, name, gz } = e.data;
	try {
		const pbf = await new GeoPBF().name(name).set(buf);
		const { readable, writable } = new TransformStream(); //
		const writer = writable.getWriter();
		const out = gz ? readable.pipeThrough(new CompressionStream("gzip")) : readable;
		const bPromise = new Response(out).blob();

		(async () => {
			await writer.write(enc.encode('<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="WhiteEarth">\n<trk><trkseg>\n'));

			for (let i = 0, len = pbf.length; i < len; i++) {
				const f = pbf.getFeature(i);
				if (f.geometry.type === "LineString") {
					for (const [lon, lat] of f.geometry.coordinates) {
						await writer.write(enc.encode(`<trkpt lat="${lat}" lon="${lon}" />\n`));
					}
				}
			}

			await writer.write(enc.encode('</trkseg></trk>\n</gpx>'));
			await writer.close();
		})();

		const b = await bPromise;
		postMessage(new File([b], `${name}.gpx${gz ? ".gz" : ""}`, { type: "application/gpx+xml" })); //
	} catch (err) { postMessage(null); }
};
````

## File: src/encoder/kmz.js
````javascript
import { GeoPBF } from "../pbf-base.js";
import { encodeZIP } from "native-bucket";

// Webカラー(#RRGGBB) または [r,g,b,a] を KML形式(aabbggrr)に変換
const toKMLColor = (c, opacity = 1) => {
    const a = Math.round(opacity * 255).toString(16).padStart(2, '0');
    if (Array.isArray(c)) { // [r, g, b]
        return a + c[2].toString(16).padStart(2, '0') + c[1].toString(16).padStart(2, '0') + c[0].toString(16).padStart(2, '0');
    }
    const hex = c.replace('#', ''); // ff0000 (Red)
    const r = hex.substring(0, 2), g = hex.substring(2, 4), b = hex.substring(4, 6);
    return a + b + g + r;
};

onmessage = async (e) => {
    const { buf, name, gz } = e.data;
    try {
        const pbf = await new GeoPBF().name(name).set(buf);
        const embeddedFiles = []; // ZIPに同梱するファイルのリスト

        let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n`;

        // 共有スタイルの定義（メモリ節約のためスタイルはまとめる）
        kml += `  <Style id="defaultStyle">\n    <LineStyle><color>ff0000ff</color><width>2</width></LineStyle>\n    <PolyStyle><color>400000ff</color></PolyStyle>\n  </Style>\n`;

        for (let i = 0, len = pbf.length; i < len; i++) {
            const f = pbf.getFeature(i);
            const { type, coordinates: c } = f.geometry;
            const { color, fillOpacity, iconData, iconName } = f.properties;

            kml += `  <Placemark>\n    <name>${f.id || i}</name>\n`;

            // --- カラーハンドリング ---
            if (color) {
                const kmlColor = toKMLColor(color, fillOpacity || 1);
                kml += `    <Style><LineStyle><color>${kmlColor}</color></LineStyle><PolyStyle><color>${kmlColor}</color></PolyStyle></Style>\n`;
            } else {
                kml += `    <styleUrl>#defaultStyle</styleUrl>\n`;
            }

            // --- ファイルの埋め込み (アイコン等) ---
            if (iconData && iconName) {
                const iconPath = `files/${iconName}`;
                kml += `    <Style><IconStyle><Icon><href>${iconPath}</href></Icon></IconStyle></Style>\n`;
                // iconDataがBlobやArrayBufferなら、後でZIPに詰めるために保持
                embeddedFiles.push(new File([iconData], iconPath));
            }

            kml += `    <ExtendedData>\n`;
            for (const [k, v] of Object.entries(f.properties)) {
                if (v !== null && typeof v !== 'object' && !['iconData', 'iconName'].includes(k)) {
                    kml += `      <Data name="${k}"><value>${v}</value></Data>\n`;
                }
            }
            kml += `    </ExtendedData>\n`;

            // ジオメトリ（経度,緯度,0）
            const pos = pt => `${pt[0]},${pt[1]},0`;
            const posList = r => r.map(pos).join(" ");
            if (type === "Point") kml += `    <Point><coordinates>${pos(c)}</coordinates></Point>\n`;
            else if (type === "LineString") kml += `    <LineString><coordinates>${posList(c)}</coordinates></LineString>\n`;
            else if (type === "Polygon") {
                kml += `    <Polygon>\n`;
                c.forEach((r, j) => {
                    const t = j === 0 ? "outerBoundaryIs" : "innerBoundaryIs";
                    kml += `      <${t}><LinearRing><coordinates>${posList(r)}</coordinates></LinearRing></${t}>\n`;
                });
                kml += `    </Polygon>\n`;
            }
            kml += `  </Placemark>\n`;
        }
        kml += `</Document>\n</kml>`;

        const kmlFile = new File([kml], `doc.kml`, { type: "application/vnd.google-earth.kml+xml" });

        if (gz) {
            // KMZとしてパッケージング。doc.kml と files/ を同梱
            const zip = await encodeZIP([kmlFile, ...embeddedFiles], `${name}.kmz`);
            postMessage(zip);
        } else {
            postMessage(kmlFile);
        }
    } catch (err) { postMessage(null); }
};
````

## File: src/encoder/shape.js
````javascript
import {GeoPBF} from "../pbf-base.js";
import {encodeZIP} from "native-bucket";
const getEncoder = async (encoding) => {
    if (encoding === "sjis") {
        const Encoding = (await import('https://esm.sh/encoding-japanese@2.1.0')).default;
        return str => new Uint8Array(Encoding.convert(str, {from: 'UNICODE', to: 'SJIS', type: 'array' }));
    }
    const utf8Encoder = new TextEncoder();
    return str => utf8Encoder.encode(str);
};
const sum = a => { let s = 0; a.forEach(t=>s+=t); return s; };
class WBUF {
    constructor(len) {
        this.buff = new ArrayBuffer(len); this.pos = 0;
        this.bytes = new Uint8Array(this.buff);
        this.view = new DataView(this.buff);
    }
    buffer() { return this.buff; }
    position(i) { if (i != null) { this.pos = i; return this; } return this.pos; }
    skip(bytes) { this.pos += (bytes + 0); return this; }
    writeUint8(val) { this.bytes[this.pos++] = val; return this; }
    writeInt8(val) { this.view.setInt8(this.pos++, val); return this; }
    writeUint16(val, le) { this.view.setUint16(this.pos, val, le); this.pos += 2; return this; }
    writeInt16(val, le) { this.view.setInt16(this.pos, val, le); this.pos += 2; return this; }
    writeUint32(val, le) { this.view.setUint32(this.pos, val, le); this.pos += 4; return this; }
    writeInt32(val, le) { this.view.setInt32(this.pos, val, le); this.pos += 4; return this; }
    writeFloat64(val, le) { this.view.setFloat64(this.pos, val, le); this.pos += 8; return this; }
    writeBuffer(buf, bytes, spos = 0) {
        const src = new Uint8Array(buf);
        const len = Math.min(bytes || src.byteLength - spos, this.bytes.byteLength - this.pos);
        this.bytes.set(src.subarray(spos, spos + len), this.pos);
        this.pos += len;
        return this;
    }
}
////=======================================================================================================================
function writeShp(pbf, name, farray, type) {
    var bbox = pbf.bbox;
    var shxBytes = 100 + farray.length * 8;
    var SHX = new WBUF(shxBytes).position(100); // jump to record section
    var fileBytes = 100;
    var id = 1;
    var func = type == 1? point: type == 8? multipoint :poly;
    var shapeBuffers = farray.map(n=> {
        const geom = Array.isArray(n)? pbf.getGeometry(...n): pbf.getGeometry(n);
        const bb = pbf.getBbox(Array.isArray(n)? n[0]: n);
        var rec = func(geom, bb).buffer();
        var recBytes = rec.byteLength;
        SHX.writeInt32(fileBytes / 2).writeInt32(recBytes / 2 - 4);
        fileBytes += recBytes;
        return rec;
    });
    var SHP = new WBUF(fileBytes)
    .writeInt32(9994).skip(5 * 4).writeInt32(fileBytes / 2)
    .writeInt32(1000, true).writeInt32(type, true);
    bbox? bbox.forEach(t=>SHP.writeFloat64(t, true)):SHP.skip(4 * 8);
    SHP.skip(4 * 8); // skip Z & M type bbox;
    shapeBuffers.forEach(t=>SHP.writeBuffer(t));
    SHX.position(0).writeBuffer(SHP.buffer(), 100).position(24).writeInt32(shxBytes/2);
    return [new File([SHP.buffer()], name + '.shp', {type:"application/octet-stream"}),
            new File([SHX.buffer()], name + '.shx', {type:"application/octet-stream"})];
    function point(g) { const c = g.coordinates;
        return new WBUF(28)
        .writeInt32(id++).writeInt32(10)
        .writeInt32(type,true)
        .writeFloat64(c[0],true).writeFloat64(c[1],true);
    }
    function multipoint(g, bbox) { const c = g.coordinates;
        const bin = new WBUF(48 + c.length*16)
        .writeInt32(id++).writeInt32(20 + c.length*8)
        .writeInt32(type, true)
        .writeFloat64(bbox[0],true).writeFloat64(bbox[1],true).writeFloat64(bbox[2],true).writeFloat64(bbox[3],true)
        .writeInt32(c.length, true);
        c.forEach(t=>bin.writeFloat64(t[0],true).writeFloat64(t[1],true));
        return bin;
    }
    function poly(g, bbox) { 
        const p0 = c => [c], p1 = c => c, p2 = c => c.flat();
        const coords = (g.type.match(/Polygon/)? g.type.match(/Multi/)? p2:p1:g.type.match(/Multi/)? p1:p0)(g.coordinates);
        const lengths = coords.map(t=>t.length);
        const coordsCount = sum(lengths);
        const pathCount = lengths.length;
        const pos = []; let i = 0; lengths.forEach(t=>{pos.push(i); i += t});
        const bin = new WBUF(52 + 4 * pathCount + 16 * coordsCount)
        .writeInt32(id++).writeInt32(22 + 2 * pathCount + 8 * coordsCount)
        .writeInt32(type, true)
        .writeFloat64(bbox[0], true).writeFloat64(bbox[1], true).writeFloat64(bbox[2], true).writeFloat64(bbox[3], true)
        .writeInt32(pathCount, true).writeInt32(coordsCount, true);
            pos.forEach(t=>bin.writeInt32(t, true));
            coords.forEach(t=>t.forEach(u=>u&&bin.writeFloat64(u[0], true).writeFloat64(u[1], true)));
            return bin;
    }
}
////--------------------------------------------------------------------------------------------------------------------------	
function writeDbf(pbf, name, farray, encoding, encoder) {
    const parray = farray.map(t=>Array.isArray(t)?t[0]:t), recordSize = farray.length;
    const props = parray.map(i=>pbf.getProperties(i));
     const stringify = q => {
        return "{"+Object.entries(q).map(([k,v])=>`"${k}":${JSON.stringify(v instanceof ImageData?{}:v)}`).join(",")+"}";
    }
    const strlen = s => encoder(typeof s == "object"?stringify(s):String(s)).length;
    const schema = {};
    props.forEach(q=>{
        const update = (q,v) => { const p = schema[q.name];
            if (!p) return (schema[q.name] = q);
            if (p.type == q.type) {
                if (p.type == "C"||p.type == "N") p.length = Math.max(p.length, q.length);
                if (p.type == "N") p.precision = Math.max(p.precision, q.precision);
            } else {
                p.type = "C"; p.length = Math.max(p.length, strlen(v));
            }
        };
        const numberProp = num => {
            num = num.toString(); if (num.match(/e/)) num = "0";
            num = num.split('.');
            return [num[0].length, (num[1] || '').length];
        };
        for (let name in q) {  const value = q[name];
            if (value instanceof ImageData||value instanceof Blob) {
                update({name, type: 'C', length:2}, "{}");
            } else if (value instanceof Date) {
                update({name, type: 'D', length:8}, value);
            } else if (typeof value === 'number') {
                const [length, precision] = numberProp(value)
                update({name, type: 'N', length, precision}, value);
            } else if (typeof value === 'boolean') {
                update({name, type: 'L', length:1}, value);
            } else { 
                update({name, type: 'C', length:strlen(value)}, value);
            }
        }
    });
    const fields = Object.values(schema).sort((p,q)=>p.name>q.name?1:-1);
    const fieldCount = fields.length;		
    fields.forEach(field=>{ field.precision = field.precision || 0;
        if (field.type == "N" && field.precision) field.length += (field.precision + 1);
        if (strlen(field.name) > 11) console.warn("too long field name:", field.name);
        if (field.length > 254) { console.warn("too long data in:", field.name); field.length = 254; }
    });
    const [Y,M,D] = (() => { var t = new Date(); return [t.getFullYear(), t.getMonth() + 1, t.getDate()]; })();
    const headerBytes = 32 + fields.length * 32 +1;
    const recordBytes = sum(fields.map(t=>t.length))+1;
    const fileBytes = headerBytes + recordSize * recordBytes + 1;
 //   const LDID = encoding == "sjis"? 0x13:0;
    const LDID = encoding == "sjis" ? 0x13 : 0x4B; // UTF-8なら0x4Bが一般的
    const yyyymmdd = d => { const L2 = d=>(d > 9? "":"0")+d;
        return d.getFullYear() + L2(d.getMonth()) + L2(d.getDate());
    };
    const sizes = Object.entries({fieldCount, recordSize, fileBytes, headerBytes, recordBytes}).map(t=>t.join(":")).join(", ");
    console.log(`DBF (${name + '.dbf'}) : ${sizes}\n => Fields : ${fields.map(t=>t.name).join(", ")}`);
    
    var DBF = new WBUF(fileBytes).writeUint8(3).writeUint8(Y - 1900).writeUint8(M).writeUint8(D)
        .writeUint32(recordSize, true).writeUint16(headerBytes, true).writeUint16(recordBytes, true).skip(17)
        .writeUint8(LDID).skip(2)
    fields.reduce((dataOffset, { name, type, length, precision }) => {
        DBF.writeBuffer(encoder(name), 11).writeUint8(type.charCodeAt(0)).writeUint32(dataOffset, true)
           .writeUint8(length).writeUint8(precision).skip(14);
        return dataOffset + length;
    }, 1); // 削除フラグ分の 1 バイトから開始
    DBF.writeUint8(0x0d);
    const badname = {};
    props.forEach(rec => { DBF.writeUint8(0x20);
        fields.forEach(({name, type, length, precision}) =>{
            const fill = (s,length) => { while(s.length < length) s += " "; return s; };
            let value = rec[name]; if (value===undefined) return DBF.skip(length);
            switch (type) {
            case 'L': DBF.writeUint8(!!value ? 84 : 70); break;
            case 'N': const numStr = value.toFixed(precision).padStart(length, " ");
                DBF.writeBuffer(encoder(numStr)); break;
            case 'D': DBF.writeBuffer(encoder(yyyymmdd(value)), length); break;
            case 'C': 
                if (value instanceof ImageData||value instanceof Blob) {
                    badname[name] = true;
                    value = {};
                }
                DBF.writeBuffer(encoder(value == null? "": 
                typeof value == "object"?stringify(value):String(value)), length); break;
            }
        });
    });
    Object.keys(badname).length && console.warn("illegal binary data in ", Object.keys(badname).join(", "));
    DBF.writeUint8(0x1a);
    return new File([DBF.buffer()], name + '.dbf', {type:"application/octet-stream"});
}
////=======================================================================================================================
onmessage = async (e) => {
    const {buf, name, encoding} = e.data;
    const encoder = await getEncoder(encoding);
	const prj  = `GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]`;
	console.log(`--------------------------\n    PBF => Shape File\n--------------------------`)
	const shpTypes = [["point", 1],["multipoint", 8],["polyline", 3],["polygon", 5]];
	const types = [[],[],[],[],[]];
	const pbf = await new GeoPBF().name(name).set(buf); //console.log(pbf);
	pbf.fmap.forEach((t,i)=>{
		if (t[2] < 6) types[[0,1,2,2,3,3][t[2]]].push(i);
		else t[4].forEach((u,j)=>types[[0,1,2,2,3,3][u]].push([i,j]));
	});
	pbf.bufs.length && console.warn("Binary(file/images) data will be lost in shape.")
	const single = sum(types.map(t=>t.length? 1:0))==1;
	const zipFiles = [];
	shpTypes.forEach(([shpType, shpCode], i)=>{ if (!types[i].length) return;
		const fname = name + (single?"":"_"+shpType);
		zipFiles.push(...writeShp(pbf, fname, types[i], shpCode));
		zipFiles.push(writeDbf(pbf, fname, types[i], encoding, encoder));
        zipFiles.push(new File([prj], fname + '.prj', {type:"application/octet-stream"}));
        zipFiles.push(new File([encoding], fname + '.cpg', {type:"text/plain"}));
	});
	console.log(`preparing deflation...`);
	const file = await encodeZIP(zipFiles, name+".zip");
	console.log(" => Done : ", file.name, "size: " + file.size.toLocaleString() + " bytes");
	postMessage(file);
};
````

## File: src/encoder/topojson.js
````javascript
import { GeoPBF } from "../pbf.js";

onmessage = async (e) => {
    const { buf, name, gz } = e.data;
    try {
        const pbf = await new GeoPBF({ name }).set(buf);
        const topo = pbf.topojson;
        const resStr = JSON.stringify(topo);
        let res = resStr;
        if (gz) {
            const out = new Response(new Blob([resStr]).stream().pipeThrough(new CompressionStream("gzip")));
            res = await out.blob();
        }
        postMessage(new File([res], `${name}.topojson${gz ? ".gz" : ""}`, {
            type: gz ? "application/gzip" : "application/json"
        }));
    } catch (err) {
        console.error("Topojson encode Worker Error:", err);
        postMessage(null);
    }
};
````

## File: src/extension/contain.js
````javascript
export const contain = (self, [px, py], getOneFlag) => {
    const out = b => (px < b[0] || px > b[2] || py < b[1] || py > b[3]);
    if (out(self.bbox)) return getOneFlag ? -1 : [];
    const rayCast = ring => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
            if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    };
    const checkPoly = coords => { if (!rayCast(coords[0])) return false; for (let i = 1; i < coords.length; i++) if (rayCast(coords[i])) return false; return true; };
    const isContain = n => {
        const fmap = self.fmap[n], type = fmap[2]; if (type < 4 || out(self.getBbox(n))) return false;
        const geom = self.getGeometry(n);
        if (type === 4) return checkPoly(geom.coordinates);
        if (type === 5) return geom.coordinates.some(checkPoly);
        return type === 6 && geom.geometries.some(g => (g.type === "Polygon" ? checkPoly(g.coordinates) : (g.type === "MultiPolygon" ? g.coordinates.some(checkPoly) : false)));
    };
    const a = []; for (let i = 0; i < self.length; i++) if (isContain(i)) { if (getOneFlag) return i; a.push(i); }
    return getOneFlag ? -1 : a;
};
````

## File: src/extension/dissolve.js
````javascript
import { GeoPBF } from "../pbf-base.js";

export async function dissolve(self, pname) {
    const keyIdx = self.keys.indexOf(pname);
    if (keyIdx < 0) return self;

    const tub = {};
    self.props.forEach((propArr, i) => {
        const val = propArr[keyIdx];
        if (val !== undefined) {
            tub[val] = tub[val] || [];
            tub[val].push(i);
        }
    });

    const groups = Object.entries(tub).sort((p, q) => p[0] > q[0] ? 1 : -1).map(t => t[1]);
    const props = groups.map(indices => {
        const groupProps = indices.map(idx => self.props[idx]), base = [...groupProps[0]], propObj = {};
        for (let i = 1; i < groupProps.length; i++) {
            base.forEach((v, j) => { if (base[j] !== groupProps[i][j]) base[j] = undefined; });
        }
        base.forEach((v, i) => {
            if (v === undefined) return;
            const keys = self.keys[i].split(".");
            if (keys.length === 1) propObj[keys[0]] = v;
            else {
                propObj[keys[0]] = propObj[keys[0]] || {};
                propObj[keys[0]][keys.slice(1).join(".")] = v;
            }
        });
        return propObj;
    });

    const pbf = new GeoPBF({ name: self._name, precision: Math.log10(self.e) }).copyHead(self);
    pbf.setBody(() => {
        groups.forEach((indices, idx) => {
            let mergedCoords = [];
            const addGeom = g => {
                if (g.type === "Polygon") mergedCoords.push(g.coordinates);
                else if (g.type === "MultiPolygon") mergedCoords.push(...g.coordinates);
            };
            indices.map(i => self.getGeometry(i)).forEach(g => {
                if (g.type === "GeometryCollection") g.geometries.forEach(addGeom);
                else addGeom(g);
            });
            if (!mergedCoords.length) return;
            const isMulti = mergedCoords.length > 1;
            pbf.setFeature({
                type: "Feature",
                geometry: { type: isMulti ? "MultiPolygon" : "Polygon", coordinates: isMulti ? mergedCoords : mergedCoords[0] },
                properties: props[idx]
            });
        });
    }).close();

    return await pbf.getPosition();
}
````

## File: src/extension/gint.js
````javascript
export class gint {
    static TERMINAL_BIT = 1n << 63n;
    static WEIGHT_MASK = 0x3Fn;
    static SCALE_E = 1e7;
    static INV_SCALE_E = 1e-7;

    static pack([lng, lat]) {
        const ix = Math.round((lng + 180) * this.SCALE_E);
        const iy = Math.round((lat + 90) * this.SCALE_E);
        return this._pureMortonFromInt(ix, iy) | this.TERMINAL_BIT;
    }

    static packFromInt(ix, iy) {
        const xl = this._spread16(ix & 0xFFFF), xh = this._spread16((ix >>> 16) & 0xFFFF);
        const yl = this._spread16(iy & 0xFFFF), yh = this._spread16((iy >>> 16) & 0xFFFF);
        return ((BigInt((xh | (yh << 1)) >>> 0) << 32n) | BigInt((xl | (yl << 1)) >>> 0)) | this.TERMINAL_BIT;
    }

    static unpackToInt(m) {
        const isL1 = (m & this.TERMINAL_BIT) !== 0n;
        const morton = isL1 ? (m & ~this.TERMINAL_BIT) : (m & ~this.WEIGHT_MASK);
        const low32 = Number(morton & 0xFFFFFFFFn) >>> 0;
        const high32 = Number((morton >> 32n) & 0x7FFFFFFFn) >>> 0;
        const ix = ((this._compact16(high32) << 16) | this._compact16(low32)) >>> 0;
        const iy = ((this._compact16(high32 >>> 1) << 16) | this._compact16(low32 >>> 1)) >>> 0;
        return [ix, iy];
    }

    static intToVal([ix, iy]) {
        return [(ix * this.INV_SCALE_E) - 180, (iy * this.INV_SCALE_E) - 90].map(t => Number(t.toFixed(7)));
    }

    static unpack(m) {
        return this.intToVal(this.unpackToInt(m));
    }

    static toL2(L1, weight) {
        const [ix, iy] = this.unpackToInt(L1);
        const rx = Math.round(ix / 8) * 8;
        const ry = Math.round(iy / 8) * 8;
        return (this._pureMortonFromInt(rx, ry) & ~this.WEIGHT_MASK) | BigInt(weight & 0x3F);
    }

    static getWeight(m) {
        return (m & this.TERMINAL_BIT) !== 0n ? 63 : Number(m & this.WEIGHT_MASK);
    }

    static _pureMortonFromInt(ix, iy) {
        const xl = this._spread16(ix & 0xFFFF), xh = this._spread16((ix >>> 16) & 0xFFFF);
        const yl = this._spread16(iy & 0xFFFF), yh = this._spread16((iy >>> 16) & 0xFFFF);
        return (BigInt((xh | (yh << 1)) >>> 0) << 32n) | BigInt((xl | (yl << 1)) >>> 0);
    }

    static _spread16(x) {
        x = (x | (x << 8)) & 0x00FF00FF;
        x = (x | (x << 4)) & 0x0F0F0F0F;
        x = (x | (x << 2)) & 0x33333333;
        x = (x | (x << 1)) & 0x55555555;
        return x >>> 0;
    }

    static _compact16(m) {
        m &= 0x55555555;
        m = (m | (m >>> 1)) & 0x33333333;
        m = (m | (m >>> 2)) & 0x0F0F0F0F;
        m = (m | (m >>> 4)) & 0x00FF00FF;
        m = (m | (m >>> 8)) & 0x0000FFFF;
        return m & 0xFFFF;
    }
}
````

## File: src/extension/manipulate.js
````javascript
import { GeoPBF } from "../pbf-base.js";

const thenMap = async (a, func) => {
    const q = []; for (let i = 0; i < a.length; i++) q.push(await func(a[i], i).catch(console.error));
    return q;
};

export function count(self) {
    const sum = a => { let n = 0; a.forEach(t => n += t); return n; };
    if (self.counts) return self.counts;
    const counts = [0, 0, 0, 0];
    const sumup = g => {
        const { type, coordinates: c } = g; if (!c) return;
        const t = GeoPBF.geometryMap[type];
        switch (t) {
            case 0: counts[0] += 1; counts[3] += 1; break;
            case 1: counts[0] += c.length; counts[3] += c.length; break;
            case 2: counts[1] += 1; counts[3] += c.length; break;
            case 3: counts[1] += c.length; counts[3] += sum(c.map(t => t.length)); break;
            case 4: counts[2] += 1; counts[3] += sum(c.map(t => t.length)); break;
            case 5: counts[2] += c.length; counts[3] += sum(c.map(t => sum(t.map(u => u.length)))); break;
        }
    };
    self.each(i => {
        const g = self.getGeometry(i);
        if (self.getType(i) === "GeometryCollection") g.geometries.forEach(sumup);
        else sumup(g);
    });
    return (self.counts = counts);
}

export function lint(self) {
    const comma = _ => String(_).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    let str = []; const countArr = [0, 0, 0, 0, 0, 0, 0, 0];
    self.each((i, fmap) => countArr[fmap[2]]++);
    const types = countArr.map((n, i) => n ? `#${GeoPBF.geometryTypes[i]}: ${n}` : ``).filter(t => t);
    str.push(`-------------------------------------------------`, ` GEOPBF ${self._name}`, `-------------------------------------------------`);
    str.push(` FEATURES: ${self.length} ( ${types.join(" , ")} )`, ` SIZE: ${comma(self.size)} [bytes]`, ` PRECiSION: ${self._precision} [${1 / self.e}]`, ` BBOX: ${JSON.stringify(self.bbox)}`);
    const [point_count, line_count, poly_count, coords_count] = self.count.map(comma);
    str.push(`-------------------------------------------------`, ` GEOMETRY SECTION`, `-------------------------------------------------`, ` # POINT: ${point_count}`, ` # LINE: ${line_count}`, ` # POLYGON: ${poly_count}`, ` # TOTAL COORDINATES: ${coords_count}`);
    str.push(`-------------------------------------------------`, ` PROPERTIES SECTION (${self.keys.length} properties)`, `-------------------------------------------------`);
    const typesort = a => {
        const q = {}; a.forEach(t => q[t] = (q[t] || 0) + 1);
        const c = Object.entries(q).sort((p, q) => q[1] - p[1]);
        return (c.length == 2 && GeoPBF.dataTypeNames[c[0][0]] == "FLOAT" && GeoPBF.dataTypeNames[c[1][0]] == "INTEGER") ? [[c[0][0], (c[0][1] + c[1][1])]] : c;
    };
    var a = Array.from({ length: self.keys.length }, () => []);
    self.props.forEach((t) => t.forEach((s, j) => { if (s !== undefined) a[j].push(s); }));
    a.forEach((values, i) => {
        var typeStr = typesort(values.map(t => GeoPBF.dataType(t))).map(t => `${GeoPBF.dataTypeNames[t[0]]}:${t[1]}`).join("|");
        str.push(` ${self.keys[i]}: ${typeStr}`);
    });
    str.push(`-------------------------------------------------`, new Date().toString());
    return str.join("\n") + "\n";
}

export async function clone(self, options = {}) {
    let { name, filter, map } = options;
    name = name || ""; map = map || (t => t); filter = filter || (() => true);
    if (name.startsWith("@")) name = self.name() + name;
    const pbf = new GeoPBF({ name, precision: Math.log10(self.e) });
    const sels = self.each(i => i).filter(i => filter(self.getProperties(i), self.getType(i), self.getBbox(i), i));
    const props = sels.map(i => map(self.getProperties(i), self.getType(i), self.getBbox(i)));
    pbf.setHead(...(await GeoPBF.makeKeys(props)));
    pbf.setBody(() => sels.forEach((n, i) => pbf.setMessage(GeoPBF.TAGS.FEATURE, () => { pbf.copyGeometry(self, n); pbf.setProperties(props[i]); }))).close();
    return pbf.getPosition();
}

export async function classify(self, key) {
    const a = {};
    self.each(i => {
        const p = self.getProperties(i), s = (typeof key === "function") ? key(p, self.getType(i), self.getBbox(i), i) : p[key];
        if (s !== undefined) { a[s] = a[s] || []; a[s].push(i); }
    });
    return thenMap(Object.entries(a).sort((p, q) => p[0] > q[0] ? 1 : -1), async ([k, v]) => {
        const pbf = new GeoPBF({ name: self.name() + "@" + k, precision: Math.log10(self.e) }), props = v.map(i => self.getProperties(i));
        pbf.setHead(...(await GeoPBF.makeKeys(props)));
        pbf.setBody(() => v.forEach((n, i) => pbf.setMessage(GeoPBF.TAGS.FEATURE, () => { pbf.copyGeometry(self, n); pbf.setProperties(props[i]); }))).close();
        return pbf.getPosition();
    });
}

export function header(self, meta = {}) {
    return self.updateHeader(meta);
}

export async function update(buffer, meta = {}) {
    return GeoPBF.update(buffer, meta);
}

export async function concatinate(pbfs, name) {
    pbfs = pbfs.filter(t => t instanceof GeoPBF);
    if (pbfs.length == 0) return new GeoPBF(); if (pbfs.length == 1) return pbfs[0];
    if (!pbfs.map(t => t.precision()).slice(1).every((t, i, a) => t == pbfs[0].precision())) { console.error("PBF concatenate: precision is not equal."); return null; }
    name = name || pbfs[0].name();
    const props = pbfs.map(pbf => pbf.properties), [keys, bufs] = await GeoPBF.makeKeys(props.flat()), pbf = new GeoPBF({ name }).setHead(keys, bufs);
    pbf.setBody(() => pbfs.forEach((t, n) => { t.each(i => pbf.setMessage(GeoPBF.TAGS.FEATURE, () => { pbf.copyGeometry(t, i); pbf.setProperties(props[n][i]); })); })).close();
    return pbf.getPosition();
}
````

## File: src/extension/nearPoint.js
````javascript
class PriorityQueue {
	constructor(compare) { this.d = []; this.c = compare; }
	get length() { return this.d.length; }
	peek() { return this.d[0]; }
	push(v) {
		let d = this.d, i = d.push(v) - 1, p;
		while (i > 0 && this.c(v, d[p = (i - 1) >> 1]) < 0) d[i] = d[p], i = p;
		d[i] = v;
	}
	pop() {
		let d = this.d, t = d[0], b = d.pop(), i = 0, j, r;
		if (!d.length) return t;
		while ((j = (i << 1) + 1) < d.length) {
			if ((r = j + 1) < d.length && this.c(d[r], d[j]) < 0) j = r;
			if (this.c(d[j], b) >= 0) break;
			d[i] = d[j]; i = j;
		}
		d[i] = b;
		return t;
	}
}

const rad = Math.PI / 180;
const hSin = t => Math.sin(t / 2) ** 2;
const hDistP = (hDLng, cLat, lat1, lat2) => cLat * Math.cos(lat2 * rad) * hDLng + hSin((lat1 - lat2) * rad);
const hDist = (l1, lat1, l2, lat2, cLat) => hDistP(hSin((l1 - l2) * rad), cLat, lat1, lat2);

const vLat = (lat, hDLng) => {
	const c = 1 - 2 * hDLng;
	return c <= 0 ? (lat > 0 ? 90 : -90) : Math.atan(Math.tan(lat * rad) / c) / rad;
};

const bDist = (lng, lat, cLat, { minLng: x0, maxLng: x1, minLat: y0, maxLat: y1 }) => {
	if (lng >= x0 && lng <= x1) return lat < y0 ? hSin((lat - y0) * rad) : lat > y1 ? hSin((lat - y1) * rad) : 0;
	const hDLng = Math.min(hSin((lng - x0) * rad), hSin((lng - x1) * rad)), eLat = vLat(lat, hDLng);
	return (eLat > y0 && eLat < y1) ? hDistP(hDLng, cLat, lat, eLat) : Math.min(hDistP(hDLng, cLat, lat, y0), hDistP(hDLng, cLat, lat, y1));
};

export async function nearPoint(self, pt, maxResults = Infinity, maxDistance = Infinity) {
	if (!self.kdbush) {
		let KDBushClass = globalThis.KDBush;
		if (!KDBushClass) {
			const module = await import('https://unpkg.com/kdbush@3.0.0/kdbush.js');
			KDBushClass = module.default || module;
		}
		const length = self.count[0], kdbush = self.kdbush = new KDBushClass(length), index = self.kdIndex = [];
		const add = (n, coords) => { kdbush.add(coords[0], coords[1]); index.push(n); };
		self.each(n => {
			const fmap = self.fmap[n], type = fmap[2];
			if (type === 0) add(n, self.getGeometry(n).coordinates);
			else if (type === 1) self.getGeometry(n).coordinates.forEach(t => add(n, t));
			else if (type === 6) self.getGeometry(n).geometries.forEach(g => (g.type === "Point" ? add(n, g.coordinates) : (g.type === "MultiPoint" ? g.coordinates.forEach(t => add(n, t)) : null)));
		});
		kdbush.finish();
	}

	const [lng, lat] = pt;
	const index = self.kdbush;
	const maxHDist = maxDistance < Infinity ? hSin(maxDistance / 6371) : 1;
	const res = [], q = new PriorityQueue((a, b) => a.dist - b.dist);
	let node = { l: 0, r: index.ids.length - 1, ax: 0, dist: 0, minLng: -180, minLat: -90, maxLng: 180, maxLat: 90 };
	const cLat = Math.cos(lat * rad);

	while (node) {
		const { l, r, ax, minLng, minLat, maxLng, maxLat } = node;
		if (r - l <= index.nodeSize) {
			for (let i = l; i <= r; i++) q.push({ id: index.ids[i], dist: hDist(lng, lat, index.coords[2 * i], index.coords[2 * i + 1], cLat) });
		} else {
			const m = (l + r) >> 1, mLng = index.coords[2 * m], mLat = index.coords[2 * m + 1];
			q.push({ id: index.ids[m], dist: hDist(lng, lat, mLng, mLat, cLat) });
			const nx = 1 - ax;
			const lN = { l, r: m - 1, ax: nx, minLng, minLat, maxLng: ax ? maxLng : mLng, maxLat: ax ? mLat : maxLat, dist: 0 };
			const rN = { l: m + 1, r, ax: nx, minLng: ax ? minLng : mLng, minLat: ax ? mLat : minLat, maxLng, maxLat, dist: 0 };
			lN.dist = bDist(lng, lat, cLat, lN);
			rN.dist = bDist(lng, lat, cLat, rN);
			q.push(lN); q.push(rN);
		}
		while (q.length && q.peek().id != null) {
			const c = q.pop();
			if (c.dist > maxHDist) return res.map(t => self.kdIndex[t]);
			if (res.push(c.id) === maxResults) return res.map(t => self.kdIndex[t]);
		}
		node = q.pop();
	}
	return res.map(t => self.kdIndex[t]);
}
````

## File: src/extension/purifier.js
````javascript
import { gint } from "./gint.js";

export const purify = (topo) => {
    if (!topo || !topo.length) return;
    const GRID_SHIFT = 16, SNAP_DIST_SQ = 125n, GRID_UNIT = 10n;
    const checkedPairs = new Set(), segments = [], grid = new Map(), segLookup = new Map();
    const packXY = (x, y) => (BigInt(x) << 32n) | (BigInt(y) & 0xFFFFFFFFn);
    let globalSegIdx = 0;

    topo.forEach((line, lineIdx) => {
        const coords = line.coords;
        for (let i = 0; i < coords.length - 1; i++) {
            if (coords[i] === coords[i + 1]) continue;
            const p1 = gint.unpackToInt(coords[i]), p2 = gint.unpackToInt(coords[i + 1]);
            const sid = globalSegIdx++;
            const seg = {
                id: sid, lineIdx, sIdx: i,
                bx1: Math.min(p1[0], p2[0]), bx2: Math.max(p1[0], p2[0]),
                by1: Math.min(p1[1], p2[1]), by2: Math.max(p1[1], p2[1]),
                x1: BigInt(p1[0]), y1: BigInt(p1[1]), x2: BigInt(p2[0]), y2: BigInt(p2[1]),
                origP1: coords[i], origP2: coords[i + 1], intersections: new Map()
            };
            segments.push(seg);
            segLookup.set(`${lineIdx}-${i}`, seg);
            for (let gx = seg.bx1 >>> GRID_SHIFT; gx <= seg.bx2 >>> GRID_SHIFT; gx++) {
                for (let gy = seg.by1 >>> GRID_SHIFT; gy <= seg.by2 >>> GRID_SHIFT; gy++) {
                    const key = (gx << 16) | gy;
                    let cell = grid.get(key);
                    if (!cell) grid.set(key, cell = []);
                    cell.push(sid);
                }
            }
        }
    });

    for (const segIds of grid.values()) {
        if (segIds.length < 2 || segIds.length > 1500) continue;
        for (let i = 0; i < segIds.length; i++) {
            const s1 = segments[segIds[i]];
            for (let j = i + 1; j < segIds.length; j++) {
                const s2 = segments[segIds[j]];
                if (s1.lineIdx === s2.lineIdx && Math.abs(s1.sIdx - s2.sIdx) <= 1) continue;
                const pairKey = BigInt(s1.id) << 32n | BigInt(s2.id);
                if (checkedPairs.has(pairKey)) continue;
                checkedPairs.add(pairKey);
                if (s1.bx2 < s2.bx1 || s1.bx1 > s2.bx2 || s1.by2 < s2.by1 || s1.by1 > s2.by2) continue;
                const pts = solver(s1, s2, SNAP_DIST_SQ, GRID_UNIT);
                if (pts) pts.forEach(pt => {
                    const key = packXY(pt.x, pt.y);
                    s1.intersections.set(key, pt); s2.intersections.set(key, pt);
                });
            }
        }
    }

    topo.forEach((line, lineIdx) => {
        const final = [], original = line.coords;
        const pushClean = (p) => {
            const len = final.length;
            if (len > 0 && final[len - 1] === p) return;
            if (len > 1 && final[len - 2] === p) { final.pop(); return; }
            final.push(p);
        };
        for (let i = 0; i < original.length - 1; i++) {
            pushClean(original[i]);
            const seg = segLookup.get(`${lineIdx}-${i}`);
            if (seg && seg.intersections.size > 0) {
                const x1 = Number(seg.x1), y1 = Number(seg.y1);
                const pts = Array.from(seg.intersections.values());
                pts.sort((a, b) => ((a.x - x1) ** 2 + (a.y - y1) ** 2) - ((b.x - x1) ** 2 + (b.y - y1) ** 2));
                pts.forEach(pt => pushClean(pt.packed));
            }
        }
        pushClean(original[original.length - 1]);
        if (final.length >= 2) line.coords = new BigUint64Array(final);
    });

    function solver(s1, s2, snap, unit) {
        const dx1 = s1.x2 - s1.x1, dy1 = s1.y2 - s1.y1, dx2 = s2.x2 - s2.x1, dy2 = s2.y2 - s2.y1;
        const det = dx1 * dy2 - dy1 * dx2, pts = [];
        const eps = [{ x: s1.x1, y: s1.y1, p: s1.origP1 }, { x: s1.x2, y: s1.y2, p: s1.origP2 }, { x: s2.x1, y: s2.y1, p: s2.origP1 }, { x: s2.x2, y: s2.y2, p: s2.origP2 }];
        const getPt = (ix, iy) => {
            for (const ep of eps) if ((ix - ep.x) ** 2n + (iy - ep.y) ** 2n <= snap) return { x: Number(ep.x), y: Number(ep.y), packed: ep.p };
            const sx = Number((BigInt(ix) + unit / 2n) / unit * unit), sy = Number((BigInt(iy) + unit / 2n) / unit * unit);
            return { x: sx, y: sy, packed: gint.packFromInt(sx, sy) };
        };
        if (det === 0n) {
            const cross = (s2.x1 - s1.x1) * dy1 - (s2.y1 - s1.y1) * dx1;
            if (cross === 0n) {
                const on = (px, py, lx1, ly1, lx2, ly2) => { const dot = (px - lx1) * (lx2 - lx1) + (py - ly1) * (ly2 - ly1); return dot > 0n && dot < (lx2 - lx1) ** 2n + (ly2 - ly1) ** 2n; };
                eps.forEach(ep => { if (on(ep.x, ep.y, s1.x1, s1.y1, s1.x2, s1.y2) || on(ep.x, ep.y, s2.x1, s2.y1, s2.x2, s2.y2)) pts.push({ x: Number(ep.x), y: Number(ep.y), packed: ep.p }); });
            }
        } else {
            const nT = (s2.x1 - s1.x1) * dy2 - (s2.y1 - s1.y1) * dx2, nU = (s2.x1 - s1.x1) * dy1 - (s2.y1 - s1.y1) * dx1;
            const isIn = (n, d) => d > 0n ? (n >= 0n && n <= d) : (n <= 0n && n >= d);
            if (isIn(nT, det) && isIn(nU, det)) pts.push(getPt(s1.x1 + (nT * dx1) / det, s1.y1 + (nT * dy1) / det));
        }
        const proj = (px, py, lx1, ly1, lx2, ly2) => {
            const ldx = lx2 - lx1, ldy = ly2 - ly1, d2 = ldx * ldx + ldy * ldy; if (d2 === 0n) return null;
            const t = (px - lx1) * ldx + (py - ly1) * ldy; if (t <= 0n || t >= d2) return null;
            const crs = (px - lx1) * ldy - (py - ly1) * ldx; if ((crs * crs) / d2 <= snap) return getPt(lx1 + (t * ldx) / d2, ly1 + (t * ldy) / d2);
            return null;
        };
        [proj(s2.x1, s2.y1, s1.x1, s1.y1, s1.x2, s1.y2), proj(s2.x2, s2.y2, s1.x1, s1.y1, s1.x2, s1.y2), proj(s1.x1, s1.y1, s2.x1, s2.y1, s2.x2, s2.y2), proj(s1.x2, s1.y2, s2.x1, s2.y1, s2.x2, s2.y2)].forEach(p => p && pts.push(p));
        return pts.length ? pts : null;
    }
};
````

## File: src/extension/simplify.js
````javascript
import { gint } from "./gint.js";

const rad = Math.PI / 180;

const getPhysRank = (area) => {
    if (area <= 0) return 0;
    const rank = Math.floor(1.5 * Math.log2(area) - 8.2365);
    return Math.min(63, Math.max(0, rank));
};

export const simplify = (arc) => {
    const n = arc.length;
    if (n < 3) return;
    const xs = new Float64Array(n), ys = new Float64Array(n), prev = new Int32Array(n), next = new Int32Array(n);
    const areas = new Float64Array(n), heap = new Int32Array(n), pos = new Int32Array(n).fill(-1), eff = new Float64Array(n);
    let minLat = Infinity, maxLat = -Infinity;

    for (let i = 0; i < n; i++) {
        const [lng, lat] = gint.unpack(arc[i]);
        xs[i] = lng; ys[i] = lat; prev[i] = i - 1; next[i] = i + 1;
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }

    const cosLat = Math.cos(((minLat + maxLat) / 2) * rad);
    const getArea = (i) => {
        const p = prev[i], nx = next[i];
        if (p < 0 || nx >= n) return Infinity;
        return Math.abs((xs[i] - xs[p]) * cosLat * (ys[nx] - ys[p]) - (xs[nx] - xs[p]) * cosLat * (ys[i] - ys[p])) * 0.5;
    };

    const swap = (a, b) => { [heap[a], heap[b]] = [heap[b], heap[a]]; pos[heap[a]] = a; pos[heap[b]] = b; };
    const up = (i) => { for (; i > 0 && areas[heap[i]] < areas[heap[(i - 1) >>> 1]]; i = (i - 1) >>> 1) swap(i, (i - 1) >>> 1); };
    const down = (i) => {
        while (true) {
            let l = (i << 1) + 1, r = l + 1, d = l; if (l >= heapSize) break;
            if (r < heapSize && areas[heap[r]] < areas[heap[l]]) d = r;
            if (areas[heap[d]] >= areas[heap[i]]) break;
            swap(i, d); i = d;
        }
    };

    let heapSize = 0;
    for (let i = 1; i < n - 1; i++) { areas[i] = getArea(i); heap[heapSize] = i; pos[i] = heapSize; up(heapSize++); }

    let maxA = 0;
    while (heapSize > 0) {
        const curr = heap[0]; pos[curr] = -1;
        if (--heapSize > 0) { heap[0] = heap[heapSize]; pos[heap[0]] = 0; down(0); }
        maxA = Math.max(maxA, areas[curr]);
        eff[curr] = maxA;
        const p = prev[curr], nx = next[curr];
        if (p >= 0) next[p] = nx; if (nx < n) prev[nx] = p;
        [p, nx].forEach(idx => { if (idx > 0 && idx < n - 1 && pos[idx] !== -1) { areas[idx] = Math.max(getArea(idx), maxA); up(pos[idx]); down(pos[idx]); } });
    }

    for (let i = 1; i < n - 1; i++) arc[i] = gint.toL2(arc[i], getPhysRank(eff[i]));
};
````

## File: src/extension/spatial.js
````javascript
const r2d = Math.PI / 180;

export const centroid = (self, i) => {
    const geom = self.getGeometry(i); let x = 0, y = 0, count = 0;
    const add = c => { if (typeof c[0] === 'number') { x += c[0]; y += c[1]; count++; } else c.forEach(add); };
    if (geom.type === "GeometryCollection") geom.geometries.forEach(g => add(g.coordinates || []));
    else add(geom.coordinates || []);
    return count ? [Math.round((x / count) * self.e) / self.e, Math.round((y / count) * self.e) / self.e] : [0, 0];
};

export const area = (self, i) => {
    const geom = self.getGeometry(i), R = 6378137;
    const ringArea = coords => {
        let area = 0, n = coords.length;
        if (n > 2) { for (let j = 0; j < n; j++) { let p1 = coords[j === 0 ? n - 1 : j - 1], p2 = coords[j], p3 = coords[j === n - 1 ? 0 : j + 1]; area += (p3[0] - p1[0]) * r2d * Math.sin(p2[1] * r2d); } }
        return Math.abs(area * R * R / 2);
    };
    let total = 0;
    const calc = (g) => {
        if (g.type === "Polygon") { total += ringArea(g.coordinates[0]); for (let j = 1; j < g.coordinates.length; j++) total -= ringArea(g.coordinates[j]); }
        else if (g.type === "MultiPolygon") { g.coordinates.forEach(poly => { total += ringArea(poly[0]); for (let j = 1; j < poly.length; j++) total -= ringArea(poly[j]); }); }
        else if (g.type === "GeometryCollection") g.geometries.forEach(calc);
    };
    calc(geom); return Math.round(total);
};
````

## File: src/extension/topojson.js
````javascript
import { gint } from "./gint.js";

export function toTopoJSON(self) {
    const { e, bbox, structures } = self;
    if (!structures) self.analyzeTopology();

    const arcs = [];
    const processLayer = (layer) => {
        const { buffer, meta, mlen, count } = layer;
        for (let i = 0; i < count; i++) {
            const off = meta[i * mlen], len = meta[i * mlen + 1], arc = [];
            let px = 0, py = 0;
            for (let j = 0; j < len; j++) {
                const [cx, cy] = gint.unpack(buffer[off + j]);
                const rx = Math.round(cx * e), ry = Math.round(cy * e);
                arc.push([rx - px, ry - py]);
                px = rx; py = ry;
            }
            arcs.push(arc);
        }
    };

    if (self.polygon) processLayer(self.polygon);
    if (self.polyline) processLayer(self.polyline);

    const n_poly_arcs = self.polygon ? self.polygon.count : 0;
    const shift = i => (i < 0 ? ~((~i) + n_poly_arcs) : i + n_poly_arcs);

    const geometries = self.each((id, map, props) => {
        const topo = self.structures.map(layer => layer.filter(t => t.id === id));
        const res = { type: "GeometryCollection", geometries: [], properties: props };

        if (topo[0].length) {
            const p = topo[0].map(t => t.coords);
            res.geometries.push({ type: "MultiPoint", coordinates: p.map(c => gint.unpack(c[0])) });
        }
        if (topo[1].length) {
            const a = topo[1].map(t => t.arcs.map(shift));
            res.geometries.push({ type: "MultiLineString", arcs: a });
        }
        if (topo[2].length) {
            const a = topo[2].map(t => t.arcs.map(r => r.map(shift)));
            res.geometries.push({ type: "MultiPolygon", arcs: a });
        }
        return res;
    });

    return {
        type: "Topology",
        bbox: [...bbox],
        arcs,
        transform: { scale: [1 / e, 1 / e], translate: [0, 0] },
        objects: { collection: { type: "GeometryCollection", geometries } }
    };
}
````

## File: src/extension/topology.js
````javascript
import { GeoPBF } from "../pbf-base.js";
import { gint } from "./gint.js";
import { purify } from "./purifier.js";
import { simplify } from "./simplify.js";

const TAGS = GeoPBF.TAGS;

export function analyzeTopology(self) {
    if (self.structures) return self.structures;
    const structures = [[], [], []];
    const S = 1 / self.e;

    self.each((id, map) => {
        const process = (pos, type) => {
            self.pbf.pos = pos;
            let lens = [], coords = [];
            self.pbf.readMessage((tag) => {
                if (tag === TAGS.LENGTH) self.pbf.readPackedVarint(lens);
                else if (tag === TAGS.COORDS) {
                    const end = self.pbf.readVarint() + self.pbf.pos;
                    let x = 0, y = 0;
                    const read = (n) => {
                        let c = [];
                        const grab = () => {
                            let dx = self.pbf.readSVarint(), dy = self.pbf.readSVarint();
                            if (dx || dy) { x += dx; y += dy; c.push(gint.pack([x * S, y * S])); }
                        };
                        if (n === undefined) { while (self.pbf.pos < end) grab(); }
                        else { while (n-- > 0) grab(); }
                        return new BigUint64Array(c);
                    };
                    const typeGroups = [
                        () => [read(1)], // Point
                        () => [read()],  // MultiPoint
                        () => [read()],  // LineString
                        () => lens.map(t => read(t)), // MultiLineString
                        () => [lens.map(t => read(t))], // Polygon
                        () => { // MultiPolygon
                            const c = []; let p = 0;
                            for (let i = 0; i < lens[0]; i++) {
                                let len = lens[++p]; c[i] = [];
                                for (let j = 0; j < len; j++) c[i].push(read(lens[++p]));
                            }
                            return c;
                        }
                    ];
                    coords = typeGroups[type]();
                }
            });
            const tIndex = type < 2 ? 0 : type < 4 ? 1 : 2;
            coords.forEach(c => structures[tIndex].push({ id, coords: c }));
        };
        if (map[2] === 6) map[3].forEach((p, j) => process(p, map[4][j]));
        else process(map[1], map[2]);
    });

    self.point = buildPoints(structures[0]);
    purify(structures[1]);
    self.polyline = buildArcs(structures[1], "polyline");
    structures[2].forEach(t => {
        const tempRings = t.coords.map(ring => ({ coords: ring }));
        purify(tempRings);
        t.coords = tempRings.map(obj => obj.coords);
    });
    self.polygon = buildArcs(structures[2], "polygon");
    return (self.structures = structures);
}

function buildPoints(topo) {
    if (!topo.length) return null;
    const hash = new Map();
    topo.forEach(({ id, coords }) => { const a = hash.get(coords[0]) || []; a.push(id); hash.set(coords[0], a); });
    const buff = [...hash.entries()].sort((p, q) => p[0] > q[0] ? 1 : -1);
    const buffer = new BigUint64Array(buff.length), owner = buff.map(t => t[1]);
    buff.forEach(([key], i) => buffer[i] = key);
    return { count: buff.length, buffer, owner };
}

function buildArcs(topo, type) {
    const buffs = [], aHash = new Map(), vHash = new Map();
    const isTerm = (arc, i) => (i === 0 || i === arc.length - 1 || (vHash.get(arc[i]) || 0) > 2);
    const flatten = type === "polygon" ? topo.flatMap(t => t.coords.flat()) : topo.flatMap(t => t.coords);
    flatten.forEach(arc => arc.forEach(p => vHash.set(p, (vHash.get(p) || 0) + 1)));

    const processArc = (arc) => {
        let i = 0, indices = [], n = arc.length;
        while (i < n - 1) {
            let j = i + 1;
            while (j < n - 1 && !isTerm(arc, j)) j++;
            const seg = arc.subarray(i, j + 1);
            const p = seg[0], q = seg[seg.length - 1];
            const [min, max] = p > q ? [q, p] : [p, q];
            const aKey = (min << 96n) | (max << 32n) | BigInt(seg.length);
            if (!aHash.has(aKey)) { aHash.set(aKey, buffs.length); simplify(seg); buffs.push(seg); }
            const idx = aHash.get(aKey);
            indices.push(p === buffs[idx][0] ? idx : ~idx);
            i = j;
        }
        return indices;
    };

    topo.forEach(t => {
        if (type === "polygon") t.arcs = t.coords.map(r => processArc(r));
        else t.arcs = processArc(t.coords);
    });

    const total = buffs.reduce((s, b) => s + b.length, 0);
    const buffer = new BigUint64Array(total), meta = new Uint32Array(buffs.length * 8);
    const owner = new Array(buffs.length); // 各Arcの所有ポリゴンを記録
    let offset = 0;
    buffs.forEach((b, i) => {
        buffer.set(b, offset);
        meta.set([offset, b.length, 0, 0, 0, 0, 0, 0], i * 8);
        offset += b.length;
    });

    // Arcと所有者の紐付け
    topo.forEach(t => {
        const ids = type === "polygon" ? t.arcs.flat() : [t.arcs];
        ids.forEach(aid => {
            const id = aid < 0 ? ~aid : aid;
            (owner[id] = owner[id] || []).push(aid < 0 ? ~t.id : t.id);
        });
    });

    return { count: buffs.length, buffer, meta, mlen: 8, owner };
}

// --- 空間操作メソッド ---

export function mesh(self, filter) {
    if (!self.structures) analyzeTopology(self);
    const filterFunc = typeof filter === 'function' ? filter : () => true;
    const arcs = [];
    self.polygon.owner.forEach((owners, aid) => {
        const filtered = owners.filter(id => filterFunc(self.getProperties(id < 0 ? ~id : id)));
        if (filtered.length === 2) arcs.push(aid);
    });
    return { type: "MultiLineString", coordinates: arcs.map(aid => arcCoords(self, aid)) };
}

export function merge(self, filter) {
    if (!self.structures) analyzeTopology(self);
    const filterFunc = typeof filter === 'function' ? filter : () => true;
    const externalArcs = [];
    self.polygon.owner.forEach((owners, aid) => {
        const filtered = owners.filter(id => filterFunc(self.getProperties(id < 0 ? ~id : id)));
        if (filtered.length === 1) externalArcs.push(aid);
    });
    const rings = stitchRings(self, externalArcs);
    return { type: "MultiPolygon", coordinates: [rings.map(r => ringCoords(self, r))] };
}

export function neighbors(self, id) {
    const table = [];
    if (!self.structures) analyzeTopology(self);
    self.polygon.owner.forEach(owners => {
        if (!owners) return;
        owners.forEach(p => {
            owners.forEach(q => {
                if (p !== q) {
                    const pid = p < 0 ? ~p : p, qid = q < 0 ? ~q : q;
                    (table[pid] = table[pid] || new Set()).add(qid);
                }
            });
        });
    });
    return id === undefined ? table.map(s => Array.from(s || [])) : Array.from(table[id] || []);
}

// --- 補助関数 ---

function arcCoords(self, aid) {
    const { buffer, meta, mlen } = self.polygon;
    const id = aid < 0 ? ~aid : aid;
    const off = meta[id * mlen], len = meta[id * mlen + 1];
    let pts = [];
    for (let i = 0; i < len; i++) pts.push(gint.unpack(buffer[off + i]));
    return aid < 0 ? pts.reverse() : pts;
}

function ringCoords(self, ring) {
    let coords = [];
    ring.forEach((aid, i) => {
        const pts = arcCoords(self, aid);
        coords = coords.concat(i === 0 ? pts : pts.slice(1));
    });
    return coords;
}

function stitchRings(self, arcs) {
    if (!arcs || !arcs.length) return [];
    const { buffer, meta, mlen } = self.polygon;
    const nodes = new Map(), used = new Set(), rings = [];
    arcs.forEach(id => {
        const off = meta[id * mlen], len = meta[id * mlen + 1];
        const p = buffer[off], q = buffer[off + len - 1];
        (nodes.get(p) || nodes.set(p, []) && nodes.get(p)).push({ id, rev: false });
        (nodes.get(q) || nodes.set(q, []) && nodes.get(q)).push({ id, rev: true });
    });
    for (const id of arcs) {
        if (used.has(id)) continue;
        let ring = [], curr = { id, rev: false };
        while (curr && !used.has(curr.id)) {
            used.add(curr.id);
            ring.push(curr.rev ? ~curr.id : curr.id);
            const off = meta[curr.id * mlen], len = meta[curr.id * mlen + 1];
            const nextNode = buffer[curr.rev ? off : off + len - 1];
            curr = (nodes.get(nextNode) || []).find(n => !used.has(n.id));
        }
        if (ring.length) rings.push(ring);
    }
    return rings;
}
````

## File: src/extension/view.js
````javascript
import { GeoPBF } from "../pbf-base.js";

export function drawGeometry(self, n) {
    const { pbf, fmap, e, ctx, proj, radius = 3 } = self;
    const map = fmap[n];
    const { TAGS } = GeoPBF;

    ctx.beginPath();
    const drawCoords = (pos, type) => {
        pbf.pos = pos;
        let lens = [];

        pbf.readMessage(tag => {
            if (tag === TAGS.LENGTH) pbf.readPackedVarint(lens);
            else if (tag === TAGS.COORDS) {
                const end = pbf.readVarint() + pbf.pos;
                let p = [0, 0];
                const readNext = () => {
                    p[0] += pbf.readSVarint();
                    p[1] += pbf.readSVarint();
                    return proj([p[0] / e, p[1] / e]);
                };

                if (type === 0) { // Point
                    const [x, y] = readNext();
                    ctx.moveTo(x + radius, y); ctx.arc(x, y, radius, 0, Math.PI * 2);
                } else if (type === 1) { // MultiPoint
                    while (pbf.pos < end) {
                        const [x, y] = readNext();
                        ctx.moveTo(x + radius, y); ctx.arc(x, y, radius, 0, Math.PI * 2);
                    }
                } else if (type < 4) { // LineString
                    let i = 0;
                    while (pbf.pos < end) ctx[i++ ? "lineTo" : "moveTo"](...readNext());
                } else { // Polygon / MultiPolygon
                    let pos = 0;
                    const drawRing = (n) => {
                        let pRing = [0, 0];
                        const start = [pRing[0] += pbf.readSVarint(), pRing[1] += pbf.readSVarint()];
                        ctx.moveTo(...proj([start[0] / e, start[1] / e]));
                        while (--n > 0) {
                            pRing[0] += pbf.readSVarint();
                            pRing[1] += pbf.readSVarint();
                            ctx.lineTo(...proj([pRing[0] / e, pRing[1] / e]));
                        }
                        ctx.closePath();
                    };
                    if (type === 4) lens.forEach(drawRing);
                    else {
                        for (let i = 0; i < lens[0]; i++) {
                            const nRings = lens[++pos];
                            for (let j = 0; j < nRings; j++) drawRing(lens[++pos]);
                        }
                    }
                }
            }
        });
    };

    if (map[2] === 6) map[3].forEach((t, i) => drawCoords(t, map[4][i]));
    else drawCoords(map[1], map[2]);
    return self;
}

export async function view(self, canvas, props = {}) {
    if (!self.length) return;
    const bbox = props.bbox || self.bbox;
    const w = canvas.width, h = canvas.height;

    let d3 = globalThis.d3;
    if (!d3) d3 = await import("https://esm.sh/d3-geo@3");

    const projName = ["Orthographic", "Mercator", "Equirectangular"].includes(props.projection) ? props.projection : "Equirectangular";
    const proj = d3["geo" + projName]();

    const cx = (bbox[0] + bbox[2]) / 2;
    const cy = (bbox[1] + bbox[3]) / 2;
    const dx = Math.abs(bbox[2] - bbox[0]) * Math.cos(cy * Math.PI / 180);
    const dy = Math.abs(bbox[3] - bbox[1]);
    const scale = Math.min(w / dx, h / dy) * 50;

    proj.rotate([-cx, -cy, 0]).translate([w / 2, h / 2]).scale(scale);

    const offcanvas = new OffscreenCanvas(w, h);
    const ctx = offcanvas.getContext("2d");

    self.ctx = ctx; self.proj = proj; self.radius = props.radius || 3;

    if (props.background) { ctx.fillStyle = props.background; ctx.fillRect(0, 0, w, h); }
    ctx.lineWidth = props.width || 1;
    ctx.fillStyle = props.fill || "#ccc";
    ctx.strokeStyle = props.stroke || "#000";

    const out = b => (bbox[0] > b[2] || bbox[1] > b[3] || bbox[2] < b[0] || bbox[3] < b[1]);

    self.each((n, fmap) => {
        if (out(self.getBbox(n))) return;
        self.drawGeometry(n);
        if (fmap[2] < 2 || fmap[2] > 3) ctx.fill();
        ctx.stroke();
    });

    canvas.getContext("bitmaprenderer").transferFromImageBitmap(offcanvas.transferToImageBitmap());
}
````

## File: src/modules/bufferTub.js
````javascript
////---------------------------------------------------------------------------------------------------------
//// ArrayBufferの圧縮・伸長
////---------------------------------------------------------------------------------------------------------
const pipe = async(q, filter) => new Response(new Blob([q]).stream().pipeThrough(filter)).arrayBuffer();
const enc = q => pipe(q, new CompressionStream("deflate-raw"));
const dec = q => pipe(q, new DecompressionStream("deflate-raw"));
const thenMap = (a, func) => Promise.all(a.map((v, i) => func(v, i).catch(console.error)));
////---------------------------------------------------------------------------------------------------------
//// bufferTub (ArrayBufferを効率的に、アレイ化)
////---------------------------------------------------------------------------------------------------------
export class bufferTub {
    constructor() { this.tub = []; }
    set(q) { if (q instanceof ArrayBuffer) return abset(this.tub, q); }
    async close() { const a = this.tub.sort((p, q) => p[1] - q[1]).map(t => t[0]); this.tub = [];
        return thenMap(a, enc);
    }
}
export class readBufs { 
    constructor() { this.tub = []; }
    set(q) { this.tub.push(q); }
    async close() { const tobuf = v => v.buffer ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v;
        const a = this.tub.map(tobuf); this.tub = [];
        return thenMap(a, dec);
    }
}
function abcomp(buf1, buf2) {
    if (buf1 === buf2) return 0;
    let d = buf2.byteLength - buf1.byteLength; if (d) return d;
    const v1 = new Uint8Array(buf1), v2 = new Uint8Array(buf2);
    for (let i = 0; i < v1.length; i++) {  d = v2[i] - v1[i]; if (d) return d;  }
    return 0;
}
function abset(a, buf) { const len = a.length;
    if (len === 0) { a[0] = [buf, 0]; return 0; }
    return (function cmp(m0, m1) {
        const mid = (m0 + m1) >>> 1;
        const v = abcomp(a[mid][0], buf);
        if (!v) return a[mid][1];
        if (m0 >= m1) {
            const idx = v > 0 ? mid + 1 : mid;
            a.splice(idx, 0, [buf, len]);
            return len;
        }
        return v > 0 ? cmp(mid + 1, m1) : cmp(m0, mid - 1);
    })(0, len - 1);
}
````

## File: src/modules/topo2geo.js
````javascript
export function topo2geo(topo) {
    const { arcs, transform, objects } = topo;
    const { scale = [1, 1], translate = [0, 0] } = transform || {};
    const tran = c => [ c[0] * scale[0] + translate[0], c[1]* scale[1] + translate[1] ];
    const decodePoints = coords => { let t = [0,0]; return transform? coords.map(c => [t[0] += c[0], t[1] += c[1]]).map(tran): coords; };
    const decodedArcs = (arcs||[]).map(decodePoints);
    const getCoords = arcs => { let coords = [];
        arcs.forEach((idx, i) => {
            let arc = decodedArcs[idx < 0 ? ~idx : idx];
            if (idx < 0) arc = [...arc].reverse();
            if (i > 0) arc = arc.slice(1);
            coords = coords.concat(arc);
        });
        return coords;
    };
    const geom = g => {
        switch (g.type) {
            case "Point": return { type, coordinates: tran(g.coordinates)};
            case "MultiPoint": return { type, coordinates: decodePoints(g.coordinates)};
            case "LineString": return { type, coordinates: getCoords(g.arcs)};
            case "MultiLineString": return { type, coordinates: g.arcs.map(getCoords)};
            case "Polygon": return { type, coordinates: g.arcs.map(getCoords)};
            case "MultiPolygon": return { type, coordinates: g.arcs.map(t => t.map(getCoords))};
            case "GeometryCollection": return { type, geometries: g.geometries.map(geom)};
        }
    }
    const toFeature = g => {
        const f = { type: "Feature", geometry: geom(g), properties: g.properties || {} };
        (g.id === undefined) || (f.id = g.id);
        return f;
    };
    const features = [];
    for (const key in objects) {
        const obj = objects[key];
        if (obj.type === "GeometryCollection") {
            obj.geometries.forEach(t=> features.push(toFeature(t)));
        } else {
            features.push(toFeature(obj));
        }
    }
    return { type: "FeatureCollection", features };
}
````

## File: src/index.js
````javascript
import { GeoPBF } from "./pbf.js";
import { pbfio } from "./pbf-io.js";
import { topo2geo } from "./modules/topo2geo.js";
import { gunzip, isGzip } from "native-bucket";
import { isString, isURL, isFile, isObject, isBuffer } from "common"
//const console = new Logger();
let server = null;
const getServer = async () => {
    server = server || pbfio("GIS").catch(e => { console.warn("PBFIO initialization failed.", e); return null; });
    return server;
}
//  ----------------------------------------------------------------------------------------
export async function geopbf(data, options = {}) { if (isString(options)) options = { name: options };
    const dt = performance.now();
    const isInZip = _ => (isString(_) && _.match(/.+\.zip#.+/i));
    const isPBF = _ => (_ instanceof GeoPBF);
    let eventTarget = options.eventTarget || (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
    if (typeof CustomEvent === 'undefined' || !eventTarget.dispatchEvent) eventTarget = null;
    const throwEvent = (type, detail) => eventTarget && eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
    const decoder = async (type, file) => {
        const name = file.name, event = `convrsion from ${type} to GeoPBF`;
        throwEvent("ConvertStart",{name, event});
        const encoding = (options.encoding || "utf8").toLowerCase().replace(/[\-\_]/g, "").replace(/shiftjis/, "sjis");
        const params = { file, precision: options.precision || 6, encoding, };
        const url = new URL(`./decoder/${type}.js`, import.meta.url);
        const w = new Worker(url, { type: 'module' });
        return new Promise(resolve => {
            w.onmessage = async e => {
                throwEvent("ConvertEnd", { name, event });
                w.terminate(); resolve(e.data ? new GeoPBF(options).set(e.data.data) : null); };
            w.onerror = e => {
                throwEvent("ConvertEnd", { name, error: `file decode error: [${type}]` });
                w.terminate(); console.error(`file decode error: [${type}]`); resolve(null);
            };
            w.postMessage(params);
        });
    };
    const pbf = await _geopbf(data);
    pbf && console.log(`[geopbf] 📥 ${pbf.name()} (${pbf.size.toLocaleString()} bytes) ${(performance.now()-dt).toFixed(2)} msec`);
    pbf && isInZip(data) && getServer().then(server => server && server.cache(data, { Buff: pbf.arrayBuffer }));
    return pbf || new GeoPBF(options);
////===========================================================================================
    async function _geopbf(q) {
        if (!q) return null;
        if (isPBF(q)) return q;
        if (isBuffer(q)) return new GeoPBF(options).set(q);
        if (isFile(q)) {
            if (await isGzip(q)) return _geopbf(await gunzip(q));
            const name = q.name;
            options.name = options.name || name.replace(/\.[^\.]+$/, "");
            if (name.match(/\.(geo)?pbf$/i)) return _geopbf(await q.arrayBuffer());
            if (name.match(/\.(geo|topo)?json$/i)) return _geopbf(await decoder("json", q));
            if (name.match(/\.zip$/i)) return _geopbf(await decoder("shape", q));
            if (name.match(/\.kmz$/i)) return _geopbf(await decoder("kmz", q));
            if (name.match(/\.gpx$/i)) return _geopbf(await decoder("gpx", q));
            if (name.match(/\.(gml|xml)$/i)) return _geopbf(await decoder("gml", q));
            if (name.match(/\.gz(ip)?$/i)) return _geopbf(await gunzip(q));
            console.warn("illegal file:", name);
        }
        if (isObject(q)) {
            q = toFeatureCollection(q);
            return (q && q.features.length > 0) ? await new GeoPBF(options).set(q) : null;
        }
        const server = await getServer();
        if (isString(q) && server) {
            const usecache = !options.nocache;
            if (isURL(q)) {
                const fetchUrl = isInZip(q) ? q : (q.match(/\.zip$/) && options.target) ? [q, options.target].join("#") : q;
                const v = await server.cache(fetchUrl);
                if (v) return new GeoPBF(options).set(v.Buff);
                return _geopbf(await server.fetch(fetchUrl));
            }
            return _geopbf(await server.load(q));
        }
        return null;
        async function file2json(file) {
            const json = toFeatureCollection(JSON.parse(await file.text()));
            json.name = file.name.split("/").reverse()[0].replace(/\.[^\.]+$/, "");
            return json;
        }
        function toFeatureCollection(q) {
            const fc = a => ({ type: "FeatureCollection", features: a });
            const f = g => ({ type: "Feature", geometry: g, properties: {} });
            return Array.isArray(q) ? fc(q.filter(t => isObject(t) && t.type == "Feature")) :
                (q.type == "Topology") ? topo2geo(q) :
                (q.type == "FeatureCollection") ? q :
                (q.type == "Feature") ? fc([q]) :
                (q.type == "GeometryCollection") ? fc(q.map(f)) : fc([]);
        }
    }
}
//  ----------------------------------------------------------------------------------------
const encoder = async (pbf, type, gz, encoding) => {
    const name = pbf._name, buf = pbf.arrayBuffer, event = `convrsion from GeoPBF to ${type}`;
    const throwEvent = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));
    throwEvent("ConvertStart", { name, event });
    const url = new URL(`./encoder/${type}.js`, import.meta.url)
    const w = new Worker(url, { type: 'module' });
    return new Promise(resolve => {
        w.onmessage = e => {
            throwEvent("ConvertEnd", { name, event });
            w.terminate(); resolve(e.data);
        };
        w.onerror = () => {
            throwEvent("ConvertEnd", { name, error: `file encode error: [${type}]` });
            w.terminate(); console.error(`pbf encode error: [${type}]`); resolve(null);
        };
        w.postMessage({ buf, name, gz, encoding }, [buf]);
    });
};
const methods = {
    async save() { const s = await getServer(); return (s && await s.save(this)) ? this : null; },
    async geopbfFile() { return encoder(this, "geopbf", true); },
    async geojsonFile(flag = false) { return flag !=="cancel" && encoder(this, "geojson", flag); },
    async topojsonFile(flag = false) { return encoder(this, "topojson", flag); },
    async shapeFile(encoding = "utf8") { return encoder(this, "shape", false, encoding); },
    async kmzFile(flag = true) { return encoder(this, "kmz", flag); },//flag: true=>kmz, false=>kml
    async gpxFile(flag) { return encoder(this, "gpx", flag); },
    async gmlFile(flag) { return encoder(this, "gml", flag); },
 //   async fgbFile(flag) { return encoder(this, "fgb", flag); }, 
};

Object.entries(methods).forEach(([name, func]) => {
    Object.defineProperty(GeoPBF.prototype, name, { value: func, configurable: false, enumerable: false });
});
````

## File: src/pbf-base.js
````javascript
import Pbf from 'pbf';
import { bufferTub, readBufs } from "./modules/bufferTub.js";
import { isSimpleObject, isNumber, isFloat, isBbox } from "common";
import { cleanCoords, antimeridianFeature, loadPolygonClipping } from "common";

const TAGS = { NAME: 1, KEYS: 2, PRECISION: 3, BUFS: 4, FARRAY: 5, FEATURE: 6, GEOMETRY: 7, GTYPE: 8, LENGTH: 9, COORDS: 10, VALUE: 11, INDEX: 12, GARRAY: 13, DESCRIPTION: 14, LICENSE: 15 };
const geometryTypes = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"];
const geometryMap = {}; geometryTypes.forEach((t, i) => geometryMap[t] = i);
const dataTypeNames = ["NULL", "BOOL", "INTEGER", "FLOAT", "STRING", "DATE", "COLOR", "FUNC", "JSON", "BBOX", "BLOB", "IMAGE"];
const DATATYPE = {}; dataTypeNames.map((s, i) => DATATYPE[s] = i); DATATYPE.UNKNOWN = -1;

class GeoPBF {
    constructor(options = {}) {
        this.pbf = new Pbf();
        this._name = options.name || "";
        this._description = options.description || "";
        this._license = options.license || "";
        this.e = Math.pow(10, this._precision = options.precision || 6);
        this.noprop = !!options.noprop;
        this.keys = [], this.bufs = [], this.fmap = [], this.bin = {}; this.props = [];
    }

    name(s) { if (s === undefined) return this._name; this._name = s; return this; }
    description(s) { if (s === undefined) return this._description; this._description = s; return this; }
    license(s) { if (s === undefined) return this._license; this._license = s; return this; }
    precision(s) { if (s === undefined) return this._precision; this.e = Math.pow(10, this._precision = s); return this; }
    init() { this.keys = [], this.bufs = [], this.fmap = [], this.bin = {}; this.props = []; delete this.end; delete this.ctx; delete this.proj; return this; }
    empty() { this.pbf = new Pbf(); this.init(); this.name(""); return this; }

    async set(q) {
        await loadPolygonClipping();
        if (q instanceof ArrayBuffer || ArrayBuffer.isView(q)) this.pbf = new Pbf(q);
        else if (isSimpleObject(q)) {
            const [keys, buffs] = this.noprop ? [[], []] : await makeKeys(q.features.map(t => t.properties));
            this.setHead(keys, buffs, { name: q.name }).setBody(q).close();
        } else return (console.error("PBF set: setting illegal value", q), this);
        return await this.getPosition();
    }

    async getPosition() {
        this.init();
        const pbf = this.pbf, keys = this.keys, fmap = this.fmap, props = this.props;
        const bufsReader = new readBufs();
        let pos = 0;
        pbf.readFields(tag => {
            if (tag === TAGS.NAME) this.name(pbf.readString());
            else if (tag === TAGS.DESCRIPTION) this.description(pbf.readString());
            else if (tag === TAGS.LICENSE) this.license(pbf.readString());
            else if (tag === TAGS.KEYS) keys.push(pbf.readString());
            else if (tag === TAGS.BUFS) bufsReader.set(pbf.readBytes());
            else if (tag === TAGS.PRECISION) this.e = Math.pow(10, this._precision = pbf.readVarint());
            else if (tag === TAGS.FARRAY) pos = pbf.pos;
        });
        this.bufs = await bufsReader.close();
        this.end = pbf.pos;
        if (!pos) return this;
        this.bodyPos = pos;
        pbf.pos = pos;
        pbf.readMessage(tag => {
            if (tag !== TAGS.FEATURE) return;
            var fpos, gpos, type, garray = [], tarray = [];
            const values = [], q = new Array(keys.length);
            fpos = pbf.pos;
            pbf.readMessage(ftag => {
                if (ftag === TAGS.GEOMETRY) {
                    gpos = pbf.pos;
                    pbf.readMessage(gtag => {
                        if (gtag === TAGS.GTYPE) type = pbf.readVarint();
                        else if (gtag === TAGS.GARRAY) pbf.readMessage(gatag => {
                            if (gatag === TAGS.GEOMETRY) {
                                garray.push(pbf.pos);
                                pbf.readMessage(gaatag => (gaatag === TAGS.GTYPE) && tarray.push(pbf.readVarint()));
                            }
                        });
                    });
                } else if (ftag === TAGS.VALUE) { pbf.readVarint(); values.push(readValue(this)); }
                else if (ftag === TAGS.INDEX) {
                    const end = pbf.readVarint() + pbf.pos; let vpos = 0;
                    while (pbf.pos < end) q[pbf.readVarint()] = values[vpos++];
                }
            });
            fmap.push(type == 6 ? [fpos, gpos, type, garray, tarray] : [fpos, gpos, type]);
            props.push(q);
        });
        return this;
    }

    get size() { return this.end; }
    get length() { return (this.fmap || []).length; }
    each(func) { return (this.fmap || []).map((t, i) => func(i, t, this.getProperties(i))); }

    setMessage(tag, func) { this.pbf.writeMessage(tag, func); return this; }

    setHead(keys, bufs, meta = {}) {
        if (meta.name !== undefined) this._name = meta.name;
        if (meta.description !== undefined) this._description = meta.description;
        if (meta.license !== undefined) this._license = meta.license;
        if (meta.precision !== undefined) this.precision(meta.precision);

        this.keys = keys || this.keys;
        this.bufs = bufs || this.bufs || [];
        this.keytub = {};

        this._name && this.pbf.writeStringField(TAGS.NAME, this._name);
        this._description && this.pbf.writeStringField(TAGS.DESCRIPTION, this._description);
        this._license && this.pbf.writeStringField(TAGS.LICENSE, this._license);
        this._precision == 6 || this.pbf.writeVarintField(TAGS.PRECISION, this._precision);
        this.keys.forEach((t, i) => { this.pbf.writeStringField(TAGS.KEYS, t); this.keytub[t] = i; });
        this.bufs.forEach((t, i) => { this.pbf.writeBytesField(TAGS.BUFS, new Uint8Array(t)) });
        return this;
    }

    setBody(obj) {
        const func = (obj instanceof Function) ? obj : () => obj.features.forEach(t => this.setFeature(t))
        return this.setMessage(TAGS.FARRAY, func);
    }
    setFeature(q) {
        antimeridianFeature(q);
        return this.setMessage(TAGS.FEATURE, () => this.setGeometry(q.geometry).setProperties(q.properties));
    }
    setGeometry(q) { return writeGeometry(this, q); }
    setProperties(q) { return writeProperties(this, q); }
    close() { this.end = this.pbf.pos; this.pbf.finish(); return this; }

    getFeature(i) { return { type: "Feature", geometry: this.getGeometry(i), properties: this.getProperties(i) }; }
    getGeometry(i, j) { return readGeometry(this, i, j); }
    getProperties(i) { return readProperties(this, i); }
    getType(i) { return i === undefined ? this.each(i => this.getType(i)) : geometryTypes[this.fmap[i][2]]; }

    getBbox(i) {
        if (i !== undefined) {
            if (this._bboxes && this._bboxes[i]) return this._bboxes[i];
            let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
            const calcBbox = c => {
                if (!c || !Array.isArray(c)) return;
                if (typeof c[0] === 'number') {
                    if (c[0] < xmin) xmin = c[0]; if (c[0] > xmax) xmax = c[0];
                    if (c[1] < ymin) ymin = c[1]; if (c[1] > ymax) ymax = c[1];
                } else c.forEach(calcBbox);
            };
            const geom = this.getGeometry(i);
            (geom.type == "GeometryCollection") ? geom.geometries.forEach(t => calcBbox(t.coordinates)) : calcBbox(geom.coordinates);
            const res = [xmin, ymin, xmax, ymax].map(v => Math.round(v * this.e) / this.e);
            if (this._bboxes) this._bboxes[i] = res;
            return res;
        }
        if (this._bbox) return this._bboxes;
        let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
        this._bboxes = this.each(idx => {
            const b = this.getBbox(idx);
            if (isBbox(b)) {
                if (b[0] < xmin) xmin = b[0]; if (b[1] < ymin) ymin = b[1];
                if (b[2] > xmax) xmax = b[2]; if (b[3] > ymax) ymax = b[3];
            }
            return b;
        });
        this._bbox = [xmin, ymin, xmax, ymax];
        return this._bboxes;
    }

    get bboxes() { return this._bboxes || (this.getBbox(), this._bboxes); }
    get bbox() { return this._bbox || (this.getBbox(), this._bbox); }

    getGeometryBuffer(i, j) {
        const map = this.fmap[i];
        const pos = this.pbf.pos = (map[2] == 6 && j !== undefined) ? map[3][j] : map[1], len = this.pbf.readVarint();
        var n = len < 128 ? 1 : len < 16384 ? 2 : len < 2097152 ? 3 : 4;
        return this.pbf.buf.slice(pos - 1, pos + len + n);
    }
    setGeometryBuffer(a) { this.pbf.realloc(a.length); this.pbf.buf.set(a, this.pbf.pos); this.pbf.pos += a.length; return this; }
    copyGeometry(pbf, i) { this.setGeometryBuffer(pbf.getGeometryBuffer(i)) }
    copyProperties(pbf, i) { this.setProperties(pbf.getProperties(i)) }
    copyHead(pbf) { return this.setHead(pbf.keys, pbf.bufs); }
    get features() { return this.each(i => this.getFeature(i)); }
    get geometries() { return this.each(i => this.getGeometry(i)); }
    get properties() { return this.each(i => this.getProperties(i)); }
    get propertiesTable() { return [this.keys].concat(this.props); }
    get arrayBuffer() { return this.pbf.buf.buffer.slice(0, this.end); }
    get geojson() { return { type: "FeatureCollection", features: this.features, name: this.name() }; }

    updateHeader(meta = {}) {
        const oldBodyPos = this.bodyPos;
        const bodyData = this.pbf.buf.subarray(oldBodyPos, this.end);
        this.pbf = new Pbf();
        this.setHead(this.keys, this.bufs, meta);
        this.pbf.writeVarint(TAGS.FARRAY << 3 | 2);
        this.pbf.writeVarint(bodyData.length);
        const newBodyPos = this.pbf.pos;
        this.pbf.writeBytes(bodyData);
        this.close();
        const diff = newBodyPos - oldBodyPos;
        if (this.fmap && diff !== 0) {
            this.fmap.forEach(f => {
                f[0] += diff; f[1] += diff;
                if (f[2] === 6 && f[3]) f[3] = f[3].map(p => p + diff);
            });
        }
        this.bodyPos = newBodyPos;
        return this;
    }

    static async update(buffer, meta = {}) {
        const pbf = new Pbf(new Uint8Array(buffer));
        const head = { keys: [], bufs: [], precision: 6 };
        let bodyPos = -1;
        while (pbf.pos < pbf.length) {
            const val = pbf.readVarint(), tag = val >> 3;
            if (tag === TAGS.FARRAY) { pbf.readVarint(); bodyPos = pbf.pos; break; }
            if (tag === TAGS.NAME) head.name = pbf.readString();
            else if (tag === TAGS.DESCRIPTION) head.description = pbf.readString();
            else if (tag === TAGS.LICENSE) head.license = pbf.readString();
            else if (tag === TAGS.KEYS) head.keys.push(pbf.readString());
            else if (tag === TAGS.BUFS) head.bufs.push(pbf.readBytes());
            else if (tag === TAGS.PRECISION) head.precision = pbf.readVarint();
            else pbf.skip(val);
        }
        const out = new GeoPBF();
        out.setHead(head.keys, head.bufs, Object.assign(head, meta));
        out.pbf.writeVarint(TAGS.FARRAY << 3 | 2);
        const bodyData = new Uint8Array(buffer).subarray(bodyPos);
        out.pbf.writeVarint(bodyData.length);
        out.pbf.writeBytes(bodyData);
        return out.close().arrayBuffer;
    }
}

async function makeKeys(q) {
    const tub = {}, buffs = new bufferTub();
    for (let i = 0; i < q.length; i++) {
        const item = q[i];
        if (!isSimpleObject(item)) continue;
        for (let key in item) {
            const v = item[key]; tub[key] = true;
            if (v instanceof Blob) item[key].id = buffs.set(await v.arrayBuffer());
            else if (v instanceof ImageData) item[key].id = buffs.set(v.data.buffer);
            else if (isSimpleObject(v)) {
                for (let k in v) {
                    const u = v[k]; tub[`${key}.${k}`] = true;
                    if (u instanceof Blob) u.id = buffs.set(await u.arrayBuffer());
                    if (u instanceof ImageData) u.id = buffs.set(u.data.buffer);
                }
            }
        }
    }
    return [Object.keys(tub).sort(), await buffs.close()];
}

function dataType(q) {
    const isColor = s => s.trim().match(/^rgba?\s*\([0-9,\.\s]+\)$/) || s.trim().match(/^\#[0-9a-f]{3,6}$/);
    if (q == null) return DATATYPE.NULL;
    const type = typeof q;
    if (type === "string") return isColor(q) ? DATATYPE.COLOR : DATATYPE.STRING;
    else if (type === "number") return isFloat(q) ? DATATYPE.FLOAT : DATATYPE.INTEGER;
    else if (type === "boolean") return DATATYPE.BOOL;
    else if (type === "function") return DATATYPE.FUNC;
    else if (q instanceof Date) return DATATYPE.DATE;
    else if (q instanceof Blob) return DATATYPE.BLOB;
    else if (q instanceof ImageData) return DATATYPE.IMAGE;
    else if (type === "object") return isBbox(q) ? DATATYPE.BBOX : DATATYPE.JSON;
    return DATATYPE.UNKNOWN;
}

function writeValue(self, q) {
    const { pbf } = self;
    if (q == null || q == undefined) return;
    const type = dataType(q)
    switch (type) {
        case DATATYPE.STRING: return pbf.writeStringField(type, q)
        case DATATYPE.FLOAT: return pbf.writeDoubleField(type, q);
        case DATATYPE.INTEGER: return pbf.writeSVarintField(type, q);
        case DATATYPE.BOOL: return pbf.writeBooleanField(type, q);
        case DATATYPE.JSON: return pbf.writeStringField(type, JSON.stringify(q));
        case DATATYPE.BLOB: return pbf.writeStringField(type, [q.name || "", q.type || "", q.id].join(":"));
        case DATATYPE.FUNC: return pbf.writeStringField(type, q.toString());
        case DATATYPE.IMAGE: return pbf.writeStringField(type, [q.width, q.height, q.id].join(":"));
        case DATATYPE.DATE: return pbf.writeSVarintField(type, Math.round(+q / 1000));
        case DATATYPE.BBOX: return pbf.writePackedDouble(type, q);
        case DATATYPE.COLOR: return pbf.writeBytesField(type, color(q));
    }
    function color(s) {
        s = s.replace(/\s/g, ""); var r;
        r = s.match(/^rgba\((\d+),(\d+),(\d+),([\d\.]+)\)$/); if (r) return [+r[1], +r[2], +r[3], ~~(+r[4] * 255)];
        r = s.match(/^rgb\((\d+),(\d+),(\d+)\)$/); if (r) return [+r[1], +r[2], +r[3], 255];
        r = s.match(/^\#[0-9a-f]{6}$/); if (r) return [parseInt(s.substring(1, 3), 16), parseInt(s.substring(3, 5), 16), parseInt(s.substring(5, 7), 16), 255];
        r = s.match(/^\#[0-9a-f]{3}$/); if (r) return [parseInt(s.substring(1, 2), 16) * 16, parseInt(s.substring(2, 3), 16) * 16, parseInt(s.substring(3, 4), 16) * 16, 255];
        return [0, 0, 0, 0];
    }
}

function readValue(self) {
    const { pbf, bufs, bin } = self;
    switch (pbf.readVarint() >> 3) {
        case DATATYPE.STRING: return pbf.readString();
        case DATATYPE.FLOAT: return pbf.readDouble();
        case DATATYPE.INTEGER: return pbf.readSVarint();
        case DATATYPE.BOOL: return pbf.readBoolean();
        case DATATYPE.JSON: return JSON.parse(pbf.readString());
        case DATATYPE.BLOB: return blob(pbf.readString());
        case DATATYPE.FUNC: return new Function(`return ${pbf.readString()}`);
        case DATATYPE.IMAGE: return image(pbf.readString());
        case DATATYPE.DATE: return new Date(pbf.readSVarint() * 1000);
        case DATATYPE.BBOX: return new Float32Array(pbf.readPackedDouble());
        case DATATYPE.COLOR: return color(pbf.readBytes());;
    }
    return null;
    function color(a) { return a.length == 3 || a[3] == 255 ? `rgb(${a[0]},${a[1]},${a[2]})` : `rgba(${a[0]},${a[1]},${a[2]},${(a[3] / 255).toFixed(2)})`; }
    function blob(s) {
        if (s in bin) return bin[s];
        const [name, type, id] = s.split(":"), buf = bufs[+id];
        return bin[s] = name ? new File([buf], name, { type }) : new Blob([buf], { type });
    }
    function image(s) {
        if (s in bin) return bin[s];
        const [width, height, id] = s.split(":").map(t => +t);
        return bin[s] = new ImageData(new Uint8ClampedArray(bufs[id]), width, height);
    }
}

function writeProperties(self, q) {
    const { pbf, keytub } = self;
    var index = []; if (self.noprop) return
    for (var key in q) if (q[key] != null) {
        var v = q[key];
        if (isSimpleObject(v) && Object.keys(v).every(k => `${key}.${k}` in keytub)) {
            for (let k in v) if (v[k] != null) { pbf.writeMessage(TAGS.VALUE, () => writeValue(self, v[k])); index.push(keytub[`${key}.${k}`]); }
        } else { pbf.writeMessage(TAGS.VALUE, () => writeValue(self, v)); index.push(keytub[key]); }
    }
    pbf.writePackedVarint(TAGS.INDEX, index);
}

function readProperties(self, n) {
    const { keys, props } = self, q = {};
    props[n].forEach((v, i) => {
        const key = keys[i].split(/\./);
        if (key.length == 1) q[key[0]] = v;
        else { q[key[0]] = q[key[0]] || {}; q[key[0]][key.slice(1).join(".")] = v; }
    });
    return q;
}

function writeGeometry(self, q) {
    const { pbf, e } = self;
    return self.setMessage(TAGS.GEOMETRY, () => {
        const fix = n => { while (n < -180) n += 360; while (n > 180) n -= 360; return n; };
        const type = geometryMap[q.type];
        if (type == null) return console.error("illegal geometry type: ", q.type);
        pbf.writeVarintField(TAGS.GTYPE, type);
        if (type == 6) return pbf.writeMessage(TAGS.GARRAY, () => q.geometries.forEach(t => writeGeometry(self, t)));
        let c = q.coordinates;
        [write0, write1, write1, write2, write2, write3][type]();
        pbf.writePackedSVarint(TAGS.COORDS, c.flat(Infinity));
        function len2() { return c.map(t => t.length); }
        function len3() { const l = [c.length]; c.forEach(t => { l.push(t.length); t.forEach(u => l.push(u.length)); }); return l; }
        function write0() { c = [Math.round(fix(c[0]) * e), Math.round(c[1] * e)]; }
        function write1() { c = diff(c); }
        function write2() { c = c.map(diff); pbf.writePackedVarint(TAGS.LENGTH, len2()); }
        function write3() { c = c.map(t => t.map(diff)); pbf.writePackedVarint(TAGS.LENGTH, len3()); }
        function diff(line) {
            if (!line || !line.length) return [];
            let sum = [0, 0], src = [], p = [];
            for (let i = 0, len = line.length; i < len; i++) {
                let x = Math.round(fix(line[i][0]) * e), y = Math.round(line[i][1] * e);
                if (src.length > 0 && src[src.length - 1][0] === x && src[src.length - 1][1] === y) continue;
                src.push([x, y]);
            }
            if (type > 3 && src.length >= 3) src = cleanCoords(src);
            for (let i = 0; i < src.length; i++) {
                let t = src[i]; p.push([t[0] - sum[0], t[1] - sum[1]]);
                sum[0] = t[0]; sum[1] = t[1];
            }
            if (type > 3 && p.length > 0) p.pop();
            return p;
        }
    });
}

function readGeometry(self, n, m) {
    const { pbf, fmap, e } = self, map = fmap[n];
    return (map[2] < 6) ? read(map[1], map[2]) : m !== undefined ? read(map[3][m], map[4][m]) : { type: geometryTypes[6], geometries: map[3].map((t, i) => read(t, map[4][i])) };
    function read(pos, type) {
        pbf.pos = pos;
        var q = { type: geometryTypes[type] }, isPoly = type > 3, lens = [], end;
        const funcs = [read0, read1, read1, read2, read2, read3][type];
        return pbf.readMessage((tag, q) => {
            if (tag === TAGS.LENGTH) pbf.readPackedVarint(lens);
            else if (tag === TAGS.COORDS) { end = pbf.readVarint() + pbf.pos; q.coordinates = funcs(); }
        }, q);
        function readCoords(p) { p = p || [0, 0]; p[0] += pbf.readSVarint(); p[1] += pbf.readSVarint(); return p; }
        function magCoords(p) { return [p[0] / e, p[1] / e]; }
        function read_n(n) { var c = [], p = [0, 0]; while (n-- > 0) c.push(magCoords(p = readCoords(p))); isPoly && c.push(c[0]); return c; }
        function read0() { return magCoords(readCoords()); }
        function read1() { var c = [], p = [0, 0]; while (pbf.pos < end) c.push(magCoords(readCoords(p))); return c; }
        function read2() { return lens.map(t => read_n(t)); }
        function read3() { const c = []; let pos = 0; for (var i = 0; i < lens[0]; i++) { var n = lens[++pos]; c[i] = []; for (var j = 0; j < n; j++) c[i].push(read_n(lens[++pos])); } return c; }
    }
}

const setProp = (obj, name, value) => { if (typeof name == "string") { (name in obj) || Object.defineProperty(obj, name, { value, configurable: false, enumerable: false }); } else Object.entries(name).map(t => setProp(obj, ...t)) }
setProp(GeoPBF, { TAGS, makeKeys, dataType, dataTypeNames, geometryTypes, geometryMap });
export { GeoPBF };
````

## File: src/pbf-io.js
````javascript
import { GeoPBF } from "./pbf-base.js";
import { gzip, gunzip, isGzip } from "native-bucket";

class PBFIO {
    constructor(dire) { this.dire = dire || "GIS"; }
    async open() {
        const { nativeBucket } = await import("native-bucket")
            .catch(e => { console.error("native-bucket load error", e); return {}; });
        const { Bucket, Cache, Fetch } = nativeBucket();
        this.bucket = await Bucket(`${this.dire}/pbf`);
        this.cache = await Cache(`${this.dire}/pbf`);
        this.nativeFetch = Fetch;
        return this;
    }
    async files() { return await this.bucket.list(); }
    async sync() {
        const localKeys = (await this.cache()) || []; if (localKeys.length === 0) return;
        await Promise.all(localKeys.map(async (name) => {
            try {
                const val = await this.cache(name); if (!val.etag) return; 
                console.log(` 🔄 Syncing ${name} ...`);
                const res = await fetch(`${this.bucket.url}${name}`, { cache: 'default' });
                if (res.ok) {
                    const ETag = res.headers.get("etag"); if (ETag == val.ETag) return;
                    const Buff = await gunzip(await res.blob()).arrayBuffer();
                    await this.cache(name, { ETag, Buff });
                }
            } catch (e) { console.error(`Sync failed:`, e); }
        }));
        console.log(" ✅ Sync complete.");
    }
    async fetch(name, useCache = false) {
        if (useCache && this.fetchCache) { const v = await this.fetchCache(name); if (v) return v; }
        const [url, target] = name.split(/\#/);
        const file = target ? await this.nativeFetch(url, { target }) : await this.nativeFetch(url);
        if (this.fetchCache) await this.fetchCache(name, file);
        return file;
    }
    async load(name) {
        const val = await this.cache(name).catch(console.error);
        try {
            const res = await fetch(`${this.bucket.url}${name}`, { cache: 'default' });
            if (!res.ok) throw new Error(`Failed to fetch: ${name} (HTTP ${res.status})`);
            const ETag = res.headers.get("etag");
            if (val && val.ETag === ETag)  return new GeoPBF({name}).set(val.Buff);
            const blob = await gunzip(await res.blob());
            const Buff = await blob.arrayBuffer();
            await this.cache(name, { ETag, Buff });
            return new GeoPBF().set(Buff);
        } catch (e) {
            if (val && val.Buff) {
                console.warn(e);
                return new GeoPBF().set(val.Buff);
            }
            console.error(`[Fetch Error]`, e);
        }
    }
    async save(pbf) {
        const name = pbf.name(); if (!name) return null;
        const file = new File([pbf.arrayBuffer], pbf._name, { type: "application/x-geopbf" });
        await this.bucket.put(file);
        const ETag = await this.bucket.etag(name);
        await this.cache(name, { ETag, Buff: pbf.arrayBuffer });
        return name;
    }
    async delete(name) {
        await this.bucket.del(name);
        await this.cache(name, null);
        return name;
    }
}
export async function pbfio(dire) { return new PBFIO(dire).open(); }
````

## File: src/pbf.js
````javascript
import { GeoPBF } from "./pbf-base.js";
import * as spatial from "./extension/spatial.js";
import * as manipulate from "./extension/manipulate.js";
import { nearPoint } from "./extension/nearPoint.js";
import { contain } from "./extension/contain.js";
import { dissolve } from "./extension/dissolve.js";
import { analyzeTopology, neighbors, mesh, merge } from "./extension/topology.js"; // 変更
import { toTopoJSON } from "./extension/topojson.js";
import { drawGeometry, view } from "./extension/view.js";

const setGetter = (name, func) => { Object.defineProperty(GeoPBF.prototype, name, { get: func, configurable: false, enumerable: false }); };
const setPrototype = (name, func) => { Object.defineProperty(GeoPBF.prototype, name, { value: func, configurable: false, enumerable: false }); };
Object.defineProperty(GeoPBF, 'update', { value: manipulate.update, configurable: false, enumerable: false });
Object.defineProperty(GeoPBF, 'concatinate', { value: manipulate.concatinate, configurable: false, enumerable: false });

setGetter("count", function () { return manipulate.count(this); });
setGetter("lint", function () { return manipulate.lint(this); });

setPrototype("centroid", function (i) { return spatial.centroid(this, i); });
setPrototype("area", function (i) { return spatial.area(this, i); });
setPrototype("contain", function (pt, one) { return contain(this, pt, one); });
setPrototype("nearPoint", function (pt, count, dist) { return nearPoint(this, pt, count, dist); });

setPrototype("clone", function (opt) { return manipulate.clone(this, opt); });
setPrototype("rename", function (name) { return manipulate.clone(this, { name }); });
setPrototype("filter", function (f) { return manipulate.clone(this, { filter: f }); });
setPrototype("map", function (m) { return manipulate.clone(this, { map: m }); });
setPrototype("classify", function (k) { return manipulate.classify(this, k); });
setPrototype("header", function (meta) { return manipulate.header(this, meta); });
setPrototype("concat", function (...args) { return manipulate.concatinate([this, ...args], this.name()); });
setPrototype("dissolve", function (p) { return dissolve(this, p); });

setPrototype("analyzeTopology", function () { return analyzeTopology(this); });
setPrototype("neighbors", function (id) { return neighbors(this, id); });
setPrototype("mesh", function (f) { return mesh(this, f); });   // 追加
setPrototype("merge", function (f) { return merge(this, f); }); // 追加
setGetter("topojson", function () { return toTopoJSON(this); });

setPrototype("drawGeometry", function (n) { return drawGeometry(this, n); });
setPrototype("context", function (ctx, proj) { this.ctx = ctx; this.proj = proj; return this; });
setPrototype("view", function (canvas, props) { return view(this, canvas, props); });

export { GeoPBF };
````

## File: .gitignore
````
# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

node_modules
dist
dist-ssr
*.local

# Editor directories and files
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?
````

## File: package.json
````json
{
	"name": "geopbf",
	"version": "1.0.0",
	"type": "module",
	"main": "src/index.js",
	"exports": {
		".": "./src/index.js",
		"./*": "./*"
	},
	"scripts": {
		"summary": "repomix --style markdown --output gemini_input.md"
	},
	"dependencies": {
		"pbf": "^4.0.1",
		"repomix": "^1.0.0",
		"native-bucket": "*"
	}
}
````

## File: pbf spec.md
````markdown
# GeoPBF File Format Specification (v1.0)

GeoPBF is an optimized binary format for geospatial data, built upon Google's Protocol Buffers (PBF) architecture. It combines the efficiency of Protobuf with specific optimizations for geographic information, such as coordinate delta-encoding, attribute key-value indexing, and advanced topological management via Morton codes.

---

## 1. High-Level Structure

A GeoPBF file consists of two primary sections: the **Header Section** and the **Body Section**.

### 1.1 Header Section

The header contains metadata, global dictionaries for property keys, and binary data pools.

| Tag | Field Name  | Protobuf Type | Description |
| :--- | :--- | :--- | :--- |
| 1 | `NAME` | String | The name of the dataset. |
| 14 | `DESCRIPTION` | String | A brief summary of the data content. |
| 15 | `LICENSE` | String | Licensing or copyright information. |
| 3 | `PRECISION` | Varint | Floating point precision ($10^n$). Default is 6 ($10^{-6}$ deg). |
| 2 | `KEYS` | Repeated String | Global dictionary of property names. |
| 4 | `BUFS` | Repeated Bytes | A pool for binary data like Blobs or raw pixel data. |

### 1.2 Body Section (FARRAY)

The body is a single container field that holds an array of Features.

| Tag | Field Name | Protobuf Type | Description |
| :--- | :--- | :--- | :--- |
| 5 | `FARRAY` | Message | Encapsulates the array of Feature messages. |

---

## 2. Feature Structure (Tag 6)

Each Feature contains its geometry and associated properties.

### 2.1 Geometry Message (Tag 7)

Coordinates are stored as integers (after applying the precision multiplier) and are delta-encoded to minimize storage.

| Tag | Field Name | Protobuf Type | Description |
| :--- | :--- | :--- | :--- |
| 8 | `GTYPE` | Varint | Geometry type: 0:Point, 1:MPoint, 2:Line, 3:MLine, 4:Poly, 5:MPoly, 6:GCollection. |
| 9 | `LENGTH` | Packed Varint | Vertex counts for rings or multi-part geometries. |
| 10 | `COORDS` | Packed SVarint | Delta-encoded coordinates ($X_0, Y_0, \Delta X_1, \Delta Y_1, ...$). |
| 13 | `GARRAY` | Repeated Message | Nested Geometry messages for `GeometryCollection`. |

### 2.2 Property Encoding (Tags 11, 12)

Properties are encoded using a separate key-index system to avoid redundant strings.

* **Tag 12 (`INDEX`)**: A `Packed Varint` pointing to the indices in the global `KEYS` array.
* **Tag 11 (`VALUE`)**: A `Repeated Message` containing the actual data, tagged by its type.

#### Supported Data Types (Internal Tag 11)

| Type ID | Name | Format |
| :--- | :--- | :--- |
| 0 | `NULL` | None |
| 1 | `BOOL` | Boolean |
| 2 | `INTEGER` | SVarint |
| 3 | `FLOAT` | Double |
| 4 | `STRING` | String |
| 5 | `DATE` | SVarint (Unix Timestamp / 1000) |
| 6 | `COLOR` | Bytes (RGBA 4-byte array) |
| 8 | `JSON` | String (JSON-serialized object) |
| 9 | `BBOX` | Packed Double (4 values) |
| 10 | `BLOB` | String metadata (`Name:Mime:ID`) pointing to `BUFS` |
| 11 | `IMAGE` | String metadata (`W:H:ID`) pointing to `BUFS` |

---

## 3. Gint: Morton Coordinate Packing

GeoPBF utilizes `gint` (Geospatial Integer), a 64-bit coordinate representation based on the Morton curve (Z-order). This allows for extremely fast spatial queries and topological integrity.

### 3.1 Bit Structure

* **Bit 63 (Terminal Bit)**: If `1`, it represents an **L1 node** (fixed precision, $10^{-7}$). If `0`, it represents an **L2 node**.
* **Bits 0-5 (VW Weight)**: For L2 nodes, these bits store the Visvalingam-Whyatt (VW) rank (0-63), defining the importance of a vertex for dynamic simplification.

### 3.2 Benefits

By converting 2D coordinates into a 1D Morton integer, spatial proximity is preserved in numerical order, enabling binary searches for features within a specific area.

---

## 4. Topology Management

GeoPBF supports advanced topological structures through the `analyzeTopology()` process.

* **Arc System**: Instead of storing redundant coordinates for shared boundaries, GeoPBF stores unique "Arcs".
* **Feature Referencing**: Features reference Arcs by their index. A negative index indicates the Arc should be read in reverse order.
* **Purification**: The internal engine detects and resolves segment intersections to ensure mathematical consistency across the dataset.

---

*Document version: April 2026. This specification is governed by the implementation in the `geopbf` library.*
````

## File: README.md
````markdown
# geopbf.js

**An efficient binary GIS data architecture designed for modern web environments.**

`geopbf.js` is a lightweight, Protocol Buffers (PBF) based data engine. It is designed to complement existing GIS standards like GeoJSON and Shapefiles by providing a high-performance binary alternative that enhances memory efficiency and rendering speed in the browser.

---

## 🟢 Seamless GeoJSON Compatibility

`geopbf.js` is designed with a **"GeoJSON-First"** philosophy. It is upwardly compatible with existing GeoJSON-based ecosystems:

* **Interoperable Data Model**: The internal structure follows the standard Feature/FeatureCollection model, making it familiar to any GIS developer.
* **Simple Transition**: You can load GeoJSON directly and, when needed, output it back via the `.geojson` getter.
* **Plug-and-Play**: It works alongside popular libraries like Leaflet, MapLibre GL JS, and OpenLayers, serving as a high-speed data provider for these existing tools.

---

## ⚡️ Key Technical Advantages

### 1. Memory Efficiency & Performance

While GeoJSON is excellent for readability and ease of use, large datasets can become memory-intensive. `geopbf.js` addresses this by utilizing a binary structure that minimizes the memory footprint and significantly reduces parsing time.

### 2. $O(1)$ Header Updates

The binary architecture allows for instant updates to metadata (Name, Description, License). By manipulating the file header directly, these changes are completed in constant time $O(1)$, ensuring that the data's integrity and indexing remain intact without needing to re-encode the entire dataset.

### 3. Integrated Topology Support

Building on the concepts of TopoJSON, `geopbf.js` includes a topology engine that identifies shared boundaries. This results in even smaller file sizes and ensures topological consistency for complex spatial analysis and visualization.

### 4. Zero-Latency Rendering Pipeline

By streaming binary coordinates directly to Canvas or WebGL contexts, the library avoids the overhead of intermediate object creation. This "Binary-to-Pixel" approach allows for smooth rendering of large-scale datasets while maintaining a responsive UI.

---

## 🚀 API Overview

### `geopbf(input, options)`

The main entry point for synchronizing various GIS formats into the binary hub.

* **Input**: Supports `File`, `Blob`, `ArrayBuffer`, and `Object` (GeoJSON).
* **Automatic Detection**: Handles Shapefiles (.zip), KMZ, GML, and GeoJSON automatically.

```javascript
import { geopbf } from 'geopbf';

// Load and convert to a high-performance binary instance
const pbf = await geopbf(inputData);
```

### Instance Methods (The `PBF` Class)

* **`.geojson` / `.topojson` (Getters)**: Access your data in familiar formats for use with other libraries.
* **`.draw(ctx, options)`**: Render data directly to a canvas context for maximum performance.
* **`.getFeature(i)`**: Access a specific feature without decoding the entire file.
* **`.header(meta)`**: Update metadata instantly via binary slicing.
* **`.shape()` / `.kmz()` / `.gml()`**: Export your data to various standard GIS formats for interoperability.
* **`.save(name)`**: Persist your work as a native `.pbf` file.

---

## 🏗 System Architecture

To ensure a fluid user experience, all intensive decoding and processing are handled by **Web Workers**. This off-main-thread architecture keeps the browser responsive, even when processing hundreds of megabytes of spatial data.

* **Built with Vite 8**: Utilizes modern code splitting to ensure that only the necessary components are loaded when needed.
* **Native Browser APIs**: Built on standard web technologies like `CompressionStream` for maximum compatibility and performance.

---

## 📄 License

```text
/*!
* geopbf.js v1.0.0
* (c) 2026 Kenji Yoshida
* Released under the MIT License.
*/
```
````

## File: reference.md
````markdown
# GeoPBF API Reference (v1.0)

`GeoPBF` is a high-performance GIS library for the browser, providing efficient binary storage, spatial analysis, and topological processing.

## Table of Contents
1. [Constructor](#1-constructor)
2. [Data Loading & Output](#2-data-loading--output)
3. [Metadata & Configuration](#3-metadata--configuration)
4. [Geometric Analysis](#4-geometric-analysis)
5. [Data Manipulation](#5-data-manipulation)
6. [Topology & Advanced GIS](#6-topology--advanced-gis)
7. [Static Methods](#7-static-methods)

---

## 1. Constructor

### `new PBF(options)`
Creates a new GeoPBF instance.
* **`options.name`** (String): Dataset name.
* **`options.precision`** (Number): Coordinate precision ($10^n$). Default is `6` ($10^{-6}$ degrees).
* **`options.noprop`** (Boolean): If true, skips property encoding to save space.

---

## 2. Data Loading & Output

### `await pbf.set(data)`
Loads data into the instance. Supports GeoJSON objects, ArrayBuffers, or TypedArrays.

### `pbf.geojson` (Getter)
Returns the entire dataset as a GeoJSON `FeatureCollection`.

### `pbf.arrayBuffer` (Getter)
Returns the serialized binary data as an `ArrayBuffer`.

---

## 3. Metadata & Configuration

### `pbf.name([value])` / `pbf.description([value])` / `pbf.license([value])`
Gets or sets metadata strings.

### `pbf.precision([value])`
Gets or sets the coordinate precision ($10^n$).

---

## 4. Geometric Analysis

### `pbf.centroid(index)`
Returns the `[lng, lat]` centroid of the feature at the specified index.

### `pbf.area(index)`
Returns the area (in square meters) of the polygon at the specified index.

### `pbf.contain([lng, lat], [getOneFlag])`
Checks which polygons contain the given point. Returns an array of indices or a single index if `getOneFlag` is true.

### `await pbf.nearPoint([lng, lat], maxResults, maxDistance)`
Performs a fast spatial search using an internal KDBush index. Returns the nearest feature indices.

---

## 5. Data Manipulation

### `await pbf.dissolve(propertyName)`
Merges adjacent polygons that share the same value for the specified property.

### `await pbf.filter(filterFunc)`
Returns a new PBF instance containing only features that satisfy the `filterFunc`.

### `await pbf.map(mapFunc)`
Returns a new PBF instance with properties modified by the `mapFunc`.

### `await pbf.classify(keyOrFunc)`
Splits the dataset into multiple PBF instances based on a property key or a custom classification function.

---

## 6. Topology & Advanced GIS

### `pbf.analyzeTopology()`
Analyzes the dataset to build shared boundaries (Arcs). This is required for `topojson`, `mesh`, and `merge`.

### `pbf.topojson` (Getter)
Returns the dataset in **TopoJSON** format.

### `pbf.neighbors([index])`
Returns an array of indices representing features that share boundaries with the specified feature.

### `pbf.mesh(filterFunc)`
Extracts shared boundaries (edges) between polygons that satisfy the filter criteria.

### `pbf.merge(filterFunc)`
Combines multiple polygons into a single geometry by removing shared internal boundaries.

---

## 7. Static Methods

### `await PBF.update(buffer, meta)`
Updates the header metadata (name, description, license, etc.) of an existing GeoPBF binary without re-encoding the entire body.

### `await PBF.concatinate(pbfArray, [name])`
Combines multiple PBF instances into a single instance.

---

*Document version: April 2026. This specification is based on the implementation in the `geopbf` library.*
````

## File: vite.config.js
````javascript
import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
    resolve: {
        alias: {
            // 末尾の index.js を消して 'src' フォルダを指すようにします
            'common': resolve(__dirname, '../../packages/common/src'),
            'native-bucket': resolve(__dirname, '../native-bucket/src'),
            'ortho-map': resolve(__dirname, '../../packages/ortho-map/src'),
            'altpbf': resolve(__dirname, '../../packages/altpbf/src'),
        }
    },
    server: {
        fs: { allow: ['../..'] },
        proxy: {
            '/api': {
                target: 'https://api.ortho-earth.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api/, ''),
            }
        }
    },
    worker: { format: 'es' },
    optimizeDeps: {
        exclude: ['ortho-map', 'common', 'geopbf', 'altpbf', 'native-bucket']
    },
    build: {
        target: 'esnext',
        sourcemap: true,
        minify: false,
        lib: {
            entry: resolve(__dirname, 'src/geopbf.js'),
            name: 'geopbf',
            fileName: 'geopbf',
            formats: ['es']
        },
        rollupOptions: {
            external: ['encoding-japanese']
        }
    }
})
````
