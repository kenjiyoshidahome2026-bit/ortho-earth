import { gint } from "./gint.js";

export const purify = (topo) => {
    if (!topo || !topo.length) return;
    const GRID_SHIFT = 16, SNAP_DIST_SQ = 125n, GRID_UNIT = 10n;
    const checkedPairs = new Set(), segments = [], grid = new Map(), segLookup = new Map();
    const packXY = (x, y) => (BigInt(x) << 32n) | (BigInt(y) & 0xFFFFFFFFn);
    let globalSegIdx = 0;

    topo.forEach((line, lineIdx) => {
        const coords = line.coords;
        for (let i = 0; i < coords.length - 1; i++) {
            if (coords[i] === coords[i + 1]) continue;
            const p1 = gint.unpackToInt(coords[i]), p2 = gint.unpackToInt(coords[i + 1]);
            const sid = globalSegIdx++;
            const seg = {
                id: sid, lineIdx, sIdx: i,
                bx1: Math.min(p1[0], p2[0]), bx2: Math.max(p1[0], p2[0]),
                by1: Math.min(p1[1], p2[1]), by2: Math.max(p1[1], p2[1]),
                x1: BigInt(p1[0]), y1: BigInt(p1[1]), x2: BigInt(p2[0]), y2: BigInt(p2[1]),
                origP1: coords[i], origP2: coords[i + 1], intersections: new Map()
            };
            segments.push(seg);
            segLookup.set(`${lineIdx}-${i}`, seg);
            for (let gx = seg.bx1 >>> GRID_SHIFT; gx <= seg.bx2 >>> GRID_SHIFT; gx++) {
                for (let gy = seg.by1 >>> GRID_SHIFT; gy <= seg.by2 >>> GRID_SHIFT; gy++) {
                    const key = (gx << 16) | gy;
                    let cell = grid.get(key);
                    if (!cell) grid.set(key, cell = []);
                    cell.push(sid);
                }
            }
        }
    });

    for (const segIds of grid.values()) {
        if (segIds.length < 2 || segIds.length > 1500) continue;
        for (let i = 0; i < segIds.length; i++) {
            const s1 = segments[segIds[i]];
            for (let j = i + 1; j < segIds.length; j++) {
                const s2 = segments[segIds[j]];
                if (s1.lineIdx === s2.lineIdx && Math.abs(s1.sIdx - s2.sIdx) <= 1) continue;
                const pairKey = BigInt(s1.id) << 32n | BigInt(s2.id);
                if (checkedPairs.has(pairKey)) continue;
                checkedPairs.add(pairKey);
                if (s1.bx2 < s2.bx1 || s1.bx1 > s2.bx2 || s1.by2 < s2.by1 || s1.by1 > s2.by2) continue;
                const pts = solver(s1, s2, SNAP_DIST_SQ, GRID_UNIT);
                if (pts) pts.forEach(pt => {
                    const key = packXY(pt.x, pt.y);
                    s1.intersections.set(key, pt); s2.intersections.set(key, pt);
                });
            }
        }
    }

    topo.forEach((line, lineIdx) => {
        const final = [], original = line.coords;
        const pushClean = (p) => {
            const len = final.length;
            if (len > 0 && final[len - 1] === p) return;
            if (len > 1 && final[len - 2] === p) { final.pop(); return; }
            final.push(p);
        };
        for (let i = 0; i < original.length - 1; i++) {
            pushClean(original[i]);
            const seg = segLookup.get(`${lineIdx}-${i}`);
            if (seg && seg.intersections.size > 0) {
                const x1 = Number(seg.x1), y1 = Number(seg.y1);
                const pts = Array.from(seg.intersections.values());
                pts.sort((a, b) => ((a.x - x1) ** 2 + (a.y - y1) ** 2) - ((b.x - x1) ** 2 + (b.y - y1) ** 2));
                pts.forEach(pt => pushClean(pt.packed));
            }
        }
        pushClean(original[original.length - 1]);
        if (final.length >= 2) line.coords = new BigUint64Array(final);
    });

    function solver(s1, s2, snap, unit) {
        const dx1 = s1.x2 - s1.x1, dy1 = s1.y2 - s1.y1, dx2 = s2.x2 - s2.x1, dy2 = s2.y2 - s2.y1;
        const det = dx1 * dy2 - dy1 * dx2, pts = [];
        const eps = [{ x: s1.x1, y: s1.y1, p: s1.origP1 }, { x: s1.x2, y: s1.y2, p: s1.origP2 }, { x: s2.x1, y: s2.y1, p: s2.origP1 }, { x: s2.x2, y: s2.y2, p: s2.origP2 }];
        const getPt = (ix, iy) => {
            for (const ep of eps) if ((ix - ep.x) ** 2n + (iy - ep.y) ** 2n <= snap) return { x: Number(ep.x), y: Number(ep.y), packed: ep.p };
            const sx = Number((BigInt(ix) + unit / 2n) / unit * unit), sy = Number((BigInt(iy) + unit / 2n) / unit * unit);
            return { x: sx, y: sy, packed: gint.packFromInt(sx, sy) };
        };
        if (det === 0n) {
            const cross = (s2.x1 - s1.x1) * dy1 - (s2.y1 - s1.y1) * dx1;
            if (cross === 0n) {
                const on = (px, py, lx1, ly1, lx2, ly2) => { const dot = (px - lx1) * (lx2 - lx1) + (py - ly1) * (ly2 - ly1); return dot > 0n && dot < (lx2 - lx1) ** 2n + (ly2 - ly1) ** 2n; };
                eps.forEach(ep => { if (on(ep.x, ep.y, s1.x1, s1.y1, s1.x2, s1.y2) || on(ep.x, ep.y, s2.x1, s2.y1, s2.x2, s2.y2)) pts.push({ x: Number(ep.x), y: Number(ep.y), packed: ep.p }); });
            }
        } else {
            const nT = (s2.x1 - s1.x1) * dy2 - (s2.y1 - s1.y1) * dx2, nU = (s2.x1 - s1.x1) * dy1 - (s2.y1 - s1.y1) * dx1;
            const isIn = (n, d) => d > 0n ? (n >= 0n && n <= d) : (n <= 0n && n >= d);
            if (isIn(nT, det) && isIn(nU, det)) pts.push(getPt(s1.x1 + (nT * dx1) / det, s1.y1 + (nT * dy1) / det));
        }
        const proj = (px, py, lx1, ly1, lx2, ly2) => {
            const ldx = lx2 - lx1, ldy = ly2 - ly1, d2 = ldx * ldx + ldy * ldy; if (d2 === 0n) return null;
            const t = (px - lx1) * ldx + (py - ly1) * ldy; if (t <= 0n || t >= d2) return null;
            const crs = (px - lx1) * ldy - (py - ly1) * ldx; if ((crs * crs) / d2 <= snap) return getPt(lx1 + (t * ldx) / d2, ly1 + (t * ldy) / d2);
            return null;
        };
        [proj(s2.x1, s2.y1, s1.x1, s1.y1, s1.x2, s1.y2), proj(s2.x2, s2.y2, s1.x1, s1.y1, s1.x2, s1.y2), proj(s1.x1, s1.y1, s2.x1, s2.y1, s2.x2, s2.y2), proj(s1.x2, s1.y2, s2.x1, s2.y1, s2.x2, s2.y2)].forEach(p => p && pts.push(p));
        return pts.length ? pts : null;
    }
};