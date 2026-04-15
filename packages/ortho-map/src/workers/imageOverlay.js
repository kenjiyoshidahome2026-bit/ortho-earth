import geoOrthographic from "./geoOrthoGraphic.js";
import orthoTileGL2 from "./orthoTileGL2.js";

const counter_clockwise = a => //反時計回りは地球の裏側
    (a[1][0] - a[0][0]) * (a[1][1] + a[0][1]) + (a[2][0] - a[1][0]) * (a[2][1] + a[1][1]) +
    (a[3][0] - a[2][0]) * (a[3][1] + a[2][1]) + (a[0][0] - a[3][0]) * (a[0][1] + a[3][1]) > 0;

let canvas, gl, width, height, minZoom = 2;
const tub = new Set();
let proj = geoOrthographic(), zoom;
const funcs = { init, set, drawing, drawn, resize, destroy };
onmessage = e => funcs[e.data.type](e.data);
function init(data) {
    canvas = data.offscreen;
    gl = orthoTileGL2(canvas.getContext("webgl2"), data.dpr);
    postMessage({ type: data.type, action: "done", ctx: gl.constructor.name });
}
async function set(data) {
    if (data.cmd != "overlay") return;
    const bbox = data.prop.bbox, dx = data.prop.dx || 1, dy = data.prop.dy || 1;
    const texture = gl.setImage(data.data);
    const [w, s] = [Math.min(bbox[0], bbox[2]), Math.min(bbox[1], bbox[3])];
    const [e, n] = [Math.max(bbox[0], bbox[2]), Math.max(bbox[1], bbox[3])];
    tub.add([texture, [w, s, e, n], dx, dy]);
    postMessage({ type: data.type, action: "done" });
}
function resize(data) {
    gl.resizeBySize(width = data.width, height = data.height);
    proj.fitExtent([[1, 1], [width - 1, height - 1]], { type: "Sphere" });
    postMessage({ type: data.type, action: "done" });
}
function drawing(data) {
    gl.clearContext();
    proj.rotate(data.rotate).scale(data.scale);
    zoom = Math.log2(data.scale * Math.PI * 2 / 256); if (zoom <= minZoom) return;
    tub.forEach(([texture, bbox, dx, dy]) => {
        const getcoords = (i, j) => {
            const [x0, y0, x1, y1] = [(i) / dx, (j) / dy, (i + 1) / dx, (j + 1) / dy]
            return new Float32Array([x0, y0, x1, y0, x0, y1, x1, y1]);
        };
        const getPosition = (i, j) => {
            const [w, s, e, n] = bbox;
            const [W, S, E, N] = [w + (e - w) * (i) / dx, s + ((n - s) * (dy - (j + 1))) / dy, w + (e - w) * (i + 1) / dx, s + (dy - j) * (n - s) / dy];
            const p = [[W, N], [E, N], [E, S], [W, S]].map(proj); if (counter_clockwise(p)) return null;
            const q = p.map(t => [(t[0] / width) * 2 - 1, 1 - (t[1] / height) * 2]);
            return new Float32Array([q[0], q[1], q[3], q[2]].flat());
        };
        const b0 = gl.setTexture(texture);
        for (let i = 0; i < dx; i++) for (let j = 0; j < dy; j++) {
            const pos = getPosition(i, j); if (!pos) continue;
            const crd = getcoords(i, j);
            gl.drawTile(crd, pos);
        }
        gl.flush();
        gl.deleteTexture(b0);
    });
}
function drawn() { }
function destroy(data) {
    canvas && (canvas.width = 0, canvas.height = 0); canvas = null;
    gl = proj = null;
    postMessage({ type: data.type, action: "done" });
}
