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