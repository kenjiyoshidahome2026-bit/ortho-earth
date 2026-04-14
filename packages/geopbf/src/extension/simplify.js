import { gint } from "./gint.js";

const rad = Math.PI / 180;

const getPhysRank = (area) => {
    if (area <= 0) return 0;
    const rank = Math.floor(1.5 * Math.log2(area) - 8.2365);
    return Math.min(63, Math.max(0, rank));
};

export const simplify = (arc) => {
    const n = arc.length;
    if (n < 3) return;
    const xs = new Float64Array(n), ys = new Float64Array(n), prev = new Int32Array(n), next = new Int32Array(n);
    const areas = new Float64Array(n), heap = new Int32Array(n), pos = new Int32Array(n).fill(-1), eff = new Float64Array(n);
    let minLat = Infinity, maxLat = -Infinity;

    for (let i = 0; i < n; i++) {
        const [lng, lat] = gint.unpack(arc[i]);
        xs[i] = lng; ys[i] = lat; prev[i] = i - 1; next[i] = i + 1;
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }

    const cosLat = Math.cos(((minLat + maxLat) / 2) * rad);
    const getArea = (i) => {
        const p = prev[i], nx = next[i];
        if (p < 0 || nx >= n) return Infinity;
        return Math.abs((xs[i] - xs[p]) * cosLat * (ys[nx] - ys[p]) - (xs[nx] - xs[p]) * cosLat * (ys[i] - ys[p])) * 0.5;
    };

    const swap = (a, b) => { [heap[a], heap[b]] = [heap[b], heap[a]]; pos[heap[a]] = a; pos[heap[b]] = b; };
    const up = (i) => { for (; i > 0 && areas[heap[i]] < areas[heap[(i - 1) >>> 1]]; i = (i - 1) >>> 1) swap(i, (i - 1) >>> 1); };
    const down = (i) => {
        while (true) {
            let l = (i << 1) + 1, r = l + 1, d = l; if (l >= heapSize) break;
            if (r < heapSize && areas[heap[r]] < areas[heap[l]]) d = r;
            if (areas[heap[d]] >= areas[heap[i]]) break;
            swap(i, d); i = d;
        }
    };

    let heapSize = 0;
    for (let i = 1; i < n - 1; i++) { areas[i] = getArea(i); heap[heapSize] = i; pos[i] = heapSize; up(heapSize++); }

    let maxA = 0;
    while (heapSize > 0) {
        const curr = heap[0]; pos[curr] = -1;
        if (--heapSize > 0) { heap[0] = heap[heapSize]; pos[heap[0]] = 0; down(0); }
        maxA = Math.max(maxA, areas[curr]);
        eff[curr] = maxA;
        const p = prev[curr], nx = next[curr];
        if (p >= 0) next[p] = nx; if (nx < n) prev[nx] = p;
        [p, nx].forEach(idx => { if (idx > 0 && idx < n - 1 && pos[idx] !== -1) { areas[idx] = Math.max(getArea(idx), maxA); up(pos[idx]); down(pos[idx]); } });
    }

    for (let i = 1; i < n - 1; i++) arc[i] = gint.toL2(arc[i], getPhysRank(eff[i]));
};