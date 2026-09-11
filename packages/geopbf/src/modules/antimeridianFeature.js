import { antimeridianCut } from "./antimeridianCut.js";

// toClockwise 警告のスパム抑制：空リング多発データ（NE海岸線等）で数十万件出て console を潰すのを数件に絞る。
let _tcWarnCount = 0;
const _tcWarn = (...a) => { if (_tcWarnCount++ < 3) console.warn(...a); else if (_tcWarnCount === 4) console.warn("toClockwise: 以降の同種警告は抑制（データに空リング多数）"); };

// opts.cut=false＝切断も向き正規化もしない（座標の掃除だけ）＝往復無変換の器。opts.onCut＝切断した時に呼ぶ（計数用）。
export function antimeridianFeature(feature, opts = null) {
    const { min, max, abs } = Math;
    const p = feature.properties = feature.properties || {}, geom = feature.geometry, type = geom.type;
    if (type === "Point" || type === "MultiPoint") return feature;
    const cleanRing = r => Array.isArray(r) ? r.filter(pt => pt != null && typeof pt[0] === 'number') : [];
    const cleanCoords = a => {
        if (!Array.isArray(a) || !a.length) return a;
        return typeof a[0]?.[0] === 'number' ? cleanRing(a) : a.map(cleanCoords).filter(x => x && x.length);
    };
    if (geom.coordinates) geom.coordinates = cleanCoords(geom.coordinates);
    if (opts && opts.cut === false) return feature;
    let c = geom.coordinates, xmin = Infinity, xmax = -Infinity;
    const calc = a => a == null ? void 0 : (Array.isArray(a) && typeof a[0] !== 'number') ? a.forEach(calc) : (xmin = min(xmin, a[0]), xmax = max(xmax, a[0]));
    (c === undefined) || calc(c);
    // 跨ぎ判定＝範囲外（連続表現）に加えて、範囲内でも「隣接頂点が混符号かつ経度差>180」（±179.9等＝エディタの
    // normLon 産の正規化表現）。ただし**両端とも**±180ちょうどのペア（+180→-180＝同じ子午線上の移動）は除外＝
    // 縫い目に**接する**だけ（南極型リング等）で跨ぎではない。片端だけが ±180 のペア（-180→+179.99 等）は
    // 「縫い目上の頂点で跨ぐ」＝跨ぎ（量子化/吸着格子で頂点がちょうど ±180 に載る円等・2026-09-12 geoedit で発覚）。
    // 切断器の fix() は +180 を保つ（-180 へ書き換えると西側の縫い目頂点が偽の跨ぎになる）。
    const hasJump = a => !Array.isArray(a) || !a.length ? false
        : typeof a[0]?.[0] !== 'number' ? a.some(hasJump)
        : a.some((pt, i) => i + 1 < a.length && pt[0] * a[i + 1][0] < 0 && abs(a[i + 1][0] - pt[0]) > 180 && !(abs(pt[0]) === 180 && abs(a[i + 1][0]) === 180));
    if (xmin >= -180 && xmax <= 180 && !hasJump(c)) return toClockwise(feature);
    if (opts && opts.onCut) opts.onCut();
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
        const fix = r => {
            let s = 0;
            for (let j = 0; j < r.length - 1; j++) {
                if (!r[j] || !r[j + 1]) { _tcWarn("toClockwise: undefined point at", j, r); continue; }
                s += (r[j + 1][0] - r[j][0]) * (r[j + 1][1] + r[j][1]);
            }
            return s;
        };
        // 巻き方向の正規化は面だけ。線（LineString/MultiLineString）に走ると点や数値を「空リング」と誤認して警告が出ていた。
        const rw = t => (!t.type || !t.type.includes("Polygon")) ? void 0 : (t.type === "Polygon" ? [t.coordinates] : t.coordinates || []).forEach(p => (p || []).forEach((r, i) => {
            if (!r || !r.length) { _tcWarn("toClockwise: undefined/empty ring at", i, p); return; }
            const s = fix(r); if ((!i && s < 0) || (i && s > 0)) r.reverse();
        }));
        rw(f.geometry || f); return f;
    }
}
