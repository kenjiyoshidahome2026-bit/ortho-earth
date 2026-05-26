import { GeoPBF } from "../pbf-base.js";
import { gint } from "./gint.js";
import { purify } from "./purifier.js";
import { simplify } from "./simplify.js";

const TAGS = GeoPBF.TAGS;

export function pbf2gint(self) {
    const structures = [[], [], []];
    const S = 1 / self.e;

    // 1. 3レイヤーへの解体ステージ
    self.each((id, map) => {
        const process = (pos, type) => {
            self.pbf.pos = pos;
            let lens = [], coords = [];
            self.pbf.readMessage((tag) => {
                if (tag === TAGS.LENGTH) self.pbf.readPackedVarint(lens);
                else if (tag === TAGS.COORDS) {
                    const end = self.pbf.readVarint() + self.pbf.pos;
                    let x = 0, y = 0;
                    const read = (n) => {
                        let c = [];
                        const grab = () => {
                            let dx = self.pbf.readSVarint(), dy = self.pbf.readSVarint();
                            if (dx || dy) { x += dx; y += dy; c.push(gint.pack([x * S, y * S])); }
                        };
                        if (n === undefined) { while (self.pbf.pos < end) grab(); }
                        else { while (n-- > 0) grab(); }
                        return new BigUint64Array(c);
                    };
                    const typeGroups = [
                        () => [read(1)], // Point
                        () => [read()],  // MultiPoint
                        () => [read()],  // LineString
                        () => lens.map(t => read(t)), // MultiLineString
                        () => [lens.map(t => read(t))], // Polygon
                        () => { // MultiPolygon
                            const c = []; let p = 0;
                            for (let i = 0; i < lens[0]; i++) {
                                let len = lens[++p]; c[i] = [];
                                for (let j = 0; j < len; j++) c[i].push(read(lens[++p]));
                            }
                            return c;
                        }
                    ];
                    coords = typeGroups[type]();
                }
            });
            const tIndex = type < 2 ? 2 : type < 4 ? 1 : 0;
            coords.forEach(c => structures[tIndex].push({ id, coords: c }));
        };
        if (map[2] === 6) map[3].forEach((p, j) => process(p, map[4][j]));
        else process(map[1], map[2]);
    });

    // 空間清浄化
    structures[0].forEach(t => {
        const tempRings = t.coords.map(ring => ({ coords: ring }));
        purify(tempRings);
        t.coords = tempRings.map(obj => obj.coords);
    });
    purify(structures[1]);

    // 一元プールへのノンストップ書き込み
    const globalMortonPool = [];
    const globalIndices = [];
    const featureMeta = [];

    const aHash = new Map();
    const vHash = new Map();

    let polygonCount = 0;
    let polylineCount = 0;
    let pointCount = 0;

    const buildLayerArcs = (topo, type) => {
        const isTerm = (arc, i) => (i === 0 || i === arc.length - 1 || (vHash.get(arc[i]) || 0) > 2);
        const flatten = type === "polygon" ? topo.flatMap(t => t.coords.flat()) : topo.flatMap(t => t.coords);
        flatten.forEach(arc => arc.forEach(p => vHash.set(p, (vHash.get(p) || 0) + 1)));

        const arcMetaLookup = new Map();

        topo.forEach(t => {
            const processArcStream = (arc) => {
                let i = 0, indices = [], n = arc.length;
                while (i < n - 1) {
                    let j = i + 1;
                    while (j < n - 1 && !isTerm(arc, j)) j++;
                    const seg = arc.subarray(i, j + 1);
                    const p = seg[0], q = seg[seg.length - 1];
                    const [min, max] = p > q ? [q, p] : [p, q];
                    const aKey = (min << 96n) | (max << 32n) | BigInt(seg.length);

                    if (!aHash.has(aKey)) {
                        const arcId = aHash.size;
                        aHash.set(aKey, arcId);
                        simplify(seg);

                        const absoluteByteOffset = globalMortonPool.length * 8;
                        seg.forEach(m => globalMortonPool.push(m));

                        const idxPos = globalIndices.length;
                        globalIndices.push(absoluteByteOffset, seg.length, t.id, 0xFFFFFFFF);
                        arcMetaLookup.set(arcId, { pos: idxPos, rev: p !== seg[0] });
                    } else {
                        const arcId = aHash.get(aKey);
                        const metaInfo = arcMetaLookup.get(arcId);
                        if (metaInfo) {
                            globalIndices[metaInfo.pos + 3] = t.id;
                        }
                    }

                    const idx = aHash.get(aKey);
                    indices.push(p === seg[0] ? idx : ~idx);
                    i = j;
                }
                return indices;
            };

            if (type === "polygon") {
                t.arcs = t.coords.map(r => processArcStream(r));
                const flatArcs = t.arcs.flat();
                const offset = featureMeta.length + 4;
                featureMeta.push(offset, flatArcs.length, t.id, 0);
                flatArcs.forEach(arcId => featureMeta.push(arcId));
                polygonCount++;
            } else {
                t.arcs = processArcStream(t.coords);
                const flatArcs = [t.arcs].flat();
                const offset = featureMeta.length + 4;
                featureMeta.push(offset, flatArcs.length, t.id, 1);
                flatArcs.forEach(arcId => featureMeta.push(arcId));
                polylineCount++;
            }
        });
    };

    buildLayerArcs(structures[0], "polygon");
    buildLayerArcs(structures[1], "polyline");

    if (structures[2].length) {
        const hash = new Map();
        structures[2].forEach(({ id, coords }) => { const a = hash.get(coords[0]) || []; a.push(id); hash.set(coords[0], a); });
        const buff = [...hash.entries()].sort((p, q) => p[0] > q[0] ? 1 : -1);

        buff.forEach(([key, owners]) => {
            const absoluteVertexIndex = globalMortonPool.length;
            globalMortonPool.push(key);
            owners.forEach(featId => {
                featureMeta.push(absoluteVertexIndex, 1, featId, 2);
                pointCount++;
            });
        });
    }

    // 鋳造ステージ
    const metaArray = new Uint32Array(featureMeta);
    const indicesArray = new Uint32Array(globalIndices);
    const bufferArray = new BigUint64Array(globalMortonPool);

    const totalBytes = 24 + metaArray.byteLength + indicesArray.byteLength + bufferArray.byteLength;
    const outBuffer = new ArrayBuffer(totalBytes);

    const headerView = new Uint32Array(outBuffer, 0, 6);
    headerView[0] = polygonCount;
    headerView[1] = polylineCount;
    headerView[2] = pointCount;
    headerView[3] = metaArray.byteLength;
    headerView[4] = indicesArray.byteLength;
    headerView[5] = bufferArray.byteLength;

    new Uint8Array(outBuffer, 24).set(new Uint8Array(metaArray.buffer));
    new Uint8Array(outBuffer, 24 + metaArray.byteLength).set(new Uint8Array(indicesArray.buffer));
    new Uint8Array(outBuffer, 24 + metaArray.byteLength + indicesArray.byteLength).set(new Uint8Array(bufferArray.buffer));

    return outBuffer;
}