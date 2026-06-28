import { gint } from "./gint.js";
import { topology, unPackGintBuffer } from "./topology.js";

const types = ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"];
export function topojson(self) {
	const { bbox, pointCount, pointBuffer, point: pointMeta, arcCount, arcBuffer, arcMeta, polygon, polyline } = self.unPackGint;
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
	// pointMeta[i] is the feature ID for the i-th pointBuffer entry; convert to [featureId, [indices]] format.
	const pointLayer = (() => {
		if (!pointMeta || !pointCount) return null;
		const tub = new Map();
		for (let i = 0; i < pointCount; i++) {
			const id = pointMeta[i];
			if (!tub.has(id)) tub.set(id, []);
			tub.get(id).push(i);
		}
		return tub.size > 0 ? [...tub.entries()] : null;
	})();
	const topologies = {};
	[polygon, polyline, pointLayer].forEach((layer, type) => (layer||[]).forEach(([id, arcs]) => {
		topologies[id] = topologies[id] || [[], [], []];
		topologies[id][type] = arcs;
	}));
	const elem = ([id, a]) => { id = Number(id);
		const properties = self.getProperties(id);
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

export function neighbors(self, id) {
	const { neighbors } = self.unPackGint;
	if (!neighbors) return [];
	return id === undefined ? neighbors : (neighbors[id] || []);
}

export function mesh(self, opts = {}) {
	// Keep only arcs shared by exactly two polygons.
	const arcs = findArcs(self, opts.filter).filter(([_, t]) => t.length === 2).map(t => t[0]);
	if (opts.arc) return { type: "Topology", arcs };
	const coordinates = arcs.map(id => self.arcCoords(id));
	return { type: types[3], coordinates };
}

export function merge(self, opts = {}) {
	let arcs = findArcs(self, opts.filter).filter(([_, t]) => t.length === 1).map(t => t[0]);
	arcs = stitchRings(self, arcs);
	if (opts.arc) return { type: "Topology", arcs };
	const coordinates = [arcs.map(t => ringCoords(self, t))];
	return { type: types[5], coordinates };
}

function findArcs(self, filter) {
	const filterFunc = (typeof filter === 'function') ? filter : () => true;
	const { polygon, polyline } = self.unPackGint;
	const hash = [];
	const collect = (layer) => {
		if (!layer) return;
		layer.forEach(([id, arcGroup]) => {
			if (!filterFunc(self.getProperties(id))) return;
			arcGroup.flat(Infinity).forEach(n => {
				const aid = n < 0 ? ~n : n;
				(hash[aid] = hash[aid] || []).push(n < 0 ? ~id : id);
			});
		});
	};
	collect(polygon);
	collect(polyline);
	return hash.map((t, id) => [id, t || []]);
}
function stitchRings(self, arcs) {
	if (!arcs || !arcs.length) return [];
	const { arcBuffer, arcMeta } = self.unPackGint;
	const mlen = 8;
	const nodes = new Map(), used = new Set(), rings = [];
	arcs.forEach(id => {
		const off = arcMeta[id * mlen];
		const len = arcMeta[id * mlen + 1];
		const p = arcBuffer[off];
		const q = arcBuffer[off + len - 1];

		if (!nodes.has(p)) nodes.set(p, []); nodes.get(p).push({ id, rev: false });
		if (!nodes.has(q)) nodes.set(q, []); nodes.get(q).push({ id, rev: true });
	});
	for (const id of arcs) {
		if (used.has(id)) continue;
		let ring = [], curr = { id, rev: false };
		while (curr && !used.has(curr.id)) {
			used.add(curr.id);
			ring.push(curr.rev ? ~curr.id : curr.id);
			const off = arcMeta[curr.id * mlen];
			const len = arcMeta[curr.id * mlen + 1];
			const next = arcBuffer[curr.rev ? off : off + len - 1];
			curr = (nodes.get(next) || []).find(n => !used.has(n.id));
		}
		if (ring.length) rings.push(ring);
	}
	return rings;
}

function ringCoords(self, ring) {
	let coords = [];
	ring.forEach((aid, n) => {
		const a = arcCoords(self, aid);
		coords = coords.concat(n ? a.slice(1) : a);
	});
	return coords;
}

function arcCoords(self, aid) {
	const { arcBuffer, arcMeta } = self.unPackGint;
	const id = aid < 0 ? ~aid : aid, mlen = 8;
	const off = arcMeta[id * mlen], len = arcMeta[id * mlen + 1];
	let pts = new Array(len);
	for (let i = 0; i < len; i++) pts[i] = gint.unpack(arcBuffer[off + i]);
	return aid < 0 ? pts.reverse() : pts;
}
