import { isObject, geoOrthographic, geoMercator, geoEquirectangular} from "common";

export function preview(self, canvas, props = {}) {
    if (!self.length) return null;
    if (isObject(canvas)) { props = canvas; canvas = null; }
    const dpr = props.dpr || 1;
    const ownCanvas = !canvas;
    const size = props.size || 512;
    const width  = canvas ? canvas.width  / dpr : size;
    const height = canvas ? canvas.height / dpr : size;

    const projection = props.projection || "";
    const proj = projection.match(/orthographic/i) ? geoOrthographic() : projection.match(/mercator/i) ? geoMercator() : geoEquirectangular;
    const bbox = props.bbox || self.bbox;
    const pbf = self.pbf, e = self.e;
    const radius = props.radius || 3;

    const cx = (bbox[0] + bbox[2]) / 2;
    const cy = (bbox[1] + bbox[3]) / 2;
    proj.rotate([-cx, -cy, 0]).fitExtent([[0, 0], [width, height]]);
    if (props.scale) proj.scale(props.scale);

    const offcanvas = ownCanvas ? new OffscreenCanvas(width * dpr, height * dpr) : canvas;
    const ctx = offcanvas.getContext("2d");
    if (dpr !== 1) ctx.scale(dpr, dpr);

    if (props.background) { ctx.fillStyle = props.background; ctx.fillRect(0, 0, width, height); }
    ctx.lineWidth = props.lineWidth || 1 / dpr;
    ctx.fillStyle = props.fill || "#ccc";
    ctx.strokeStyle = props.stroke || "#000";

    const out = b => (bbox[0] > b[2] || bbox[1] > b[3] || bbox[2] < b[0] || bbox[3] < b[1]);

    self.forEach((n, map) => {
        if (out(self.getBbox(n))) return;
        ctx.beginPath();

        const drawCoords = (pos, type) => {
            pbf.pos = pos;
            let lens = [];

            pbf.readMessage(tag => {
                if (tag === 9) pbf.readPackedVarint(lens);
                else if (tag === 10) {
                    const end = pbf.readVarint() + pbf.pos;
                    let p = [0, 0];
                    const readNext = () => {
                        p[0] += pbf.readSVarint();
                        p[1] += pbf.readSVarint();
                        return proj([p[0] / e, p[1] / e]);
                    };

                    if (type === 0) {
                        const pt = readNext();
                        if (pt) { ctx.moveTo(pt[0] + radius, pt[1]); ctx.arc(pt[0], pt[1], radius, 0, Math.PI * 2); }
                    } else if (type === 1) {
                        while (pbf.pos < end) {
                            const pt = readNext();
                            if (pt) { ctx.moveTo(pt[0] + radius, pt[1]); ctx.arc(pt[0], pt[1], radius, 0, Math.PI * 2); }
                        }
                    } else if (type < 4) {
                        let i = 0;
                        while (pbf.pos < end) {
                            const pt = readNext();
                            if (pt) ctx[i++ ? "lineTo" : "moveTo"](...pt);
                        }
                    } else {
                        let pos = 0;
                        const drawRing = (n) => {
                            let pRing = [0, 0], i = 0;
                            while (n-- > 0) {
                                pRing[0] += pbf.readSVarint();
                                pRing[1] += pbf.readSVarint();
                                const pt = proj([pRing[0] / e, pRing[1] / e]);
                                if (pt) ctx[i++ ? "lineTo" : "moveTo"](...pt);
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

        if (map[2] < 2 || map[2] > 3) ctx.fill();
        ctx.stroke();
    });

    return ownCanvas ? offcanvas.transferToImageBitmap() : canvas;
}
