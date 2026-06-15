import { gint } from "./gint.js";

export function cleanTopology(gintData, options = {}) {
    if (!gintData || !gintData.arcBuffer) return;
    const snapDistSq = options.snapDistSq || 125;
    const gridUnit   = options.gridUnit   || 8; // L2格子(8単位)に合わせる
    const maxPasses  = options.maxPasses  || 4;

    for (let pass = 0; pass < maxPasses; pass++) {
        const { arcBuffer, arcMeta, polygon, polyline } = gintData;
        const intersections =
            gint.detectIntersections(arcBuffer, arcMeta, gintData.arcCount, snapDistSq, gridUnit)
            ?? _detectJS(arcBuffer, arcMeta, gintData.arcCount, snapDistSq, gridUnit);

        if (!intersections || intersections.size === 0) break;
        _apply(gintData, arcBuffer, arcMeta, polygon, polyline, intersections, gridUnit);
    }
}

// --- JS フォールバック（WASM 未初期化時）---
function _detectJS(arcBuffer, arcMeta, arcCount, snapDistSq, gridUnit) {
    const SNAP_DIST_SQ = BigInt(snapDistSq);
    const GRID_UNIT    = BigInt(gridUnit);
    const mlen = 8;

    const segments = [];
    for (let i = 0; i < arcCount; i++) {
        const mIdx = i * mlen, offset = arcMeta[mIdx], len = arcMeta[mIdx + 1];
        let p2 = gint.unpackToInt(arcBuffer[offset]);
        for (let j = 0; j < len - 1; j++) {
            const p1 = p2;
            p2 = gint.unpackToInt(arcBuffer[offset + j + 1]);
            segments.push({
                arcId: i, segIdx: j,
                x1: BigInt(p1[0]), y1: BigInt(p1[1]),
                x2: BigInt(p2[0]), y2: BigInt(p2[1]),
                bx1: Math.min(p1[0], p2[0]), bx2: Math.max(p1[0], p2[0]),
                by1: Math.min(p1[1], p2[1]), by2: Math.max(p1[1], p2[1]),
                p1Raw: arcBuffer[offset + j], p2Raw: arcBuffer[offset + j + 1]
            });
        }
    }

    let gBx1 = Infinity, gBx2 = -Infinity, gBy1 = Infinity, gBy2 = -Infinity;
    for (const s of segments) {
        if (s.bx1 < gBx1) gBx1 = s.bx1; if (s.bx2 > gBx2) gBx2 = s.bx2;
        if (s.by1 < gBy1) gBy1 = s.by1; if (s.by2 > gBy2) gBy2 = s.by2;
    }
    const nCells = Math.max(1, Math.ceil(Math.sqrt(segments.length)));
    const cellW  = Math.max(1, (gBx2 - gBx1) / nCells);
    const cellH  = Math.max(1, (gBy2 - gBy1) / nCells);
    const GY_MAX = nCells + 2;
    const grid   = new Map();
    const cellKey = (gx, gy) => gx * GY_MAX + gy;
    for (let i = 0; i < segments.length; i++) {
        const { bx1, bx2, by1, by2 } = segments[i];
        const x1g = Math.floor((bx1 - gBx1) / cellW), x2g = Math.floor((bx2 - gBx1) / cellW);
        const y1g = Math.floor((by1 - gBy1) / cellH), y2g = Math.floor((by2 - gBy1) / cellH);
        for (let gx = x1g; gx <= x2g; gx++)
            for (let gy = y1g; gy <= y2g; gy++) {
                const k = cellKey(gx, gy);
                if (!grid.has(k)) grid.set(k, []);
                grid.get(k).push(i);
            }
    }

    const intersections = new Map();
    for (let i = 0; i < segments.length; i++) {
        const s1 = segments[i];
        const x1g = Math.floor((s1.bx1 - gBx1) / cellW), x2g = Math.floor((s1.bx2 - gBx1) / cellW);
        const y1g = Math.floor((s1.by1 - gBy1) / cellH), y2g = Math.floor((s1.by2 - gBy1) / cellH);
        const candidates = new Set();
        for (let gx = x1g; gx <= x2g; gx++)
            for (let gy = y1g; gy <= y2g; gy++) {
                const cell = grid.get(cellKey(gx, gy));
                if (cell) for (const j of cell) { if (j > i) candidates.add(j); }
            }
        for (const j of candidates) {
            const s2 = segments[j];
            if (s1.arcId === s2.arcId && Math.abs(s1.segIdx - s2.segIdx) <= 1) continue;
            if (s1.bx2 < s2.bx1 || s1.bx1 > s2.bx2 || s1.by2 < s2.by1 || s1.by1 > s2.by2) continue;
            const dx1 = s1.x2 - s1.x1, dy1 = s1.y2 - s1.y1;
            const dx2 = s2.x2 - s2.x1, dy2 = s2.y2 - s2.y1;
            const det = dx1 * dy2 - dy1 * dx2;
            if (det === 0n) continue;
            const nt = (s2.x1 - s1.x1) * dy2 - (s2.y1 - s1.y1) * dx2;
            const nu = (s2.x1 - s1.x1) * dy1 - (s2.y1 - s1.y1) * dx1;
            const isIn = (n, d) => d > 0n ? (n >= 0n && n <= d) : (n <= 0n && n >= d);
            if (!isIn(nt, det) || !isIn(nu, det)) continue;
            const ix = s1.x1 + (nt * dx1) / det, iy = s1.y1 + (nt * dy1) / det;
            const eps = [
                { x: s1.x1, y: s1.y1, p: s1.p1Raw }, { x: s1.x2, y: s1.y2, p: s1.p2Raw },
                { x: s2.x1, y: s2.y1, p: s2.p1Raw }, { x: s2.x2, y: s2.y2, p: s2.p2Raw },
            ];
            let pt = null;
            for (const ep of eps) {
                const ddx = ix - ep.x, ddy = iy - ep.y;
                if (ddx * ddx + ddy * ddy <= SNAP_DIST_SQ) { pt = ep; break; }
            }
            if (!pt) {
                const sx = Number((ix + GRID_UNIT / 2n) / GRID_UNIT * GRID_UNIT);
                const sy = Number((iy + GRID_UNIT / 2n) / GRID_UNIT * GRID_UNIT);
                pt = { p: gint.packFromInt(sx, sy) };
            }
            const k1 = `${s1.arcId}-${s1.segIdx}`;
            const k2 = `${s2.arcId}-${s2.segIdx}`;
            if (!intersections.has(k1)) intersections.set(k1, []);
            if (!intersections.has(k2)) intersections.set(k2, []);
            intersections.get(k1).push(pt.p);
            intersections.get(k2).push(pt.p);
        }
    }
    return intersections;
}

// --- アーク分割・再構成 ---
function _apply(gintData, arcBuffer, arcMeta, polygon, polyline, intersections, gridUnit) {
    const mlen = 8;
    const nextMeta = [], nextBuffer = [];
    let currentOffset = 0;
    const arcRemap = new Map();

    for (let i = 0; i < gintData.arcCount; i++) {
        const mIdx = i * mlen, offset = arcMeta[mIdx], len = arcMeta[mIdx + 1];
        const weight = arcMeta[mIdx + 2];
        let currentArcPoints = [arcBuffer[offset]];
        const splittedArcs = [];
        for (let j = 0; j < len - 1; j++) {
            const key = `${i}-${j}`;
            if (intersections.has(key)) {
                const pts = intersections.get(key);
                // セグメント方向に沿ってt値でソート (複数交差点の順序を保証)
                const [ax, ay] = gint.unpackToInt(arcBuffer[offset + j]);
                const [bx, by] = gint.unpackToInt(arcBuffer[offset + j + 1]);
                const ddx = bx - ax, ddy = by - ay;
                const len2 = ddx * ddx + ddy * ddy;
                const sorted = pts
                    .map(p => {
                        const [px, py] = gint.unpackToInt(p);
                        const t = len2 > 0 ? ((px - ax) * ddx + (py - ay) * ddy) / len2 : 0;
                        return { p, t };
                    })
                    .sort((a, b) => a.t - b.t);
                // 重複除去 (同一BigUint64が複数記録された場合)
                const seenPts = new Set();
                for (const { p: crossPt } of sorted) {
                    if (seenPts.has(crossPt)) continue;
                    seenPts.add(crossPt);
                    if (currentArcPoints[currentArcPoints.length - 1] !== crossPt) {
                        currentArcPoints.push(crossPt);
                    }
                    if (currentArcPoints.length >= 2) splittedArcs.push(currentArcPoints);
                    currentArcPoints = [crossPt];
                }
                // t=1 の場合 crossPt === nextPt なので二重追加を防ぐ
                const nextPt = arcBuffer[offset + j + 1];
                if (currentArcPoints[currentArcPoints.length - 1] !== nextPt) {
                    currentArcPoints.push(nextPt);
                }
            } else {
                currentArcPoints.push(arcBuffer[offset + j + 1]);
            }
        }
        if (currentArcPoints.length >= 2) splittedArcs.push(currentArcPoints);

        const mappedIds = [];
        splittedArcs
            .filter(arc => {
                if (arc.length < 3 && arc[0] === arc[arc.length - 1]) return false;
                const pS = gint.unpackToInt(arc[0]), pE = gint.unpackToInt(arc[arc.length - 1]);
                return !(arc.length === 2 && pS[0] === pE[0] && pS[1] === pE[1]);
            })
            .forEach(arc => {
                const newId = nextMeta.length / mlen;
                mappedIds.push(newId);
                let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
                arc.forEach(p => {
                    const [ix, iy] = gint.unpackToInt(p);
                    if (ix < xmin) xmin = ix; if (ix > xmax) xmax = ix;
                    if (iy < ymin) ymin = iy; if (iy > ymax) ymax = iy;
                    nextBuffer.push(p);
                });
                nextMeta.push(currentOffset, arc.length, weight, 0, xmin, ymin, xmax, ymax);
                currentOffset += arc.length;
            });
        arcRemap.set(i, mappedIds);
    }

    const remap = arcIdx => {
        const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
        const mapped = arcRemap.get(aid) || [];
        return arcIdx < 0 ? [...mapped].reverse().map(t => ~t) : mapped;
    };
    // polygon: [id, [geoms]]  geom=[rings]  ring=[arcIdx,...]  ← 3階層
    // polyline:[id, [lines]]  line=[arcIdx,...]                ← 2階層
    gintData.polygon = polygon
        .map(([id, geoms]) => [
            id,
            geoms.map(rings =>
                rings.map(ringArcs => ringArcs.flatMap(remap)).filter(r => r.length > 0)
            ).filter(g => g.length > 0)
        ])
        .filter(([, geoms]) => geoms.length > 0);

    gintData.polyline = polyline
        .map(([id, lines]) => [
            id,
            lines.map(lineArcs => lineArcs.flatMap(remap)).filter(l => l.length > 0)
        ])
        .filter(([, lines]) => lines.length > 0);
    gintData.arcCount  = nextMeta.length / mlen;
    gintData.arcMeta   = new Uint32Array(nextMeta);
    gintData.arcBuffer = new BigUint64Array(nextBuffer);
}
