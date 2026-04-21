// packages/ortho-map/src/workers/base.js
import nativeBucket from "native-bucket";
import { geoOrthographic } from "./geoOrthoGraphic.js";
import { orthoBaseGL2 } from "./orthoBaseGL2.js";
import { layerList } from "../modules/layerList.js";
const { Bucket, Cache } = nativeBucket();
const dire = "GIS/base";
const proj = geoOrthographic();
let canvas, gl, width, height, path, cache, bucket, baseName = "", texture = null;

onmessage = async e => {
    const funcs = { init, set, drawing, drawn, resize, destroy };
    funcs[e.data.type](e.data);
};

function init(data) {
    canvas = data.offscreen;
    gl = orthoBaseGL2(canvas.getContext("webgl2"), data.dpr);
    delete data.offscreen;
    postMessage(Object.assign(data, { action: "done", type: "init", ctx: gl.constructor.name }));
}

async function set(data) { 
    if (data.cmd != "base") return;
    const bname = layerList[data.data].base;
    if (baseName == bname) return postMessage(Object.assign(data, { action: "done", type: "set" }));
    const key = `- loading Base Image "(${bname})"`;
    console.time(key);
    cache = cache || await Cache(dire);
    let bm = await cache(bname);
    if (!bm) {
        bucket = bucket || await Bucket(dire);
        texture && gl.deleteTexture(texture); texture = null;
        await cache(bname, bm = await createImageBitmap(await bucket.get(bname)));
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
    texture && gl.deleteTexture(texture); texture = null;
    gl = path = proj = null;
    postMessage(Object.assign(data, { action: "done", type: "destroy" }));
}