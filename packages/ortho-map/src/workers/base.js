// packages/ortho-map/src/workers/base.js
import { geoOrthographic } from "./geoOrthoGraphic.js";
import { orthoBaseGL2 } from "./orthoBaseGL2.js";
// ViteのAliasバグを回避するため、確実な相対パスを使います
import nativeBucket from "../../../native-bucket/src/index.js";

const dire = "GIS/base";
let canvas, gl, proj, width, height, path, cache, bucket, baseName = "", texture = null;
let Bucket, Cache;

// 🚨 トップレベルでの実行を遅延させ、確実にWorkerを起動させます
onmessage = async e => {
    try {
        if (!Bucket) {
            const nb = (typeof nativeBucket === 'function') ? nativeBucket() :
                (nativeBucket && typeof nativeBucket.default === 'function') ? nativeBucket.default() : null;
            if (!nb) throw new Error("native-bucket モジュールが正しく読み込めませんでした");

            Bucket = nb.Bucket;
            Cache = nb.Cache;
            proj = geoOrthographic();
        }

        const funcs = { init, set, drawing, drawn, resize, destroy };
        if (funcs[e.data.type]) {
            funcs[e.data.type](e.data);
        }
    } catch (err) {
        // エラーが発生した場合はメインスレッドのコンソールに詳細を送ります
        postMessage({ action: "error", message: err.message, stack: err.stack });
    }
};

function init(data) {
    canvas = data.offscreen;
    gl = orthoBaseGL2(canvas.getContext("webgl2"), data.dpr);
    delete data.offscreen;
    postMessage(Object.assign(data, { action: "done", type: "init", ctx: gl.constructor.name }));
}

async function set(data) {
    if (data.cmd != "base") return;
    const bname = data.data;
    if (baseName == data.data) return postMessage(Object.assign(data, { action: "done", type: "set" }));
    const key = `- loading Base Image "(${bname})"`;
    console.time(key);
    cache = cache || await Cache(dire);

    const big = `${bname}.webp`, small = `${bname}.webp`;

    let bm = await cache(big);
    if (!bm) {
        bucket = bucket || await Bucket(dire);
        texture && gl.deleteTexture(texture); texture = null;
        await cache(bname, bm = await createImageBitmap(await bucket.get(big)));
    }
    texture && gl.deleteTexture(texture); texture = null;
    texture = gl.setImage(bm); bm = null; baseName = bname;
    console.timeEnd(key);
    postMessage(Object.assign(data, { action: "done", type: "set" }));
}

function resize(data) {
    gl.resizeBySize(width = data.width, height = data.height);
    postMessage(Object.assign(data, { action: "done", type: "resize" }));
}

function drawing(data) {
    if (proj) {
        proj.rotate(data.rotate).scale(data.scale);
        gl.drawByProjection(proj);
    }
}

function drawn() { }

function destroy(data) {
    canvas && (canvas.width = 0, canvas.height = 0); canvas = null;
    // 🚨 タイポ修正: layer は無いので gl.deleteTexture に修正
    texture && gl.deleteTexture(texture); texture = null;
    gl = path = proj = null;
    postMessage(Object.assign(data, { action: "done", type: "destroy" }));
}