export function geoOrthographic() {
    const { PI, max, min, sin, asin, atan2, cos, sqrt } = Math, rad = PI / 180;
    let r = [0, 0, 0], s = 150, t = [480, 250], sφ, cφ, sγ, cγ;
    const up = () => (sφ = sin(r[1] * rad), cφ = cos(r[1] * rad), sγ = sin(r[2] * rad), cγ = cos(r[2] * rad));
    const p = ([ln, lt]) => {
        const l = (ln + r[0]) * rad, φ = lt * rad, cp = cos(φ), sp = sin(φ), cl = cos(l), sl = sin(l);
        const x = cp * sl, y = sp, z = cp * cl, yr = y * cφ + z * sφ, zr = z * cφ - y * sφ;
        return zr < 0 ? null : [t[0] + s * (x * cγ - yr * sγ), t[1] - s * (x * sγ + yr * cγ)];
    };
    p.invert = ([px, py]) => {
        const x = (px - t[0]) / s, y = (t[1] - py) / s, xr = x * cγ + y * sγ, yr = -x * sγ + y * cγ, ρ2 = xr * xr + yr * yr;
        if (ρ2 > 1) return null;
        const zr = sqrt(1 - ρ2), ln = atan2(xr, zr * cφ + yr * sφ) / rad - r[0];
        return [((ln + 180) % 360 + 360) % 360 - 180, asin(max(-1, min(1, yr * cφ - zr * sφ))) / rad];
    };
    p.rotate = v => v === undefined ? r : (r = v, up(), p);
    p.scale = v => v === undefined ? s : (s = v, p);
    p.translate = v => v === undefined ? t : (t = v, p);
    p.fitExtent = (e) => {
        const w = e[1][0] - e[0][0], h = e[1][1] - e[0][1];
        return s = min(w, h) / 2, t = [e[0][0] + w / 2, e[0][1] + h / 2], up(), p;
    };
    return up(), p;
}

export function geoMercator() {
    const { PI, log, tan, atan, exp, min, max } = Math, rad = PI / 180;
    let r = [0, 0, 0], s = 150, t = [480, 250];
    const p = ([ln, lt]) => {
        const x = (ln + r[0]) * rad;
        const y = log(tan(PI / 4 + (lt + r[1]) * rad / 2));
        return [t[0] + s * x, t[1] - s * y];
    };
    p.invert = ([px, py]) => {
        const x = (px - t[0]) / s;
        const y = (t[1] - py) / s;
        return [x / rad - r[0], 2 * atan(exp(y)) / rad - 90 / 180 * 360 - r[1]];
    };
    p.rotate = v => v === undefined ? r : (r = v, p);
    p.scale = v => v === undefined ? s : (s = v, p);
    p.translate = v => v === undefined ? t : (t = v, p);
    p.fitExtent = (e) => {
        const w = e[1][0] - e[0][0], h = e[1][1] - e[0][1];
        return s = min(w, h) / (2 * PI), t = [e[0][0] + w / 2, e[0][1] + h / 2], p;
    };
    return p;
}

export function renderToBitmap(self, width, height, props = {}) {
    if (!self.length) return null;
    const bbox = props.bbox || self.bbox;
    const e = self.e;
    const pbf = self.pbf;
    const radius = props.radius || 3;

    const proj = props.projection === "Orthographic" ? geoOrthographic() : geoMercator();
    const cx = (bbox[0] + bbox[2]) / 2;
    const cy = (bbox[1] + bbox[3]) / 2;
    proj.rotate([-cx, -cy, 0]).fitExtent([[0, 0], [width, height]]);
    if (props.scale) proj.scale(props.scale);

    const offcanvas = new OffscreenCanvas(width, height);
    const ctx = offcanvas.getContext("2d");

    if (props.background) { ctx.fillStyle = props.background; ctx.fillRect(0, 0, width, height); }
    ctx.lineWidth = props.width || 1;
    ctx.fillStyle = props.fill || "#ccc";
    ctx.strokeStyle = props.stroke || "#000";

    const out = b => (bbox[0] > b[2] || bbox[1] > b[3] || bbox[2] < b[0] || bbox[3] < b[1]);

    self.each((n, fmap) => {
        if (out(self.getBbox(n))) return;
        ctx.beginPath();

        const map = fmap[n];
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

    return offcanvas.transferToImageBitmap();
}