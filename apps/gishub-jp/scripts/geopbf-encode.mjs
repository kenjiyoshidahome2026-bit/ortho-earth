/**
 * GeoPBF エンコーダ（共有）。maff/maff-to-geopbf.js と同一ワイヤ仕様。
 * 観測点レイヤー等の静的GeoPBF生成で使う（jma/amedas, jishin/seismic …）。
 *
 *   import { encodeGeoPBF } from '../scripts/geopbf-encode.mjs';
 *   const buf = encodeGeoPBF(geojsonFeatures, { name, description, license, attribution });
 *
 * PRECISION=7 固定。Point/Line/Polygon/Multi系すべて対応。
 */
import Pbf from 'pbf';

const TAGS = { NAME:1, KEYS:2, PRECISION:3, FARRAY:5, FEATURE:6, GEOMETRY:7,
    GTYPE:8, LENGTH:9, COORDS:10, VALUE:11, INDEX:12, DESCRIPTION:14, LICENSE:15, ATTRIBUTION:16 };
const GTYPE = { Point:0, MultiPoint:1, LineString:2, MultiLineString:3, Polygon:4, MultiPolygon:5 };
const DTYPE = { NULL:0, BOOL:1, INTEGER:2, FLOAT:3, STRING:4 };
const PRECISION = 7;
const isFloat = n => typeof n === 'number' && !Number.isInteger(n);

function diffRing(ring, e) {
    const src = [];
    for (const pt of ring) {
        const ix = Math.round(pt[0]*e), iy = Math.round(pt[1]*e);
        if (!src.length || src[src.length-1][0] !== ix || src[src.length-1][1] !== iy) src.push([ix, iy]);
    }
    if (src.length < 3) return [];
    const p = []; let px = 0, py = 0;
    for (const [ix, iy] of src) { p.push([ix-px, iy-py]); px = ix; py = iy; }
    p.pop();
    return p;
}
function diffLine(line, e) {
    const src = [];
    for (const pt of line) {
        const ix = Math.round(pt[0]*e), iy = Math.round(pt[1]*e);
        if (!src.length || src[src.length-1][0] !== ix || src[src.length-1][1] !== iy) src.push([ix, iy]);
    }
    const p = []; let px = 0, py = 0;
    for (const [ix, iy] of src) { p.push([ix-px, iy-py]); px = ix; py = iy; }
    return p;
}
function writeGeometry(pbf, geom, e) {
    if (!geom?.coordinates) return;
    let gtype = GTYPE[geom.type];
    if (gtype === undefined) return;
    let c = geom.coordinates;
    if (gtype % 2 === 1 && c.length === 1) { gtype--; c = c[0]; }
    pbf.writeMessage(TAGS.GEOMETRY, () => {
        pbf.writeVarintField(TAGS.GTYPE, gtype);
        if (gtype === 0) pbf.writePackedSVarint(TAGS.COORDS, [Math.round(c[0]*e), Math.round(c[1]*e)]);
        else if (gtype === 1 || gtype === 2) pbf.writePackedSVarint(TAGS.COORDS, diffLine(c, e).flat());
        else if (gtype === 3) {
            const rings = c.map(l => diffLine(l, e)).filter(r => r.length > 0);
            pbf.writePackedVarint(TAGS.LENGTH, rings.map(r => r.length));
            pbf.writePackedSVarint(TAGS.COORDS, rings.flat().flat());
        } else if (gtype === 4) {
            const rings = c.map(r => diffRing(r, e)).filter(r => r.length > 0);
            pbf.writePackedVarint(TAGS.LENGTH, rings.map(r => r.length));
            pbf.writePackedSVarint(TAGS.COORDS, rings.flat().flat());
        } else if (gtype === 5) {
            const polys = c.map(poly => poly.map(r => diffRing(r, e)).filter(r => r.length > 0)).filter(p => p.length > 0);
            const lens = [polys.length];
            for (const poly of polys) { lens.push(poly.length); for (const ring of poly) lens.push(ring.length); }
            pbf.writePackedVarint(TAGS.LENGTH, lens);
            pbf.writePackedSVarint(TAGS.COORDS, polys.flat(2).flat());
        }
    });
}
function writeProperties(pbf, props, keyIdx) {
    if (!props) return;
    const index = [];
    for (const [key, val] of Object.entries(props)) {
        if (val == null || !(key in keyIdx)) continue;
        pbf.writeMessage(TAGS.VALUE, () => {
            if (typeof val === 'string')       pbf.writeStringField(DTYPE.STRING, val);
            else if (isFloat(val))             pbf.writeDoubleField(DTYPE.FLOAT, val);
            else if (typeof val === 'number')  pbf.writeSVarintField(DTYPE.INTEGER, val);
            else if (typeof val === 'boolean') pbf.writeBooleanField(DTYPE.BOOL, val);
        });
        index.push(keyIdx[key]);
    }
    if (index.length) pbf.writePackedVarint(TAGS.INDEX, index);
}

export function encodeGeoPBF(features, opts = {}) {
    const { name='', description='', license='', attribution='' } = opts;
    const e = Math.pow(10, PRECISION);
    const keySet = new Set();
    for (const f of features) if (f.properties) for (const k of Object.keys(f.properties)) keySet.add(k);
    const keys = [...keySet].sort();
    const keyIdx = Object.fromEntries(keys.map((k, i) => [k, i]));
    const pbf = new Pbf();
    if (name)        pbf.writeStringField(TAGS.NAME, name);
    if (description) pbf.writeStringField(TAGS.DESCRIPTION, description);
    if (license)     pbf.writeStringField(TAGS.LICENSE, license);
    if (attribution) pbf.writeStringField(TAGS.ATTRIBUTION, attribution);
    pbf.writeVarintField(TAGS.PRECISION, PRECISION);
    for (const k of keys) pbf.writeStringField(TAGS.KEYS, k);
    pbf.writeMessage(TAGS.FARRAY, () => {
        for (const f of features) pbf.writeMessage(TAGS.FEATURE, () => {
            writeGeometry(pbf, f.geometry, e);
            writeProperties(pbf, f.properties, keyIdx);
        });
    });
    return Buffer.from(pbf.finish());
}
