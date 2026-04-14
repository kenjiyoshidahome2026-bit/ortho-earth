export function antimeridianCut(points, isLine = false) {
    const { PI, sin, cos, sqrt, atan2, abs } = Math, d2r = PI / 180, tub = [];
    if (!points?.length) return tub;
    const is_ring = _ => _.length > 1 && _[0][0] === _[_.length - 1][0] && _[0][1] === _[_.length - 1][1];
    const fix = x => ((((x + 180) % 360) + 360) % 360) - 180;
    const pts = points.filter(t => t && typeof t[0] === 'number').map(t => [fix(t[0]), t[1]]);
    const north = (pts.reduce((s, t) => s + t[1], 0) / pts.length) > 0;
    const straddles = p => {
        const a = [[], []];
        for (let i = 0; i < p.length - 1; i++) {
            if (p[i][0] * p[i + 1][0] < 0 && abs(p[i][0] - p[i + 1][0]) > 180) {
                a[((p[i][0] > 0) ? (p[i + 1][0] < p[i][0] - 180) : (p[i][0] < p[i + 1][0] - 180)) ? 0 : 1].push(i);
            }
        }
        return a;
    };
    const intersect = ([x0, y0], [x1, y1], f = 1) => {
        const x = sin((y0 - y1) * d2r) * sin((x0 + x1) / 2 * d2r) * cos((x0 - x1) / 2 * d2r) - sin((y0 + y1) * d2r) * cos((x0 + x1) / 2 * d2r) * sin((x0 - x1) / 2 * d2r);
        const z = cos(y0 * d2r) * cos(y1 * d2r) * sin((x0 - x1) * d2r), r = (f * z < 0 ? -1 : 1) * atan2(x, abs(z)) / d2r;
        return isNaN(r) ? y0 : r;
    };
    (is_ring(pts) && !isLine ? splitPolygon : splitPloyLine)(pts);
    return tub;
    function splitPolygon(p) {
        let s = 0; for (let i = 0; i < p.length - 1; i++) s += (p[i + 1][0] - p[i][0]) * (p[i + 1][1] + p[i][1]);
        if (s < 0) p.reverse();
        const cr = straddles(p); if (!cr[0].length) return tub.push(p);
        const c0 = cr[0].map(i => [intersect(p[i], p[i + 1], 1), i]).sort(([a], [b]) => north ? a - b : b - a);
        const c1 = cr[1].map(i => [intersect(p[i], p[i + 1], -1), i]).sort(([a], [b]) => north ? b - a : a - b);
        const start = c0[0], end = c0[1], rev = c1[0];
        if (!start) return tub.push(p);
        if (end || rev) { cut(start, 1, end || rev, !!end); cut(end || rev, !!end, start, 1); } else tub.push(p);
        function cut(sP, sF, eP, eF) {
            if (!sP || !eP) return;
            const a = [], len = p.length - 1; let i = (sP[1] < len - 1) ? sP[1] + 1 : 0;
            const deg = 180 * (p[i][0] < 0 ? -1 : 1);
            a.push([sF ? deg : 0, sP[0]], p[i]);
            while (i !== eP[1]) a.push(p[i = (i < len - 1) ? i + 1 : 0]);
            a.push([eF ? deg : 0, eP[0]], [...a[0]]); tub.push(a);
        }
    }
    function splitPloyLine(p) {
        let i = 0; for (; i < p.length - 1; i++) if (p[i][0] * p[i + 1][0] < 0 && abs(p[i][0] - p[i + 1][0]) > 180) break;
        if (i === p.length - 1) return tub.push(p);
        const lat = intersect(p[i], p[i + 1], 1), s0 = 180 * (p[0][0] < 0 ? -1 : 1), s1 = -s0;
        tub.push(p.slice(0, i + 1).concat([[s0, lat]]));
        splitPloyLine([[s1, lat]].concat(p.slice(i + 1)));
    }
}
export function subPolygon(subject, clipper, divideCoords) {
    const tub = {}, pA = divideCoords(subject, tub), qA = divideCoords(clipper, tub);
    if (!pA.length || !qA.length) return pA;
    let res; try { res = polygonClipping.difference(pA, ...qA); } catch (e) { return subject; }
    return res.map(poly => poly.map(ring => ring.filter(u => {
        if (!u || !Number.isFinite(u[0])) return false;
        return !tub[`${u[0].toFixed(10)},${u[1].toFixed(10)}`];
    })).filter(r => r?.length >= 4)).filter(p => p?.length);
}