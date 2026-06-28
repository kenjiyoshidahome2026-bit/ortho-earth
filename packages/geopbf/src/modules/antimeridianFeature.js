import { antimeridianCut } from "common/antimeridianCut.js";

export function antimeridianFeature(feature) {
    const { min, max } = Math;
    const p = feature.properties = feature.properties || {}, geom = feature.geometry, type = geom.type;
    if (type === "Point" || type === "MultiPoint") return feature;
    let c = geom.coordinates, xmin = Infinity, xmax = -Infinity;
    const calc = a => a == null ? void 0 : (Array.isArray(a) && typeof a[0] !== 'number') ? a.forEach(calc) : (xmin = min(xmin, a[0]), xmax = max(xmax, a[0]));
    (c === undefined) || calc(c);
    if (xmin >= -180 && xmax <= 180) return toClockwise(feature);
    c = type.startsWith("Multi") ? c : [c];
    if (type.includes("LineString")) {
        c = c.flatMap(t => antimeridianCut(t, true));
        feature.geometry = { type: c.length > 1 ? "MultiLineString" : "LineString", coordinates: c.length > 1 ? c : c[0] };
    } else if (type.includes("Polygon")) {
        c = c.flatMap(poly => {
            const ext = antimeridianCut(poly[0]), holes = poly.slice(1).flatMap(h => antimeridianCut(h));
            return !holes.length ? ext.map(r => [r]) : ext.flatMap(r => subPolygon(r, holes));
        }).filter(p => p && p.length > 0 && p[0].length >= 4);
        if (!c.length) return (feature.geometry = { type: "Polygon", coordinates: [] }, feature);
        feature.geometry = { type: c.length > 1 ? "MultiPolygon" : "Polygon", coordinates: c.length > 1 ? c : c[0] };
    }
    return toClockwise(feature);

    function subPolygon(ext, holes) {
        return [[ext, ...holes.filter(h => pointInRing(centroid(h), ext))]];
    }
    function centroid(ring) {
        const n = ring.length - 1;
        let x = 0, y = 0;
        for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
        return [x / n, y / n];
    }
    function pointInRing([px, py], ring) {
        let inside = false;
        const n = ring.length - 1;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }
    function toClockwise(f) {
        const fix = r => { let s = 0; for (let j = 0; j < r.length - 1; j++) s += (r[j + 1][0] - r[j][0]) * (r[j + 1][1] + r[j][1]); return s; };
        const rw = t => (t.type === "Polygon" ? [t.coordinates] : t.coordinates || []).forEach(p => p.forEach((r, i) => {
            const s = fix(r); if ((!i && s < 0) || (i && s > 0)) r.reverse();
        }));
        rw(f.geometry || f); return f;
    }
}
