import polygonClipping from 'polygon-clipping';
import { antimeridianCut } from "common/antimeridianCut.js";
export function antimeridianFeature(feature) {
    const { PI, sin, cos, sqrt, asin, atan2, floor, abs, min, max } = Math, d2r = PI / 180, r2d = 180 / PI;
    const p = feature.properties = feature.properties || {}, geom = feature.geometry, type = geom.type;
    if (type === "Point" || type === "MultiPoint") return feature;
    let c = geom.coordinates, xmin = Infinity, xmax = -Infinity;
    const calc = a => (typeof a[0] !== 'number') ? a.forEach(calc) : (xmin = min(xmin, a[0]), xmax = max(xmax, a[0]));
    calc(c);
    if (xmin >= -180 && xmax <= 180 && xmax - xmin < 180) return toClockwise(feature);
    c = type.startsWith("Multi") ? c : [c];
    if (type.includes("LineString")) {
        c = c.flatMap(t => antimeridianCut(t, true));
        feature.geometry = { type: c.length > 1 ? "MultiLineString" : "LineString", coordinates: c.length > 1 ? c : c[0] };
    } else if (type.includes("Polygon")) {
        c = c.flatMap(poly => {
            const ext = antimeridianCut(poly[0]), holes = poly.slice(1).flatMap(h => antimeridianCut(h));
            return !holes.length ? ext.map(r => [r]) : ext.flatMap(r => subPolygon([[r]], [holes]));
        }).filter(p => p && p.length > 0 && p[0].length >= 4);
        if (!c.length) return (feature.geometry = { type: "Polygon", coordinates: [] }, feature);
        feature.geometry = { type: c.length > 1 ? "MultiPolygon" : "Polygon", coordinates: c.length > 1 ? c : c[0] };
    }
    return toClockwise(feature);
    function greatCircleArc(p1, p2, n) {
        const L1 = p1[0] * d2r, l1 = p1[1] * d2r, L2 = p2[0] * d2r, l2 = p2[1] * d2r;
        const a = sin((l1 - l2) / 2) ** 2 + cos(l1) * cos(l2) * sin((L1 - L2) / 2) ** 2;
        const dist = 2 * asin(min(1, sqrt(max(0, a))));
        if (dist < 1e-9 || isNaN(dist)) return [];
        return Array.from({ length: n - 1 }, (_, i) => {
            const f = (i + 1) / n, A = sin((1 - f) * dist) / sin(dist), B = sin(f * dist) / sin(dist);
            const x = A * cos(l1) * cos(L1) + B * cos(l2) * cos(L2), y = A * cos(l1) * sin(L1) + B * cos(l2) * sin(L2), z = A * sin(l1) + B * sin(l2);
            const lo = atan2(y, x) * r2d, la = atan2(z, sqrt(x * x + y * y)) * r2d;
            return [isNaN(lo) ? p1[0] : lo, isNaN(la) ? p1[1] : la];
        });
    }
    function subPolygon(subject, clipper) {
        const tub = {}, pA = divideCoords(subject, tub), qA = divideCoords(clipper, tub);
        if (!pA.length) return []; if (!qA.length) return pA;
        let res; try { res = polygonClipping.difference(pA, ...qA); } catch (e) { return subject; }
        return res.map(poly => poly.map(ring => {
            let f = ring.filter(u => u && !isNaN(u[0]) && !tub[`${u[0].toFixed(10)},${u[1].toFixed(10)}`]);
            if (f.length && (f[0][0] !== f[f.length - 1][0] || f[0][1] !== f[f.length - 1][1])) f.push([f[0][0], f[0][1]]);
            return f.length >= 4 ? f : null;
        }).filter(r => r)).filter(p => p.length && p[0].length >= 4);
        function divideCoords(coords, tub) {
            return coords.map(poly => (poly || []).map(ring => (ring || []).reduce((q, p1, i) => {
                if (!i) return [p1];
                const p0 = ring[i - 1], d = abs(p0[0] - p1[0]), n = 1 + floor(d > 180 ? 360 - d : d);
                if (n > 2) greatCircleArc(p0, p1, n).forEach(p => (tub[`${p[0].toFixed(10)},${p[1].toFixed(10)}`] = 1, q.push(p)));
                return q.push(p1), q;
            }, [])));
        }
    }
    function toClockwise(f) {
        const fix = r => {
            let s = 0; for (let j = 0; j < r.length - 1; j++) s += (r[j + 1][0] - r[j][0]) * (r[j + 1][1] + r[j][1]);
            return s;
        };
        const rw = t => (t.type === "Polygon" ? [t.coordinates] : t.coordinates || []).forEach(p => p.forEach((r, i) => {
            const s = fix(r); if ((!i && s < 0) || (i && s > 0)) r.reverse();
        }));
        rw(f.geometry || f); return f;
    }
}