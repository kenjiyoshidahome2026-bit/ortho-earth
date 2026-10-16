import { antimeridianCut, antimeridianCutLineAttrs } from "./antimeridianCut.ts";
import type { LonLat, VertexAttr } from "./antimeridianCut.ts";
import { pointInRing as pointInRingCore } from "./geom.ts";

/** ここが触る分だけの GeoJSON Feature（幾何の coordinates は入れ子の数の配列・型は見ない） */
export interface AMGeometry { type: string; coordinates?: unknown; geometries?: AMGeometry[] }
export interface AMFeature { type?: string; geometry: AMGeometry; properties?: Record<string, unknown> | null; [k: string]: unknown }
export interface AntimeridianOptions { cut?: boolean; onCut?: () => void }

// toClockwise 警告のスパム抑制：空リング多発データ（NE海岸線等）で数十万件出て console を潰すのを数件に絞る。
let _tcWarnCount = 0;
const _tcWarn = (...a: unknown[]): void => { if (_tcWarnCount++ < 3) console.warn(...a); else if (_tcWarnCount === 4) console.warn("toClockwise: further warnings of this kind suppressed (many empty rings in data)"); };

// opts.cut=false＝切断も向き正規化もしない（座標の掃除だけ）＝往復無変換の器。opts.onCut＝切断した時に呼ぶ（計数用）。
export function antimeridianFeature(feature: AMFeature, opts: AntimeridianOptions | null = null): AMFeature {
    const { min, max, abs } = Math;
    const p = feature.properties = feature.properties || {}, geom = feature.geometry, type = geom.type;
    if (type === "Point" || type === "MultiPoint") return feature;
    const cleanRing = (r: unknown): LonLat[] => Array.isArray(r) ? r.filter(pt => pt != null && typeof pt[0] === 'number') : [];
    const cleanCoords = (a: unknown): unknown => {
        if (!Array.isArray(a) || !a.length) return a;
        return typeof a[0]?.[0] === 'number' ? cleanRing(a) : a.map(cleanCoords).filter(x => x && (x as unknown[]).length);
    };
    if (geom.coordinates) geom.coordinates = cleanCoords(geom.coordinates);
    if (opts && opts.cut === false) return feature;
    let c: unknown = geom.coordinates, xmin = Infinity, xmax = -Infinity;
    const calc = (a: unknown): void => { if (a == null) return; if (Array.isArray(a) && typeof a[0] !== 'number') a.forEach(calc); else { const pt = a as number[]; xmin = min(xmin, pt[0]); xmax = max(xmax, pt[0]); } };
    (c === undefined) || calc(c);
    // 跨ぎ判定＝範囲外（連続表現）に加えて、範囲内でも「隣接頂点が混符号かつ経度差>180」（±179.9等＝エディタの
    // normLon 産の正規化表現）。ただし**両端とも**±180ちょうどのペア（+180→-180＝同じ子午線上の移動）は除外＝
    // 縫い目に**接する**だけ（南極型リング等）で跨ぎではない。片端だけが ±180 のペア（-180→+179.99 等）は
    // 「縫い目上の頂点で跨ぐ」＝跨ぎ（量子化/吸着格子で頂点がちょうど ±180 に載る円等・2026-09-12 geoedit で発覚）。
    // 切断器の fix() は +180 を保つ（-180 へ書き換えると西側の縫い目頂点が偽の跨ぎになる）。
    const hasJump = (a: unknown): boolean => !Array.isArray(a) || !a.length ? false
        : typeof a[0]?.[0] !== 'number' ? a.some(hasJump)
        : (a as LonLat[]).some((pt, i) => i + 1 < a.length && pt[0] * a[i + 1][0] < 0 && abs(a[i + 1][0] - pt[0]) > 180 && !(abs(pt[0]) === 180 && abs(a[i + 1][0]) === 180));
    if (xmin >= -180 && xmax <= 180 && !hasJump(c)) return toClockwise(feature);
    if (opts && opts.onCut) opts.onCut();
    let parts = (type.startsWith("Multi") ? c : [c]) as LonLat[][] | LonLat[][][];
    if (type.includes("LineString")) {
        let lines = parts as LonLat[][];
        // 頂点ごとの配列（GPX の trk・CZML の sampled position の time/ele＝LineString は平・MultiLineString は入れ子・点数と同じ長さ）は
        // 切った部品ごとに揃える（縫い目の点の値は内挿・#113 段 1）。点数の合わない配列は頂点ごとの物でない＝触らない
        const multi = type.startsWith("Multi"), perVertex = (k: string): boolean => { const v = p[k]; if (!Array.isArray(v)) return false;
            return multi ? v.length === lines.length && lines.every((l, i) => Array.isArray(v[i]) && v[i].length === l.length) : v.length === lines[0].length && !v.some(Array.isArray); };
        const keys = ["time", "ele"].filter(perVertex);
        if (keys.length) {
            const out: LonLat[][] = [], arrs: VertexAttr[][] = keys.map(() => []);
            lines.forEach((l, li) => { const r = antimeridianCutLineAttrs(l, keys.map(k => (multi ? (p[k] as VertexAttr[])[li] : p[k]) as VertexAttr)); out.push(...r.parts); r.attrs.forEach((a, ki) => arrs[ki].push(...a)); });
            lines = out; keys.forEach((k, ki) => { p[k] = lines.length > 1 ? arrs[ki] : arrs[ki][0]; });
        } else lines = lines.flatMap(t => antimeridianCut(t, true));
        feature.geometry = { type: lines.length > 1 ? "MultiLineString" : "LineString", coordinates: lines.length > 1 ? lines : lines[0] };
    } else if (type.includes("Polygon")) {
        const polys = (parts as LonLat[][][]).flatMap(poly => {
            const ext = antimeridianCut(poly[0]), holes = poly.slice(1).flatMap(h => antimeridianCut(h));
            return !holes.length ? ext.map(r => [r]) : ext.flatMap(r => subPolygon(r, holes));
        }).filter(p => p && p.length > 0 && p[0].length >= 4);
        if (!polys.length) return (feature.geometry = { type: "Polygon", coordinates: [] }, feature);
        feature.geometry = { type: polys.length > 1 ? "MultiPolygon" : "Polygon", coordinates: polys.length > 1 ? polys : polys[0] };
    }
    return toClockwise(feature);

    function subPolygon(ext: LonLat[], holes: LonLat[][]): LonLat[][][] {
        return [[ext, ...holes.filter(h => pointInRing(centroid(h), ext))]];
    }
    function centroid(ring: LonLat[]): LonLat {
        const n = ring.length - 1;
        let x = 0, y = 0;
        for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
        return [x / n, y / n];
    }
    function pointInRing([px, py]: LonLat, ring: LonLat[]): boolean { return pointInRingCore(px, py, ring, ring.length - 1); }   // 閉環＝末尾の複製点を除く
    function toClockwise(f: AMFeature): AMFeature {
        const fix = (r: LonLat[]): number => {
            let s = 0;
            for (let j = 0; j < r.length - 1; j++) {
                if (!r[j] || !r[j + 1]) { _tcWarn("toClockwise: undefined point at", j, r); continue; }
                s += (r[j + 1][0] - r[j][0]) * (r[j + 1][1] + r[j][1]);
            }
            return s;
        };
        // 巻き方向の正規化は面だけ。線（LineString/MultiLineString）に走ると点や数値を「空リング」と誤認して警告が出ていた。
        const rw = (t: AMGeometry): void => { if (!t.type || !t.type.includes("Polygon")) return;
            ((t.type === "Polygon" ? [t.coordinates] : t.coordinates || []) as LonLat[][][]).forEach(p => (p || []).forEach((r, i) => {
                if (!r || !r.length) { _tcWarn("toClockwise: undefined/empty ring at", i, p); return; }
                const s = fix(r); if ((!i && s < 0) || (i && s > 0)) r.reverse();
            })); };
        rw(f.geometry || (f as unknown as AMGeometry)); return f;
    }
}
