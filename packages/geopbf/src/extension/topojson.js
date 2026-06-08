import { gint } from "./gint.js";
import { topology, unPackGintBuffer } from "./topology.js";
////-----------------------------------------------------------------GeoJSONからtopojsonを作成
const types = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"];
export function topojson(self) {
    const { bbox, pointCount, pointBuffer, point, arcCount, arcBuffer, arcMeta, polygon, polyline } = self.unPackGint;
    const e = self.e;
    const arcs = [], mlen = 8;
    for (let i = 0; i < arcCount; i++) { let px = 0, py = 0;
        const off = arcMeta[i * mlen], len = arcMeta[i * mlen + 1], arc = new Array(len);
        for (let j = 0; j < len; j++) { const k = off + j;
            const [cx, cy] = gint.unpack(arcBuffer[k]);
            arc[j] = [Math.round((cx - px) * e), Math.round((cy - py) * e)]; px = cx; py = cy;
        }
        arcs.push(arc);
    }
	const topologies = {};
    [polygon, polyline, point].forEach((layer, type) => (layer||[]).forEach(([id, arcs]) => {
        topologies[id] = topologies[id] || [[], [], []];
        topologies[id][type] = arcs;
    }));
    const elem = ([id, a]) => { id = Number(id);
        const properties = self.getProperties(id);//下位クラスからpropertiesを取得
        const len = a.map(t => t.length);
        if (len[0] && !len[1] && !len[2]) return _polygon(a[0]);
        if (!len[0] && len[1] && !len[2]) return _polyline(a[1]);
        if (!len[0] && !len[1] && len[2]) return _point(a[2]);
        const type = types[6], geometries = [];
        len[0] && geometries.push(_polygon(a[0]));
        len[1] && geometries.push(_polyline(a[1]));
        len[2] && geometries.push(_point(a[2]));
        return { type, geometries, properties };
        function _polygon(p) {
            const isM = p.length > 1, type = types[isM ? 5 : 4];
            return { type, arcs: isM ? p : p[0], properties };
        }
        function _polyline(p) {
            const isM = p.length > 1, type = types[isM ? 3 : 2];
            return { type, arcs: isM ? p : p[0], properties };
        }
        function _point(p) {
            const isM = p.length > 1, type = types[isM ? 1 : 0];
            const trans = p => gint.unpack(pointBuffer[p]).map(t => Math.round(t * e));
            return { type, coordinates: isM ? p.map(trans) : trans(p[0]), properties };
        }
    };
    const type = "Topology";
    const geometries = Object.entries(topologies).map(elem);
    const collection = { type: types[6], geometries };
    const transform = { scale: [1 / e, 1 / e], translate: [0, 0] };
    return { type, bbox, arcs, transform, objects: { collection } };
}
////----------------------------------------------------------------- 指定したインデックスのFeatureと「Arcを共有している」隣接Featureを返す
export function neighbors(self, id) {
    const {neighbors} = self.unPackGint;
    return id == undefined ? neighbors : neighbors[id] || [];
}
////----------------------------------------------------------------- 境界線のみを抽出する mesh (条件: filterFunc(a, b) で隣接関係を判定)
export function mesh(self, opts = {}) {
    const arcs = findArcs(self, opts.filter).filter(([id, t]) => (t.length == 2)).map(t => t[0]);
    if (!!opts.arc) return { type, arcs };
    const coordinates = arcs.map(id => self.arcCoords(id));
    return { type:types[3], coordinates };
}
////-----------------------------------------------------------------  複数のポリゴンを単一の外郭に合体させる
export function merge(self, opts = {}) {
    let arcs = findArcs(self, opts.filter).filter(([id, t]) => (t.length == 1)).map(t => t[0]);
    arcs = stitchRings(self, arcs);
    if (!!opts.arc) return { type, arcs };
    const coordinates = [arcs.map(t => ringCoords(self, t))];
    return { type:types[5], coordinates };
}
////----------------------------------------------------------------- バラバラの外郭Arcを繋いで閉じたリング(一筆書き)を作る
function findArcs(self, filter) {
    filter = (typeof filter == 'function') ? filter : (t => true);
    const topo = buildTopology(self.topology);
    const hash = [];
    const set = (arc, id) => {
        arc.flat(Infinity).forEach(n => {
            const aid = n < 0 ? ~n : n;
            (hash[aid] = hash[aid] || []).push(n < 0 ? ~id : id);
        });
    };
    topo.forEach((t, id) => filter(self.getProperties(id)) && t[2].forEach(q => set(q, id)));
    return hash.map((t, id) => [id, t]);
}
function stitchRings(self, arcs) { if (!arcs || !arcs.length) return [];
    const { buffer, meta, mlen } = self.unPackGint;
    const pos = n => [meta[n * mlen], meta[n * mlen + 1]];
    const nodes = new Map(), used = new Set(), rings = [];
    arcs.forEach(id => {
        const [off, len] = pos(id)
        const p = buffer[off], q = buffer[off + len - 1];
        nodes.has(p) || nodes.set(p, []); nodes.get(p).push({ id, rev: false });
        nodes.has(q) || nodes.set(q, []); nodes.get(q).push({ id, rev: true });
    });
    for (const id of arcs) {
        if (used.has(id)) continue;
        let ring = [], curr = { id, rev: false };
        while (curr && !used.has(curr.id)) {
            used.add(curr.id);
            ring.push(curr.rev ? ~curr.id : curr.id);
            const [off, len] = pos(curr.id)
            const next = buffer[curr.rev ? off : off + len - 1];
            curr = (nodes.get(next) || []).find(n => !used.has(n.id));
        }
        if (ring.length) rings.push(ring);
    }
    return rings;
}
////----------------------------------------------------------------- arc => coordinates
function ringCoords(self, ring) {
    let coords = [];
    ring.forEach((aid, n) => {
        const a = self.arcCoords(aid);
        coords = coords.concat(n ? a.slice(1) : a)
    });
    return coords;
}
function arcCoords(self, aid) {
    const { buffer, meta, mlen } = self.polygon;
    const id = aid < 0 ? ~aid : aid;
    const off = meta[id * mlen], len = meta[id * mlen + 1];
    let pts = new Array(len);
    for (let i = 0; i < len; i++) pts[i] = gint.unpack(buffer[off + i]);
    return aid < 0 ? pts.reverse() : pts;
}
////===============================================================================================================
