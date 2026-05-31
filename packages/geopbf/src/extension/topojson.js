//import { GeoPBF } from "../pbf-base.js";
import { gint } from "./gint.js";
import { topology, unPackGintBuffer } from "./topology.js";
////-----------------------------------------------------------------GeoJSONからtopojsonを作成
const types = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"];
export function topojson(self) {
    const buffer = topology(self);
    const unPackGint = unPackGintBuffer(buffer);
    const { bbox, pointCount, pointBuffer, point, arcCount, arcBuffer, arcMeta, polygon, polyline } = unPackGint;
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
            const isM = p.length > 1, type = types[isM ? 5 : 4];;
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
    const BBOX = [...gint.intToVal([bbox[0], bbox[1]]), ...gint.intToVal([bbox[2], bbox[3]])];
    const geometries = Object.entries(topologies).map(elem);
    const collection = { type: types[6], geometries };
    const transform = { scale: [1 / e, 1 / e], translate: [0, 0] };
    return { type, bbox: BBOX, arcs, transform, objects: { collection } };
}
////----------------------------------------------------------------- 指定したインデックスのFeatureと「Arcを共有している」隣接Featureを返す
export function neighbors(self, id) {
    const neighbor = buildNeighber(self.structures[2]);
    return id == undefined ? neighbor : neighbor[id] || [];
}
function buildNeighber(topo) {
	const neighbors = [];
	topo.forEach(q => neighbors[q.id] = q.neighbor);
	return neighbors;
}
////----------------------------------------------------------------- 境界線のみを抽出する mesh (条件: filterFunc(a, b) で隣接関係を判定)
export function mesh(self, opts = {}) {
    const type = types[3];
    const arcs = self.findArcs(opts.filter).filter(([id, t]) => (t.length == 2)).map(t => t[0]);
    if (!!opts.arc) return { type, arcs };
    const coordinates = arcs.map(id => self.arcCoords(id));
    return { type, coordinates };
}
////-----------------------------------------------------------------  複数のポリゴンを単一の外郭に合体させる
export function merge(self, opts = {}) {
    const type = types[5];
    let arcs = self.findArcs(opts.filter).filter(([id, t]) => (t.length == 1)).map(t => t[0]);
    arcs = self.stitchRings(arcs);
    if (!!opts.arc) return { type, arcs };
    const coordinates = [arcs.map(t => self.ringCoords(t))];
    return { type, coordinates };
}
////----------------------------------------------------------------- バラバラの外郭Arcを繋いで閉じたリング(一筆書き)を作る
function stitchRings(self, arcs) {
    if (!arcs || !arcs.length) return [];
    const { buffer, meta, mlen } = self.polygon;
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
export function identify(self, mx, my, scale, options = {}) {
	const pointError = ((options.point || 10) / scale) * 1e7;
	const polylineError = ((options.polyline || 5) / scale) * 1e7;
	const arcThreshold = (Radius / scale) * 0.5;
	const geo = unproject(mx, my); if (!geo) return null;
	const [mix, miy] = geo;
	if (self.points) {
		const owner = findPoint(self.points, mix, miy, pointError);
		if (owner !== null) return owner;
	}
	if (self.polylines) {
		const owner = findPolyline(self.polylines, mix, miy, polylineError, arcThreshold);
		if (owner !== null) return owner;
	}
	if (self.polygons) {
		const owner = findPolygon(self.polygons, mix, miy, self.structures[2]);
		if (owner !== null) return owner;
	}
	return null;
}
function findPoint(layer, mix, miy, error) {
	const { count, buffer, owners } = layer;
	const mMin = gint.packFromInt(mix - error, miy - error);
	const mMax = gint.packFromInt(mix + error, miy + error);
	const errSq = error * error;
	let low = 0, high = count - 1, start = 0;
	while (low <= high) { // Binary search to find mMin start
		let mid = (low + high) >>> 1;
		if (buffer[mid] < mMin) { low = mid + 1; start = low; }
		else high = mid - 1;
	}
	for (let i = start; i < count; i++) {
		const m = buffer[i];
		if (m > mMax) break;
		const [ix, iy] = gint.unpackToInt(m);
		const dx = ix - mix, dy = iy - miy;
		if (dx * dx + dy * dy <= errSq) return owners[i];
	}
	return null;
}
function findPolyline(layer, mix, miy, error, threshold) {
	const { count, buffer, meta, owners } = layer;
	const errSq = error * error;
	for (let i = 0; i < count; i += 8) {
		if (meta[i + 2] < threshold && meta[i + 2] !== 0) break; // Early Exit
		if (mix < meta[i + 4] - error || mix > meta[i + 6] + error ||
			miy < meta[i + 5] - error || miy > meta[i + 7] + error) continue;
		const offset = meta[i], len = meta[i + 1];
		for (let j = 0; j < len - 1; j++) {
			const d2 = distToSegSq(mix, miy, buffer[offset + j], buffer[offset + j + 1]);
			if (d2 <= errSq) return owners[i >> 3];
		}
	}
	return null;
	function distToSegSq(px, py, p1, p2) {
		const [x1, y1] = gint.unpackToInt(p1), [x2, y2] = gint.unpackToInt(p2);
		const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
		if (l2 === 0) return (px - x1) ** 2 + (py - y1) ** 2;
		let t = Math.max(0, Math.min(1, ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2));
		return (px - (x1 + t * (x2 - x1))) ** 2 + (py - (y1 + t * (y2 - y1))) ** 2;
	}
}
function findPolygon(layer, mix, miy, structures) {
	const { buffer, meta } = layer;
	for (let i = 0; i < structures.length; i++) {
		const { id, bbox, coords } = structures[i];
		if (mix < bbox[0] || mix > bbox[2] || miy < bbox[1] || miy > bbox[3]) continue;
		let inside = false;
		for (const ring of coords) {
			for (const arcIdx of ring) {
				const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
				const off = meta[aid << 3], len = meta[(aid << 3) + 1];
				for (let k = 0; k < len - 1; k++) {
					const [ix1, iy1] = gint.unpackToInt(buffer[off + k]);
					const [ix2, iy2] = gint.unpackToInt(buffer[off + k + 1]);
					if (((iy1 > miy) !== (iy2 > miy)) &&
						(mix < (ix2 - ix1) * (miy - iy1) / (iy2 - iy1) + ix1)) inside = !inside;
				}
			}
		}
		if (inside) return id;
	}
	return null;
}
