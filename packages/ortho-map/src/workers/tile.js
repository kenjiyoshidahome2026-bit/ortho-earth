import { geoOrthographic } from "./geoOrthoGraphic.js";
import { orthoTileGL2 } from "./orthoTileGL2.js";
import { createTileServer, getTileArray } from "./getTileArray.js";
import { Resources } from "../modules/borderJSONs.js";
const { tileURL } = Resources;

const src = async e => {
    try {
        const res = await fetch(e.data, { cache: 'force-cache' });
        if (!res.ok) return postMessage({ error: 'HTTP error' });
        const blob = await res.blob();
        const bm = await createImageBitmap(blob);
        postMessage({ bitmap: bm }, [bm]);
    } catch (err) {
        postMessage({ error: err.message });
    }
};
const workerURL = URL.createObjectURL(new Blob(["onmessage=" + src.toString()], { type: "application/javascript" }));
let proj = geoOrthographic();
let canvas, gl, width, height, minZoom, zoom, currentZoom, isMoving = false;
let MasterTub = [], WorkerTub = [], TileTub = new Map(), urlTub = [], TileServer = null;
let layerSession = 0;
const funcs = { init, set, drawing, drawn, resize, destroy };
onmessage = e => funcs[e.data.type](e.data);
function init(data) {
    MasterTub = []; WorkerTub = [];
    for (let i = 0; i < data.workers; i++) {
        const w = new Worker(workerURL);
        MasterTub.push(w);
        WorkerTub.push(w);
    }
    canvas = data.offscreen;
    gl = orthoTileGL2(canvas.getContext("webgl2"), data.dpr);
    postMessage({ type: data.type, action: "done", ctx: gl.constructor.name });
}
async function set(data) {
    if (data.cmd != "tile" || !data.data) return;
    layerSession++;
    minZoom = data.prop;
    const count = MasterTub.length;
    MasterTub.forEach(t => t.terminate());
    MasterTub.length = 0; WorkerTub.length = 0;
    for (let i = 0; i < count; i++) {
        const w = new Worker(workerURL);
        MasterTub.push(w);
        WorkerTub.push(w);
    }
    if (urlTub) urlTub.length = 0;
    if (TileTub) {
        TileTub.forEach((img, key) => img && removeImage(img));
        TileTub.clear();
    }
    TileServer = createTileServer(tileURL(data.data));
    if (gl) gl.clearContext();
    finalize();
    postMessage({ type: data.type, action: "done" });
}
function resize(data) {
    gl.resizeBySize(width = data.width, height = data.height);
    proj.fitExtent([[1, 1], [width - 1, height - 1]], { type: "Sphere" });
    postMessage({ type: data.type, action: "done" });
}
function drawing(data) {
    isMoving = true;
    if (data) {
        proj.rotate(data.rotate).scale(data.scale);
        zoom = log2(data.scale * PI * 2 / 256);
    }
    gl.clearContext();
    if (!TileServer || zoom <= minZoom) return;
    getTileArray().forEach(([key, [img, locs]]) => {
        img && gl.bindTexture(gl.TEXTURE_2D, img._glTexture = img._glTexture || gl.setImage(img));
        for (let l of locs) gl.drawTile(l[0], l[1]);
    })
}

function drawn() { isMoving = false; finalize(); }
function finalize() {
    gl.clearContext();
    if (!TileTub || zoom <= minZoom) return;
    const keep = new Set();
    getTileArray().forEach(([key, [img, locs]]) => { // 1. 今ある素材で即座に画面を更新
        if (!img) return; // 届いていないものやエラー(false)は飛ばす
        keep.add(key);
        gl.bindTexture(gl.TEXTURE_2D, img._glTexture || (img._glTexture = gl.setImage(img)));
        for (let l of locs) gl.drawTile(l[0], l[1]);
    });
    urlTub.length || TileTub.forEach((img, key) => { // キューが空の時だけ掃除
        if (keep.has(key) || img === null) return; // 画面内とロード中(null)は絶対に保護
        if (!inside(key.split('_').map(Number))) {
            img && removeImage(img)
            TileTub.delete(key);
        }
    });
    function inside([x, y, z]) {
        const n = 1 << z, invN = 1 / n; // 除算を1回に減らす
        const xmin = x * invN * 360 - 180, xmax = (x + 1) * invN * 360 - 180;
        const ymax = Math.atan(Math.sinh(PI * (1 - 2 * y * invN))) * deg;
        const ymin = Math.atan(Math.sinh(PI * (1 - 2 * (y + 1) * invN))) * deg;
        let p;
        p = proj([xmin, ymax]); if (p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height) return true;
        p = proj([xmax, ymax]); if (p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height) return true;
        p = proj([xmax, ymin]); if (p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height) return true;
        p = proj([xmin, ymin]); if (p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height) return true;
        p = proj([(xmin + xmax) / 2, (ymin + ymax) / 2]);
        if (p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height) return true;
        return false;
    }
}

function removeImage(img) {
    if (img._glTexture) {// GPU上のテクスチャメモリを解放
        gl.deleteTexture(img._glTexture); img._glTexture = null;
    }
    if (img.close) img.close(); // ImageBitmap 自体のクローズ（ブラウザのメモリ解放を促進）
}
function destroy(data) {
    canvas && (canvas.width = 0, canvas.height = 0); canvas = null;
    WorkerTub.forEach(t => t.terminate()); WorkerTub.length = 0; WorkerTub = null;
    URL.revokeObjectURL(workerURL);
    TileTub = TileServer = gl = proj = null;
    postMessage({ type: data.type, action: "done" });
}