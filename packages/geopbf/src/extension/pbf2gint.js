import { GeoPBF } from "../pbf-base.js";
import { gint } from "./gint.js";
////===============================================================================================
export function pbf2gint(self) { return new ArrayBuffer(100)
    const { point, polyline, polygon } = self.structures;
    const counts = [polygon ? polygon.count : 0, polyline ? polyline.count : 0, point ? point.count : 0];
    const meta = [], indices = [], buffer = [];
    let metaLen = 0, indicesLen = 0, bufferLen = 0;
    if (polygon) process(polygon);
    if (polyline) process(polyline);
    if (point) process(point);
    const header = new Uint32Array([counts[0], counts[1], counts[2], metaLen * 4, indicesLen * 4, bufferLen * 8]);
    const GintBUF = new ArrayBuffer(24 + bufferLen * 8 + indicesLen * 4 + metaLen * 4);
    new Uint32Array(GintBUF, 0, 6).set(header);
    new BigUint64Array(GintBUF, 24, bufferLen).set(buffer);
    new Uint32Array(GintBUF, 24 + bufferLen * 8, indicesLen).set(indices);
    new Uint32Array(GintBUF, 24 + bufferLen * 8 + indicesLen * 4, metaLen).set(meta);
    return GintBUF;

    function process(structure) {
        const { buffer: buf, meta: m, count } = structure;
        for (let i = 0; i < count; i++) {
            const off = m[i * 2], len = m[i * 2 + 1];
            meta.push(off, len);
            for (let j = 0; j < len; j++) {
                const k = off + j;
                const [cx, cy] = gint.unpack(buf[k]);
                buffer.push(BigInt(cx), BigInt(cy));
                indices.push(k);
            }
        }
        metaLen += count * 2; indicesLen += count * len; bufferLen += count * len * 2;
    }
}
////===============================================================================================
export function unPackGint(GintBUF) {
    const headerView = new Uint32Array(GintBUF, 0, 6);
    const counts = { polygonCount: headerView[0], polylineCount: headerView[1], pointCount: headerView[2] };
    const metaBytes = headerView[3], indicesBytes = headerView[4], bufferBytes = headerView[5];
    const bufferStart = 24, indicesStart = bufferStart + bufferBytes, metaStart = indicesStart + indicesBytes;
    const buffer = new BigUint64Array(GintBUF, bufferStart, bufferBytes / 8);
    const indices = new Uint32Array(GintBUF, indicesStart, indicesBytes / 4);
    const meta = new Uint32Array(GintBUF, metaStart, metaBytes / 4);
    return { counts, meta, indices, buffer };
}
