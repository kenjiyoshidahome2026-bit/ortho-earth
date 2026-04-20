import { geoOrthographic } from "./geoOrthoGraphic.js";
import { orthoBaseGL2 } from "./orthoBaseGL2.js";
import nativeBucket from "native-bucket";
const dire = "GIS/base";
const { Bucket, Cache } = nativeBucket();
let canvas, gl, proj, width, height, path, cache, bucket, baseName = "", texture = null;
proj = geoOrthographic();
onmessage = e => { 
    const funcs = { init, set, drawing, drawn, resize, destroy };
    funcs[e.data.type](e.data);
};
function init(data) {
    canvas = data.offscreen;
    gl = orthoBaseGL2(canvas.getContext("webgl2"), data.dpr);
    delete data.offscreen;
    postMessage(Object.assign(data, { action: "done", ctx: gl.constructor.name }));
}
 async function set(data) {
    if (data.cmd != "base") return;
    const bname = data.data;
    if (baseName == data.data) return postMessage(Object.assign(data, { action: "done" }));
    const key = `- loading Base Image "(${bname})"`
    console.time(key)
    cache = cache || await Cache(dire);
    const big = `${bname}.webp`;//, small = `${bname}.webp`;
    let bm = await cache(big);
    if (!bm) {
        bucket = bucket || await Bucket(dire);
        texture && gl.deleteTexture(texture); texture = null;
      //  texture = gl.setImage(bm = await createImageBitmap(await bucket.get(small))); bm = null;
        await cache(bname, bm = await createImageBitmap(await bucket.get(big)));
    }
    texture && gl.deleteTexture(texture); texture = null;
    texture = gl.setImage(bm); bm = null; baseName = bname;
    console.timeEnd(key);
    postMessage(Object.assign(data, { action: "done" }));
}
function resize(data) {
    gl.resizeBySize(width = data.width, height = data.height);
    postMessage(Object.assign(data, { action: "done" }));
}
function drawing(data) {
    proj.rotate(data.rotate).scale(data.scale);
    gl.drawByProjection(proj);
}
function drawn() { }
function destroy(data) {
    canvas && (canvas.width = 0, canvas.height = 0); canvas = null;
    texture && layer.deleteTexture(texture); texture = null;
    gl = path = proj = null;
    postMessage(Object.assign(data, { action: "done" }));
}
