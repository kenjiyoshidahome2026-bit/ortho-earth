import { GeoPBF } from "geopbf";
import { isFunction, isArray } from "common";
export function drawPBF(data, prop = {}) { console.log(data)
    const { ctx, proj, zoom } = this;
    const rotate = proj.rotate(), scale = proj.scale(), translate = proj.translate();
    const { PI, sin, cos } = Math, rad = PI / 180;
    if (!data || zoom < prop.minZoom || zoom > prop.maxZoom) return;
    const fill = style => (ctx.fillStyle = style, ctx.fill());
    const stroke = (style, lineWidth = 1, dash = []) => style && (ctx.strokeStyle = style, ctx.lineWidth = lineWidth, ctx.setLineDash(dash), ctx.stroke());
    const properties = (isFunction(prop))? prop(data, zoom) : prop;
////------------------------------------------------------------------------------- Sphereの例外処理
    if (data.type === "Sphere") {
        ctx.beginPath(); ctx.arc(translate[0], translate[1], scale, 0, 2 * PI);
        properties.fill && fill(properties.fill);
		stroke(properties.stroke, properties.width, properties.dash);
		return;
    }
////------------------------------------------------------------------------------- 3D投影＆カリング計算
    const sφ = sin(rotate[1] * rad), cφ = cos(rotate[1] * rad), sγ = sin(rotate[2] * rad), cγ = cos(rotate[2] * rad);
    const project3D = (lng, lat) => {
        const l = (lng + rotate[0]) * rad, φ = lat * rad, cp = cos(φ), sp = sin(φ), cl = cos(l), sl = sin(l);
        const x = cp * sl, y = sp, z = cp * cl;
        const yr = y * cφ + z * sφ, zr = z * cφ - y * sφ;
        return [translate[0] + scale * (x * cγ - yr * sγ), translate[1] - scale * (x * sγ + yr * cγ), zr];
    };
////-------------------------------------------------------------------------------
    ctx.beginPath();
    const { pbf, e } = data, { TAGS } = GeoPBF;
    const drawCoords = (pos, type) => { pbf.pos = pos;
        let lens = [];
        pbf.readMessage(tag => {
            if (tag === TAGS.LENGTH) pbf.readPackedVarint(lens);
            else if (tag === TAGS.COORDS) {
                const end = pbf.readVarint() + pbf.pos;
                let lng = 0, lat = 0, first = true, prevP = null;
                const readNext = () => {
                    lng += pbf.readSVarint(); lat += pbf.readSVarint();
                    return project3D(lng / e, lat / e);
                };
                const lineTo = () => {
                    const currP = readNext();
                    if (first) {
                        if (currP[2] >= 0) ctx.moveTo(currP[0], currP[1]);
                        first = false;
                    } else {
                        if (prevP[2] >= 0 && currP[2] >= 0) { // 両方手前
                            ctx.lineTo(currP[0], currP[1]);
                        } else if (prevP[2] < 0 && currP[2] < 0) { // 両方裏側
                            ctx.moveTo(currP[0], currP[1]);
                        } else { // 地平線を跨ぐ場合、交点を算出してピッタリ切る
                            const ratio = prevP[2] / (prevP[2] - currP[2]);
                            const px = prevP[0] + ratio * (currP[0] - prevP[0]);
                            const py = prevP[1] + ratio * (currP[1] - prevP[1]);
                            if (prevP[2] >= 0) { ctx.lineTo(px, py); ctx.moveTo(currP[0], currP[1]); }
                            else { ctx.moveTo(px, py); ctx.lineTo(currP[0], currP[1]); }
                        }
                    }
                    prevP = currP;
                };
                if (type === 0 || type === 1) { // Point系
                    while (pbf.pos < end) {
                        const currP = readNext();
                        if (currP[2] >= 0) { const radius = (properties.size || 6) / 2;
                            ctx.moveTo(currP[0] + radius, currP[1]); ctx.arc(currP[0], currP[1], radius, 0, PI * 2);
                        }
                    }
                } else if (type === 2) { // LineString
                    while (pbf.pos < end) lineTo();
                } else if (type === 3 || type === 4) { // MultiLineString / Polygon
                    for (let i = 0; i < lens.length; i++) {
                        first = true; prevP = null; let n = lens[i];
                        while (n-- > 0) lineTo();
                    }
                } else if (type === 5) { // MultiPolygon
                    let posIdx = 0;
                    for (let i = 0; i < lens[0]; i++) {
                        const nRings = lens[++posIdx];
                        for (let j = 0; j < nRings; j++) {
                            first = true; prevP = null; let n = lens[++posIdx];
                            while (n-- > 0) lineTo();
                        }
                    }
                }
            }
        });
    };
    data.each((n, map) => (map[2] === 6)? map[3].forEach((t, i) => drawCoords(t, map[4][i])): drawCoords(map[1], map[2]));
    properties.fill && fill(properties.fill);
    stroke(properties.stroke, properties.width, properties.dash);
}