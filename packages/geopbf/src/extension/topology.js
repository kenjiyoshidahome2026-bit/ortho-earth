import { GeoPBF } from "../pbf-base.js";
import { gint } from "./gint.js";
const RAD = Math.PI / 180;
const Radius = 6371008.8; // 地球平均半径 (Meters)
////===============================================================================================================
////	BBOX & Coherence
////===============================================================================================================
function initBbox() { return new Uint32Array([0xFFFFFFFF, 0xFFFFFFFF, 0, 0]); }
function updateBbox(BBOX, bbox) {
	if (bbox[0] < BBOX[0]) BBOX[0] = bbox[0];
	if (bbox[2] > BBOX[2]) BBOX[2] = bbox[2];
	if (bbox[1] < BBOX[1]) BBOX[1] = bbox[1];
	if (bbox[3] > BBOX[3]) BBOX[3] = bbox[3];
}
export function checkCoherence(fB, vB) { // コヒーレンス判定: 0:Outside, 1:Partial, 2:Full-In
	if (fB[2] < vB.minX || fB[0] > vB.maxX || fB[3] < vB.minY || fB[1] > vB.maxY) return 0; // 完全に画面外 (Cull)
	if (fB[0] >= vB.minX && fB[2] <= vB.maxX && fB[1] >= vB.minY && fB[3] <= vB.maxY) return 2; // 完全に画面内 (No Clip)
	return 1; // 一部が重なっている (Partial)
}
////===============================================================================================================
export function topology(self) { //if (self.structures) return self.structures;
	const { pbf, e } = self;
	const structures = [[], [], []], S = 1 / e;
	const elemCount = [0, 0, 0, 0];
	let propTub = new Map(); let propCount = 0;
//	let IDTUB = new Array(self.length);
	self.each((i, map) => { const key = self.props[i].join("|");
		if (!propTub.has(key)) propTub.set(key, i);
		const id = propTub.get(key);
	//	IDTUB[i] = id;
		const process = (pos, type) => {
			pbf.pos = pos;
			let lens = [], coords = [];
			pbf.readMessage((tag) => {
				if (tag === GeoPBF.TAGS.LENGTH) pbf.readPackedVarint(lens);
				else if (tag === GeoPBF.TAGS.COORDS) {
					const end = pbf.readVarint() + pbf.pos;
					let x = 0, y = 0;
					const read = (n) => {
						let c = [];
						const grab = () => { elemCount[3]++;
							let dx = pbf.readSVarint(), dy = pbf.readSVarint();
							if (dx || dy) { x += dx; y += dy; c.push(gint.pack([x * S, y * S])); }
						};
						if (n === undefined) { while (pbf.pos < end) grab(); }
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
			elemCount[tIndex] += coords.length;
			coords.forEach(c => structures[tIndex].push({ id, coords: c }));
		};
		(map[2] === 6)? map[3].forEach((p, j) => process(p, map[4][j])): process(map[1], map[2]);
	});
	propTub.clear(); propTub = null;
////-----------------------------------------------------------------------------------------------
	const polygon = buildPolygons(structures[0]);
	const polyline = buildPolylines(structures[1], polygon? polygon.count: 0);
	const point = buildPoints(structures[2]);
	const pointCount = point? point.count: 0; if(pointCount) elemCount[2] = pointCount;
	let polygonTub = {}, polylineTub = {}, neighborTub = {};
	const owner = [];
	structures[0].forEach(({ id, arcs }) => { polygonTub[id] = polygonTub[id] || []; polygonTub[id].push(arcs);});
	structures[1].forEach(({ id, arcs }) => { polylineTub[id] = polylineTub[id] || []; polylineTub[id].push(arcs); });
	structures[0].forEach(({ id, arcs }) => { 
		arcs.forEach(t=>{ t.forEach(arc=>{ arc = arc < 0 ? ~arc : arc;
			owner[arc] = owner[arc] || []; owner[arc].push(id);
		});});
	});
	owner.filter(ids=>ids.length > 1).forEach(ids => {
		 ids.forEach(id => { neighborTub[id] = neighborTub[id] || new Set();
			ids.filter(t => t !== id).forEach(t => neighborTub[id].add(t)); }); // 隣接関係の構築 (同一Arcを共有するFeatureは隣接とみなす)
	});
	polygonTub = Object.entries(polygonTub).map(([k, v]) => [Number(k), v]);
	polylineTub = Object.entries(polylineTub).map(([k, v]) => [Number(k), v]);
	neighborTub = Object.entries(neighborTub).map(([k, v]) => [Number(k), [...v].sort((a, b) => a - b)]);
	const topology = JSON.stringify([polygonTub, polylineTub, neighborTub]);
	const bbox = initBbox();
	polygon && updateBbox(bbox, polygon.bbox);
	polyline && updateBbox(bbox, polyline.bbox);
	point && updateBbox(bbox, point.bbox);
	const arcLength = ((polygon? polygon.buffer.length : 0) + (polyline? polyline.buffer.length : 0));
	const arcCount = (polygon? polygon.count:0) + (polyline? polyline.count:0), mlen = 8;
	const gintHeader = new Uint32Array(new TextEncoder().encode("Gint").buffer)[0], gintVersion = 1;
	const header = new Uint32Array([gintHeader, gintVersion, ...elemCount, arcLength, arcCount, ...bbox]);
	const headLength = header.length;
	const totalLength = headLength * 4 + arcLength * 8 + arcCount * mlen * 4 + pointCount * (8+4) + topology.length;
	const GintBUF = new ArrayBuffer(totalLength), view = new Uint8Array(GintBUF);
	let ptr = 0;
	view.set(new Uint8Array(header.buffer), 0); ptr += headLength * 4;
	polygon && (view.set(new Uint8Array(polygon.buffer.buffer), ptr), ptr += polygon.buffer.length * 8);
	polyline && (view.set(new Uint8Array(polyline.buffer.buffer), ptr), ptr += polyline.buffer.length * 8);
	point && (view.set(new Uint8Array(point.buffer.buffer), ptr), ptr += point.buffer.length * 8);
	polygon && (view.set(new Uint8Array(polygon.meta.buffer), ptr), ptr += polygon.meta.length * 4);
	polyline && (view.set(new Uint8Array(polyline.meta.buffer), ptr), ptr += polyline.meta.length * 4);
	point && (view.set(new Uint8Array(point.owner.buffer), ptr), ptr += point.owner.length * 4);
	view.set(new Uint8Array(new TextEncoder().encode(topology)), ptr), ptr += topology.length;
	if (totalLength !== ptr) throw new Error(`GintBUF length mismatch: expected ${totalLength}, got ${ptr}`);
//	console.log(unPackGintBuffer(GintBUF));
	return GintBUF;
}
export function unPackGintBuffer(GintBUF) {
	try { let ptr = 0;
		const view = new Uint8Array(GintBUF), mlen = 8;
		const header = new Uint32Array(GintBUF, 0, 12); ptr += header.length * 4;
		if (header[0] != 1953392967) throw new Error("Invalid Gint buffer");
		if (header[1] != 1) throw new Error("Unsupported Gint version");
		const polygonCount = header[2], polylineCount = header[3], pointCount = header[4], nodeCount = header[5];
		const arcLength = header[6], arcCount = header[7], bbox = header.slice(8, 12);
		const arcBuffer = arcLength ? new BigUint64Array(GintBUF, ptr, arcLength) : null; ptr += arcLength * 8;
		const pointBuffer = pointCount ? new BigUint64Array(GintBUF, ptr, pointCount) : null; ptr += pointCount * 8;
		const arcMeta = arcCount ? new Uint32Array(GintBUF, ptr, arcCount * mlen) : null; ptr += arcCount * mlen * 4;
		const point = pointCount ? new Uint32Array(GintBUF, ptr, pointCount) : null; ptr += pointCount * 4;
		const [polygon, polyline, neighbors] = JSON.parse(new TextDecoder().decode(new Uint8Array(GintBUF, ptr)));
		return { polygonCount, polylineCount, pointCount, nodeCount, arcCount, bbox,
			arcBuffer, arcMeta, polygon, polyline, pointBuffer, point, neighbors }
	} catch (e) { console.error("Failed to unpack Gint buffer:", e); return null; }
}
////===============================================================================================================
////	POINT
////===============================================================================================================
function buildPoints(topo) { if (!topo.length) return null;
	const a = topo.map(({ id, coords })=>[coords, id]).sort((a, b) => a[0] > b[0] ? 1 : -1), count = a.length;
	const buffer = new BigUint64Array(count), meta = new Uint32Array(count), bbox = initBbox();
	a.forEach(([coords, id], i) => { buffer[i] = coords; meta[i] = id;
		const [x, y] = gint.unpackToInt(coords); updateBbox(bbox, [x, y, x, y]);
	});
	return { count, buffer, meta, bbox };
}
////===============================================================================================================
////	POLYLINE
////===============================================================================================================
function buildPolylines(topo, n_poly = 0) { if (!topo.length) return null;
	purifier(topo);
	const buffs = cutPolyline(topo, n_poly);
	const meta = metaArc(buffs);
	metaPolyline(meta, topo);
	return buildArcs(buffs, meta);
}
function purifier(topo) { if (!topo || !topo.length) return 0;
	const GRID_SHIFT = 16;
	const SNAP_DIST_SQ = 125n; // 11cm
	const GRID_UNIT = 10n;     // 10cm格子
	const checkedPairs = new Set();
	const segments = [];
	const grid = new Map();
	const segLookup = new Map();
	const packXY = (x, y) => (BigInt(x) << 32n) | (BigInt(y) & 0xFFFFFFFFn);// 座標パッキング用：(x, y) -> BigInt
	let globalSegIdx = 0;// セグメント登録
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
				x1: BigInt(p1[0]), y1: BigInt(p1[1]),
				x2: BigInt(p2[0]), y2: BigInt(p2[1]),
				origP1: coords[i], origP2: coords[i + 1],
				intersections: new Map() // Key: PackedBigInt, Value: {x, y, packed}
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
	for (const segIds of grid.values()) {// 高精度交差エンジン
		if (segIds.length < 2 || segIds.length > 1500) continue;
		for (let i = 0; i < segIds.length; i++) {
			const s1 = segments[segIds[i]];
			for (let j = i + 1; j < segIds.length; j++) {
				const s2 = segments[segIds[j]];
				if (s1.lineIdx === s2.lineIdx && Math.abs(s1.sIdx - s2.sIdx) <= 1) continue;
				const pairKey = BigInt(s1.id) << 32n | BigInt(s2.id);// ペアリングのハッシュ化
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
	checkedPairs.clear();
	topo.forEach((line, lineIdx) => {
		const final = [];
		const original = line.coords;
		const pushClean = (p) => {
			const len = final.length;
			if (len > 0 && final[len - 1] === p) return;
			if (len > 1 && final[len - 2] === p) { final.pop(); return; }// A-B-A スパイク除去
			final.push(p);
		};
		for (let i = 0; i < original.length - 1; i++) {
			pushClean(original[i]);
			const seg = segLookup.get(`${lineIdx}-${i}`);
			if (seg && seg.intersections.size > 0) {
				const x1 = Number(seg.x1), y1 = Number(seg.y1);
				const pts = Array.from(seg.intersections.values());
				// 距離二乗: $d^2 = (x - x_1)^2 + (y - y_1)^2$
				pts.sort((a, b) => ((a.x - x1) ** 2 + (a.y - y1) ** 2) - ((b.x - x1) ** 2 + (b.y - y1) ** 2));
				pts.forEach(pt => pushClean(pt.packed));
			}
		}
		pushClean(original[original.length - 1]);
		if (final.length >= 2) line.coords = new BigUint64Array(final);
	});
	function solver(s1, s2, snap, unit) {
		const dx1 = s1.x2 - s1.x1, dy1 = s1.y2 - s1.y1;
		const dx2 = s2.x2 - s2.x1, dy2 = s2.y2 - s2.y1;
		const det = dx1 * dy2 - dy1 * dx2; // 行列式: $det = \Delta x_1 \Delta y_2 - \Delta y_1 \Delta x_2$
		const pts = [];
		const eps = [
			{ x: s1.x1, y: s1.y1, p: s1.origP1 }, { x: s1.x2, y: s1.y2, p: s1.origP2 },
			{ x: s2.x1, y: s2.y1, p: s2.origP1 }, { x: s2.x2, y: s2.y2, p: s2.origP2 }
		];
		const getPt = (ix, iy) => {
			for (const ep of eps) {
				if ((ix - ep.x) ** 2n + (iy - ep.y) ** 2n <= snap) return { x: Number(ep.x), y: Number(ep.y), packed: ep.p };
			}
			const sx = Number((BigInt(ix) + unit / 2n) / unit * unit);
			const sy = Number((BigInt(iy) + unit / 2n) / unit * unit);
			return { x: sx, y: sy, packed: gint.packFromInt(sx, sy) };
		};
		if (det === 0n) {
			const cross = (s2.x1 - s1.x1) * dy1 - (s2.y1 - s1.y1) * dx1;
			if (cross === 0n) {
				const on = (px, py, lx1, ly1, lx2, ly2) => {
					const dot = (px - lx1) * (lx2 - lx1) + (py - ly1) * (ly2 - ly1);
					return dot > 0n && dot < (lx2 - lx1) ** 2n + (ly2 - ly1) ** 2n;
				};
				eps.forEach(ep => { if (on(ep.x, ep.y, s1.x1, s1.y1, s1.x2, s1.y2) || on(ep.x, ep.y, s2.x1, s2.y1, s2.x2, s2.y2)) pts.push({ x: Number(ep.x), y: Number(ep.y), packed: ep.p }); });
			}
		} else {
			const nT = (s2.x1 - s1.x1) * dy2 - (s2.y1 - s1.y1) * dx2;
			const nU = (s2.x1 - s1.x1) * dy1 - (s2.y1 - s1.y1) * dx1;
			const isIn = (n, d) => d > 0n ? (n >= 0n && n <= d) : (n <= 0n && n >= d);
			if (isIn(nT, det) && isIn(nU, det)) pts.push(getPt(s1.x1 + (nT * dx1) / det, s1.y1 + (nT * dy1) / det));
		}
		const proj = (px, py, lx1, ly1, lx2, ly2) => {
			const ldx = lx2 - lx1, ldy = ly2 - ly1, d2 = ldx * ldx + ldy * ldy;
			if (d2 === 0n) return null;
			const t = (px - lx1) * ldx + (py - ly1) * ldy;
			if (t <= 0n || t >= d2) return null;
			const crs = (px - lx1) * ldy - (py - ly1) * ldx;
			if ((crs * crs) / d2 <= snap) return getPt(lx1 + (t * ldx) / d2, ly1 + (t * ldy) / d2);
			return null;
		};
		[proj(s2.x1, s2.y1, s1.x1, s1.y1, s1.x2, s1.y2), proj(s2.x2, s2.y2, s1.x1, s1.y1, s1.x2, s1.y2),
		proj(s1.x1, s1.y1, s2.x1, s2.y1, s2.x2, s2.y2), proj(s1.x2, s1.y2, s2.x1, s2.y1, s2.x2, s2.y2)]
			.forEach(p => p && pts.push(p));
		return pts.length ? pts : null;
	}
}
function cutPolyline(topo, n_poly) {
	const buffs = [];
	let hash = new Map(), aHash = new Map();
	topo.forEach(setHash);
	topo.forEach(setEdge);
	hash.clear(); aHash.clear(); hash = null; aHash = null;
	return buffs;
	function setHash(q) { q.coords.forEach(t => hash.set(t, (hash.get(t) || 0) + 1)); }
	function setEdge(q) { //const {id, coords} = q; //const arc = coords;
		const isTerm = (arc, i) => {
			const n = arc.length, count = hash.get(arc[i]);
			return (i === 0 || i === n - 1 || count > 2);
		};
		q.arcs = splitArc(q.coords);//.map();
		delete q.coords;
		function splitArc(arc) {
			let i = 0;
			const indices = [], n = arc.length;
			while (i < n - 1) {
				let j = i + 1;
				while (j < n - 1 && !isTerm(arc, j)) j++;
				const seg = arc.subarray(i, j + 1);
				const p = seg[0], q = seg[seg.length - 1];
				const [min, max] = p > q ? [q, p] : [p, q];
				const aKey = (min << 96n) | (max << 32n) | BigInt(seg.length);
				if (!aHash.has(aKey)) { aHash.set(aKey, buffs.length); buffs.push(seg); }
				const idx = aHash.get(aKey);
				const forward = p === buffs[idx][0];
				indices.push(forward ? idx+n_poly : ~(idx+n_poly));
				i = j;
			}
			return indices;
		}
	}
}
function metaPolyline(metas, topo) {
	topo.forEach(calcMeta);
	topo.sort((p, q) => p.length > q.length ? -1 : 1);
	metas.sort((p, q) => p.length > q.length ? -1 : 1);
	metas.forEach(q => { q.weight = q.length; delete q.length; });
	var map = new Array(metas.length);
	for (let i = 0; i < metas.length; i++) map[metas[i].aid] = i;
	topo.forEach(t => t.arcs = t.arcs.map(t => t < 0 ? ~map[~t] : map[t]));
	function calcMeta(q) {
		const { id, arcs } = q;
		q.length = 0;
		arcs.forEach(aid => {
			const p = metas[aid < 0 ? ~aid : aid];
			q.length += p.length;
			(p.owner = p.owner || []).push(aid < 0 ? ~id : id);
		});
	}
}
////===============================================================================================================
////	POLYLGON
////===============================================================================================================
function buildPolygons(topo) { if (!topo.length) return null;
	const buffs = cutPolygon(topo);
	const owner = metaArc(buffs);
	metaPolygon(owner, topo);
	return buildArcs(buffs, owner);
}
function cutPolygon(topo) {
	const buffs = [];
	let hash = new Map(), aHash = new Map();
	topo.forEach(setHash);
	topo.forEach(setEdge);
	hash.clear(); aHash.clear(); hash = null; aHash = null;
	return buffs;
	function setHash(q) { q.coords.forEach(t => t.forEach(t => hash.set(t, (hash.get(t) || 0) + 1))); }
	function setEdge(q) { //const {id, coords} = q;
		const isTerm = (arc, i) => {//端点かどうかの判定
			const n = arc.length, count = hash.get(arc[i]);
			if (count > 2) return true;
			if (count == 2 && hash.get(arc[(i - 1 + n) % n]) == 1) return true;
			if (count == 2 && hash.get(arc[(i + 1) % n]) == 1) return true;
			return false;
		};
		q.arcs = q.coords.map(splitRing);
		delete q.coords;
		////------------------------------------------
		function splitArc(arc, loop) {
			let i = 0;
			const indices = [], n = arc.length;
			if (loop) { // 単独ポリゴン(島・飛地等)
				const aKey = (arc[0] << 32n) | BigInt(n);
				if (!aHash.has(aKey)) { aHash.set(aKey, buffs.length); buffs.push(arc); }
				const idx = aHash.get(aKey);
				return [loop > 0 ? idx : ~idx];
			}
			while (i < n - 1) {
				let j = i + 1;
				while (j < n - 1 && !isTerm(arc, j)) j++;
				const seg = arc.subarray(i, j + 1);
				const p = seg[0], q = seg[seg.length - 1];
				const [min, max] = p > q ? [q, p] : [p, q];
				const aKey = (min << 96n) | (max << 32n) | BigInt(seg.length);
				if (!aHash.has(aKey)) { aHash.set(aKey, buffs.length); buffs.push(seg); }
				const idx = aHash.get(aKey);
				const forward = p === buffs[idx][0];
				indices.push(forward ? idx : ~idx);
				i = j;
			}
			return indices;
		}
		function splitRing(ring) {
			let start = 0, loop = 0;
			let n = ring.length;
			while (ring[0] == ring[n - 1] && n > 2) n--;
			if (n < 3) return [];
			for (let k = 0; k < n; k++) if (isTerm(ring, k)) { start = k; break; }
			isTerm(ring, start) || cutRing(ring); //ループしているポリゴンはどこで始まるか分からないので最大値で切る。
			const rotated = new BigUint64Array(n + 1);
			rotated.set(ring.subarray(start, n), 0);
			rotated.set(ring.subarray(0, start), n - start);
			rotated[n] = ring[start];
			return splitArc(rotated, loop);
			function cutRing(ring) {
				const len = ring.length;
				const c = [];
				for (let i = 0; i < len; i++) c[i] = gint.unpack(ring[i])
				let sum = 0, max = 0;
				for (let i = 0; i < len; i++) {
					const p = c[i], q = i + 1 == len ? c[0] : c[i + 1];
					sum += (q[0] - p[0]) * (q[1] + p[1]);
					if (ring[i] > max) { max = ring[i]; start = i; }
				}
				c.length = 0;
				loop = sum > 0 ? 1 : -1;// 1:時計回り、-1:反時計回り
			}
		}
	}
}
function metaPolygon(metas, topo) {
	topo.forEach(calcMeta)
	topo.sort((p, q) => p.weight > q.weight ? -1 : 1);
	const max_weight = topo[0].weight;
	metas.forEach(p => p.owner.length == 1 && !p.closed && (p.weight = max_weight));
	metas.sort((p, q) => p.weight > q.weight ? -1 : 1);
	var map = new Array(metas.length);
	for (let i = 0; i < metas.length; i++) map[metas[i].aid] = i;
	topo.forEach(t => t.arcs = t.arcs.map(t => t.map(t => t < 0 ? ~map[~t] : map[t])));
	function calcMeta(q) {
		const { id, arcs } = q;
		let A = 0, L = 0;
		q.bbox = initBbox();
		arcs[0].forEach(aid => {//debugger
			const { area, length, bbox } = metas[aid < 0 ? ~aid : aid];
			L += length, A += aid < 0 ? -area : area;
			updateBbox(q.bbox, bbox)
		});
		for (let i = 1; i < arcs.length; i++) {
			arcs[i].forEach(aid => {
				const { area } = metas[aid < 0 ? ~aid : aid];
				A += aid < 0 ? -area : area;
			});
		}
		q.weight = Math.sqrt(Math.abs(A) / 2) + L / 4;
		arcs.forEach(arc => arc.forEach(aid => {
			const p = metas[aid < 0 ? ~aid : aid];
			(p.owner = p.owner || []).push(aid < 0 ? ~q.id : q.id)
			p.weight = Math.max(p.weight || 0, q.weight);
		}));
	}
}
////===============================================================================================================
function metaArc(buffs) {
	return buffs.map(calcMeta);
	function calcMeta(buff, aid) {
		const n = buff.length;
		const closed = buff[0] == buff[n - 1]
		let L = 0, A = 0;
		let [x0, y0] = gint.unpackToInt(buff[0]), [lng0, lat0] = gint.intToVal([x0, y0]);
		const bbox = new Uint32Array([x0, y0, x0, y0]);
		for (let i = 1; i < n; i++) {
			const [x1, y1] = gint.unpackToInt(buff[i]), [lng1, lat1] = gint.intToVal([x1, y1]);
			const cosLat = Math.cos(((lat0 + lat1) / 2) * RAD);
			const dx = (lng1 - lng0) * RAD * cosLat, dy = (lat1 - lat0) * RAD;
			L += Math.sqrt(dx * dx + dy * dy);
			A += (lng1 - lng0) * RAD * (2 + Math.sin(lat0 * RAD) + Math.sin(lat1 * RAD));
			updateBbox(bbox, [x1, y1, x1, y1]);
			x0 = x1; y0 = y1; lng0 = lng1; lat0 = lat1;
		}
		return { aid, length: L * Radius, area: A * Radius * Radius / 2, closed, bbox };
	}
}
function buildArcs(buffs, metas) { // 複数Arcの一括パルス化
	const count = buffs.length, mlen = 8;
	let total = 0, offset = 0;
	for (let i = 0; i < count; i++) total += buffs[i].length;
	const buffer = new BigUint64Array(total);
	const meta = new Uint32Array(count * mlen);
	const bbox = initBbox();
	for (let i = 0; i < count; i++) {
		const q = metas[i], arc = buffs[q.aid];
		gint.L1toL2(arc);
		buffer.set(arc, offset);
		meta.set([offset, arc.length, q.weight, 0, ...bbox], i * mlen); offset += arc.length;
		updateBbox(bbox, q.bbox);
	}
	return { count, buffer, meta, mlen, bbox };
}	