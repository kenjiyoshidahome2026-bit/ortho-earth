import './demo.scss';
import nativeBucket from '../src/index.js';

const output = document.getElementById('log-screen');
const startBtn = document.getElementById('start-story');
const progressBar = document.querySelector('.progress-bar');
const progressContainer = document.getElementById('global-progress');
let count = 0;
let progressElement = null;
let currentPhase = "Download"; 
const delay = (ms) => new Promise(res => setTimeout(res, ms));

function cmd(cmd) {
    const div = document.createElement('div');
    div.className = 'log-entry log-cmd';
    div.innerHTML = `<code>${cmd.replace(/\n/g, '<br/>')}</code>`;
    output.appendChild(div);
    scrollToBottom();
}

function log(msg, type = 'info') {
    const div = document.createElement('div');
    div.className = `log-entry log-${type}`;
    div.innerHTML = `<span class="log-time">${new Date().toLocaleTimeString()}</span> <span class="log-msg">${msg}</span>`;
    output.appendChild(div);
    scrollToBottom();
    return div;
}
function step(msg) { 
    return log(`<span class="log-step">STEP ${count++}</span> ${msg}`, "info");
}

function logFileList(files) {
    const container = document.createElement('div');
    container.className = 'inline-file-list';
    files.forEach(f => {
        container.innerHTML += `<div class="file-row"><span>📄 ${f.name}</span><b>${f.size.toLocaleString()} bytes</b></div>`;
    });
    output.appendChild(container);
    scrollToBottom();
}

function scrollToBottom() {
    requestAnimationFrame(() => output.scrollTop = output.scrollHeight);
}

const progress =(e) => { //console.log(e); // For debugging: log the raw event details
    let { loaded, saved, total } = e.detail; total = total ? total: "---";
    const percent = total ? (((loaded||saved) / total) * 100).toFixed(1) : "??";
    const proccessed = loaded||saved;
    if (total) {
        progressContainer.style.display = 'block';
        progressBar.style.width = `${percent}%`;
    }
    progressElement && (progressElement.querySelector('.log-msg').innerHTML = 
        `📡 ${currentPhase}: <span class="highlight-val">${proccessed.toLocaleString()} bytes</span>`+
        (e.type == "FetchProgress" ? ` / ${total.toLocaleString()} bytes (${percent}%)`:""));    
};
const end = () => {
    progressBar.style.width = '100%';
    setTimeout(() => { progressContainer.style.display = 'none'; }, 1000);
    progressElement?.remove();
};
["Fetch", "Save", "Load"].forEach(evt => window.addEventListener(evt+"Progress", progress));
["Fetch", "Save", "Load"].forEach(evt => window.addEventListener(evt+"End", end));
startBtn.addEventListener('click', exec);

async function exec(event) { if (event) event.preventDefault();
    startBtn.disabled = true;
    output.innerHTML = '';
    const { Fetch, Bucket, Cache } = nativeBucket();
    try {
        step("Data Resource Definition");
        const targetURL = `https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2025/N03-20250101_GML.zip`;
        cmd(`const targetURL = "${targetURL}";`);
        await delay(800);
    ////-------------------------------------------------------------------------------------------  
        step("Standard Browser Limitation");
        cmd(`await fetch(targetURL); // Expected to fail`);
        try { await fetch(targetURL, { mode: 'cors' }); } catch (e) {
            log(`❌ Blocked: CORS policy prevents direct access.`, "error");
        }
        await delay(1000);
    ////-------------------------------------------------------------------------------------------  
        step("Full Archive Ingestion via Proxy");
        cmd(`const { Fetch, Bucket, Cache } = nativeBucket();\nconst zipFile = await Fetch(targetURL);`);
        currentPhase = "Downloading ZIP";
        progressElement = log("📡 Progress:", "warn");
        const t1 = performance.now();
        const zipFile = await Fetch(targetURL, { cors: true });
        const d1 = +(performance.now() - t1).toFixed(0);
        log(`✅ Success: Received archive (${zipFile.size.toLocaleString()} bytes) in ${d1.toLocaleString()}ms.`, "success");
        await delay(1000);
    /////-------------------------------------------------------------------------------------------  
        step("ZIP Archive Exploration");
        cmd(`const list = await Fetch(targetURL, { target: false });`);
        const list = await Fetch(targetURL, { target: false, cors: true });
        logFileList(list);
        await delay(1000);
    ////-------------------------------------------------------------------------------------------  
        step("Pinpoint Extraction (Smart Extract)");
        const targetFile= "N03-20250101.geojson";
        cmd(`const targetFile = "${targetFile}";\nconst file = await Fetch(targetURL, { target: targetFile });`);
        const t2 = performance.now();
        const extractedFile = await Fetch(targetURL, { target: targetFile, cors: true });
        const d2 = +(performance.now() - t2).toFixed(0);
        log(`🚀 [RESULT] Smart Extract Performance: <span class="highlight-speed">${d2.toLocaleString()}ms</span>`, "success");
        log(`📊 Extracted File Size: ${extractedFile.size.toLocaleString()} bytes`, "info");
        await delay(1000);
    ////-------------------------------------------------------------------------------------------  
        step("Cloud Synchronization (R2 Storage) with gzip");
        cmd(`const myBucket = await Bucket("gis-data");\nawait myBucket.put(file);`);
        currentPhase = "Compress && Syncing to R2"; 
        progressElement = log(`📡 Progress:`, "warn");
        const myBucket = await Bucket("gis-data");
        const t3 = performance.now();
        const size = await myBucket.put(extractedFile);
        const d3 = +(performance.now() - t3).toFixed(0);
        log(`✅ Data is gzipped & now on Cloudflare R2 Edge. <span class="highlight-speed">${size.toLocaleString()} bytes / ${d3.toLocaleString()}ms</span>`, "success");
        await delay(1000);
    ////-------------------------------------------------------------------------------------------  
        step("Integrity Verification (ETag Check)");
        cmd(`const meta = await myBucket.meta(targetFile);`);
        const meta = await myBucket.meta(targetFile);
        log(`✅ Validated ETag: <code class="val-code">${meta.ETag}</code>`, "success");
        await delay(1000);
    ////-------------------------------------------------------------------------------------------  
        step("Global Delivery (Get from Edge)");
        cmd(`const edgeBlob = await myBucket.get(targetFile, "blob");`);
        currentPhase = "Get from Edge"; 
        progressElement = log(`📡 Progress:`, "warn");
        const t4 = performance.now();
        const edgeBlob = await myBucket.get(targetFile, "blob");
        const d4 = +(performance.now() - t4).toFixed(0);
        log(`✅ Edge Download: <span class="highlight-speed">${d4.toLocaleString()}ms</span>`, "success");
        await delay(1200);
    ////-------------------------------------------------------------------------------------------  
        step("Persistent Local Caching (IndexedDB Put)");
        cmd(`const myCache = await Cache("gis-cache/json");\nawait myCache(edgeBlob);`);
        const myCache = await Cache("gis-cache/json");
        const tCPut = performance.now();
        await myCache(edgeBlob);
        const dCPut = (performance.now() - tCPut).toFixed(2);
        log(`✅ Cache Store: ${dCPut}ms (Blob persisted)`, "success");
        await delay(1000);
    ////-------------------------------------------------------------------------------------------  
        step("The Instant Experience (Cache Get)");
        cmd(`const cachedFile = await myCache(targetFile);`);
        const tCGet = performance.now();
        const cachedFile = await myCache(targetFile);
        const dCGet = (performance.now() - tCGet).toFixed(2);
        log(`✅ Cache Retrieve: ${dCGet} ms`, "success");
    ////-------------------------------------------------------------------------------------------  
        step("Structural Data Recovery (JSON). See json on console.");
        cmd(`console.log(JSON.parse(await cachedFile.text()));`);
        const geojson = JSON.parse(await cachedFile.text());
        log(`💎 Verified Features: ${geojson.features.length} entities recovered.`, "success");
        console.log(geojson);
    ////-------------------------------------------------------------------------------------------  
    } catch (err) {
        log(`🚨 Error: ${err.message}`, "error");
    } finally {
        startBtn.disabled = false;
        startBtn.innerHTML = "▶ RE-RUN BENCHMARK STORY";
    }
}
