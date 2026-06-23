import { GeoPBF } from "../pbf-base.js";
import { gint } from "./gint.js";

topology.FORMAT_VERSION = 1;

// V8 Map 上限（~16M エントリ）対策：キーを複数バケットに分散する Map ラッパー
class BigMap {
    constructor(bucketCount = 64) {
        this.bucketCount = bucketCount;
        this.buckets = Array.from({ length: bucketCount }, () => new Map());
    }
    _idx(key) {
        // aKey は (min<<96n)|(max<<32n)|len 形式 → bit32 以上に Morton コードが入る
        // key & (n-1) だと len の下位ビットに偏るため >> 32n でシフトして均等分散
        return typeof key === 'bigint'
            ? Number((key >> 32n) & BigInt(this.bucketCount - 1))
            : key & (this.bucketCount - 1);
    }
    has(key) { return this.buckets[this._idx(key)].has(key); }
    get(key) { return this.buckets[this._idx(key)].get(key); }
    set(key, val) { this.buckets[this._idx(key)].set(key, val); return this; }
    clear() { this.buckets.forEach(b => b.clear()); }
}

export function topology(self) {
	const { pbf, e } = self;
	const structures = [[], [], []];
	const elemCount = [0, 0, 0, 0];
	const factor = gint.SCALE_E < e? gint.SCALE_E / e: Math.round(gint.SCALE_E / e);
	const fit = (factor >= 1) ? (val) => val * factor: (val) => Math.round(val * factor);
	const OFFSET_X = 180 * gint.SCALE_E; // gint座標系: ix = (lng+180)*SCALE_E
	const OFFSET_Y =  90 * gint.SCALE_E; // gint座標系: iy = (lat+90)*SCALE_E
	const bbox = [Infinity, Infinity, -Infinity, -Infinity];
	const updateBbox = (x,y) => {
		if (x < bbox[0]) bbox[0] = x; if (x > bbox[2]) bbox[2] = x;
		if (y < bbox[1]) bbox[1] = y; if (y > bbox[3]) bbox[3] = y;
	};
	let propTub = new Map();// let propCount = 0;
	self.forEach((i, map) => { const key = self.props[i].join("|");
		if (!propTub.has(key)) propTub.set(key, i);
		const id = propTub.get(key);
		const process = (pos, type) => {
			pbf.pos = pos;
			let lens = [], coords = [];
			pbf.readMessage((tag) => {
				if (tag === GeoPBF.TAGS.LENGTH) pbf.readPackedVarint(lens);
				else if (tag === GeoPBF.TAGS.COORDS) {
					const end = pbf.readVarint() + pbf.pos;
					let x = 0, y = 0;
					const DENSIFY = gint.SCALE_E; // 1度ごとに中間L1ノードを挿入
					const read = (n) => { elemCount[3]++;
						let x = 0, y = 0;
						let prevGX = null, prevGY = null;
						const stream = gint.XY2L1(n || 4096);
						const grab = () => {
							let dx = pbf.readSVarint(), dy = pbf.readSVarint();
							if (dx || dy) { x += dx, y += dy;
								updateBbox(x, y);
								const gx = fit(x) + OFFSET_X, gy = fit(y) + OFFSET_Y;
								if (prevGX !== null) {
									const dgx = gx - prevGX, dgy = gy - prevGY;
									const steps = Math.ceil(Math.max(Math.abs(dgx), Math.abs(dgy)) / DENSIFY);
									for (let s = 1; s < steps; s++)
										stream.push(Math.round(prevGX + dgx * s / steps), Math.round(prevGY + dgy * s / steps));
								}
								stream.push(gx, gy);
								prevGX = gx; prevGY = gy;
								elemCount[3]++;
							}
						};
						if (n === undefined) { while (pbf.pos < end) grab(); }
						else { while (n-- > 0) grab(); }
						return stream.close();
					};
					const typeGroups = [
						() => read(1), // Point
						() => read(),  // MultiPoint
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
	bbox[0] = Math.round(((bbox[0] / e)+180) * gint.SCALE_E); bbox[1] = Math.round(((bbox[1] / e)+90) * gint.SCALE_E);
	bbox[2] = Math.round(((bbox[2] / e)+180) * gint.SCALE_E); bbox[3] = Math.round(((bbox[3] / e)+90) * gint.SCALE_E);
	////-----------------------------------------------------------------------------------------------
	const polygon = buildPolygons(structures[0]);
	const polyline = buildPolylines(structures[1], polygon? polygon.count: 0, polygon?.buffer.length ?? 0);
	const point = buildPoints(structures[2]);
	const pointCount = point? point.count: 0; if(pointCount) elemCount[2] = pointCount;
	// Build flat binary topology streams (v2: no JSON)
	const polyByFid = new Map(), lineByFid = new Map();
	structures[0].forEach(({ id, arcs }) => { (polyByFid.get(id) ?? (polyByFid.set(id, []), polyByFid.get(id))).push(arcs); });
	structures[1].forEach(({ id, arcs }) => { (lineByFid.get(id) ?? (lineByFid.set(id, []), lineByFid.get(id))).push(arcs); });

	// polygon stream: per comp: [fid][numRings][arcCount][arcIdx...]...
	const polyOut = [];
	for (const [fid, comps] of polyByFid) for (const rings of comps) {
		polyOut.push(fid, rings.length);
		for (const ring of rings) { polyOut.push(ring.length); for (const a of ring) polyOut.push(a); }
	}
	// polyline stream: per feature: [fid][numSets][arcCount][arcIdx...]...
	const lineOut = [];
	for (const [fid, sets] of lineByFid) {
		lineOut.push(fid, sets.length);
		for (const arcs of sets) { lineOut.push(arcs.length); for (const a of arcs) lineOut.push(a); }
	}
	// neighbor stream: [fid][count][neighborId...]...
	const ownerArr = [];
	structures[0].forEach(({ id, arcs }) => arcs.forEach(ring => ring.forEach(arcIdx => {
		const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
		(ownerArr[aid] = ownerArr[aid] || []).push(id);
	})));
	const nbMap = new Map();
	ownerArr.forEach(ids => { if (!ids || ids.length < 2) return;
		ids.forEach(id => { let nb = nbMap.get(id); if (!nb) { nb = new Set(); nbMap.set(id, nb); }
			ids.forEach(t => { if (t !== id) nb.add(t); }); });
	});
	const nbOut = [];
	nbMap.forEach((nb, fid) => { const sorted = [...nb].sort((a, b) => a - b); nbOut.push(fid, sorted.length); for (const n of sorted) nbOut.push(n); });

	const polyStream     = new Int32Array(polyOut);
	const lineStream     = new Int32Array(lineOut);
	const neighborStream = new Int32Array(nbOut);

	const arcLength = ((polygon? polygon.buffer.length : 0) + (polyline? polyline.buffer.length : 0));
	const arcCount = (polygon? polygon.count:0) + (polyline? polyline.count:0), mlen = 8;
	const gintHeader = new Uint32Array(new TextEncoder().encode("Gint").buffer)[0];
	const header = new Uint32Array([
		gintHeader, topology.FORMAT_VERSION, ...elemCount, arcLength, arcCount, ...bbox,
		polyStream.length, lineStream.length, neighborStream.length, 0
	]);
	const headLength = header.length; // 16
	const totalLength = headLength * 4 + arcLength * 8 + arcCount * mlen * 4 + pointCount * (8+4)
		+ polyStream.byteLength + lineStream.byteLength + neighborStream.byteLength;
	const GintBUF = new ArrayBuffer(totalLength), view = new Uint8Array(GintBUF);
	let ptr = 0;
	view.set(new Uint8Array(header.buffer), 0); ptr += headLength * 4;
	polygon  && (view.set(new Uint8Array(polygon.buffer.buffer), ptr),  ptr += polygon.buffer.length * 8);
	polyline && (view.set(new Uint8Array(polyline.buffer.buffer), ptr), ptr += polyline.buffer.length * 8);
	point    && (view.set(new Uint8Array(point.buffer.buffer), ptr),    ptr += point.buffer.length * 8);
	polygon  && (view.set(new Uint8Array(polygon.meta.buffer), ptr),    ptr += polygon.meta.length * 4);
	polyline && (view.set(new Uint8Array(polyline.meta.buffer), ptr),   ptr += polyline.meta.length * 4);
	point    && (view.set(new Uint8Array(point.meta.buffer), ptr),      ptr += point.meta.length * 4);
	polyStream.length     && (view.set(new Uint8Array(polyStream.buffer), ptr),     ptr += polyStream.byteLength);
	lineStream.length     && (view.set(new Uint8Array(lineStream.buffer), ptr),     ptr += lineStream.byteLength);
	neighborStream.length && (view.set(new Uint8Array(neighborStream.buffer), ptr), ptr += neighborStream.byteLength);
	if (totalLength !== ptr) throw new Error(`GintBUF length mismatch: expected ${totalLength}, got ${ptr}`);
	return GintBUF;
}
////===============================================================================================================
export function unPackGintBuffer(GintBUF) {
	try { let ptr = 0;
		const buf = new Uint8Array(GintBUF).slice().buffer, mlen = 8, SCALE = gint.SCALE_E;
		const header = new Uint32Array(buf, 0, 16); ptr += 64;
		if (header[0] !== 1953392967) throw new Error("Invalid Gint buffer");
		const polygonCount = header[2], polylineCount = header[3], pointCount = header[4], nodeCount = header[5];
		const arcLength = header[6], arcCount = header[7], bbox = [...header.slice(8, 12)];
		bbox[0] = (bbox[0] - 180 * SCALE) / SCALE; bbox[1] = (bbox[1] - 90 * SCALE) / SCALE;
		bbox[2] = (bbox[2] - 180 * SCALE) / SCALE; bbox[3] = (bbox[3] - 90 * SCALE) / SCALE;
		const arcBuffer   = arcLength  ? new BigUint64Array(buf, ptr, arcLength)    : null; ptr += arcLength * 8;
		const pointBuffer = pointCount ? new BigUint64Array(buf, ptr, pointCount)   : null; ptr += pointCount * 8;
		const arcMeta     = arcCount   ? new Uint32Array(buf, ptr, arcCount * mlen) : null; ptr += arcCount * mlen * 4;
		const point       = pointCount ? new Uint32Array(buf, ptr, pointCount)      : null; ptr += pointCount * 4;
		const psLen = header[12], lsLen = header[13], nbLen = header[14];
		const polyStream     = psLen ? new Int32Array(buf, ptr, psLen) : null; ptr += psLen * 4;
		const lineStream     = lsLen ? new Int32Array(buf, ptr, lsLen) : null; ptr += lsLen * 4;
		const neighborStream = nbLen ? new Int32Array(buf, ptr, nbLen) : null; ptr += nbLen * 4;
		const polygon   = streamToPolygon(polyStream);
		const polyline  = streamToPolyline(lineStream);
		const neighbors = streamToNeighbors(neighborStream);
		const polyBboxByFid = buildFeatureBboxes(polyStream, arcMeta);
		const lineBboxByFid = buildFeatureBboxes(lineStream, arcMeta);
		const polyCompBbox  = buildCompBboxes(polyStream, arcMeta);
		return { polygonCount, polylineCount, pointCount, nodeCount, arcCount, bbox,
			arcBuffer, arcMeta, polyStream, lineStream, neighborStream,
			polygon, polyline, neighbors,
			pointBuffer, point, polyBboxByFid, lineBboxByFid, polyCompBbox }
	} catch (e) { console.error("Failed to unpack Gint buffer:", e); return null; }
}
////===============================================================================================================
export function repackGintBuffer(d) {
    const mlen = 8, SCALE = gint.SCALE_E;
    const arcLength  = d.arcBuffer ? d.arcBuffer.length : 0;
    const arcCount   = d.arcCount, pointCount = d.pointCount;
    const polyStream     = d.polyStream     ?? new Int32Array(0);
    const lineStream     = d.lineStream     ?? new Int32Array(0);
    const neighborStream = d.neighborStream ?? new Int32Array(0);
    const bboxInt = [
        Math.round((d.bbox[0] + 180) * SCALE), Math.round((d.bbox[1] +  90) * SCALE),
        Math.round((d.bbox[2] + 180) * SCALE), Math.round((d.bbox[3] +  90) * SCALE),
    ];
    const header = new Uint32Array([
        1953392967, topology.FORMAT_VERSION,
        d.polygonCount, d.polylineCount, pointCount, d.nodeCount,
        arcLength, arcCount, ...bboxInt,
        polyStream.length, lineStream.length, neighborStream.length, 0
    ]);
    const totalLength = header.length * 4 + arcLength * 8 + pointCount * 8
        + arcCount * mlen * 4 + pointCount * 4
        + polyStream.byteLength + lineStream.byteLength + neighborStream.byteLength;
    const buf = new ArrayBuffer(totalLength);
    const u8  = new Uint8Array(buf);
    let ptr = 0;
    const write = ta => { u8.set(new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength), ptr); ptr += ta.byteLength; };
    write(header);
    d.arcBuffer   && write(d.arcBuffer);
    d.pointBuffer && write(d.pointBuffer);
    d.arcMeta     && write(d.arcMeta);
    d.point       && write(d.point);
    polyStream.length     && write(polyStream);
    lineStream.length     && write(lineStream);
    neighborStream.length && write(neighborStream);
    return buf;
}
////===============================================================================================================
export function checkCoherence(fB, vB) { // コヒーレンス判定: 0:Outside, 1:Partial, 2:Full-In
	if (fB[2] < vB.minX || fB[0] > vB.maxX || fB[3] < vB.minY || fB[1] > vB.maxY) return 0; // 完全に画面外 (Cull)
	if (fB[0] >= vB.minX && fB[2] <= vB.maxX && fB[1] >= vB.minY && fB[3] <= vB.maxY) return 2; // 完全に画面内 (No Clip)
	return 1; // 一部が重なっている (Partial)
}
////===============================================================================================================
////	POINT
////===============================================================================================================
function buildPoints(topo) { if (!topo.length) return null;
	const a = topo.map(({ id, coords })=>[coords, id]).sort((a, b) => a[0] > b[0] ? 1 : -1), count = a.length;
	const buffer = new BigUint64Array(count), meta = new Uint32Array(count);//, bbox = initBbox();
	a.forEach(([coords, id], i) => { buffer[i] = coords; meta[i] = id;
		const [x, y] = gint.unpackToInt(coords);
	});
	return { count, buffer, meta };
}
////===============================================================================================================
////	POLYLINE
////===============================================================================================================
function buildPolylines(topo, n_poly = 0, vertexOffset = 0) { if (!topo.length) return null;
	purifier(topo);
	const buffs = cutPolyline(topo, 0);  // local 0-based indices for metaPolyline
	const meta = metaArc(buffs);
	metaPolyline(meta, topo);  // works correctly with local (0-based) indices
	// shift to global arc indices after remapping
	if (n_poly > 0) topo.forEach(t => {
		t.arcs = t.arcs.map(arcIdx => arcIdx < 0 ? ~(~arcIdx + n_poly) : arcIdx + n_poly);
	});
	return buildArcs(buffs, meta, vertexOffset);
}
function purifier(topo) { if (!topo || !topo.length) return 0;
	// checkedPairs Set が V8 上限を超えないよう、大規模データはスキップ
	// Census/OSM 等のソースデータは既にトポロジーが整合しており修正不要
	let totalSegs = 0;
	for (const line of topo) totalSegs += line.coords.length - 1;
	if (totalSegs > 80000) return 0;
	const GRID_SHIFT = 16;
	const SNAP_DIST_SQ = 125n; // 11cm
	const GRID_UNIT = 10n;     // 10cm格子
	const checkedPairs = new Set();
	const segments = [];
	const grid = new Map();
	const segByLine = []; // segByLine[lineIdx][i] = seg（文字列キー Map の置き換え）
	const packXY = (x, y) => (BigInt(x) << 32n) | (BigInt(y) & 0xFFFFFFFFn);// 座標パッキング用：(x, y) -> BigInt
	let globalSegIdx = 0;// セグメント登録
	topo.forEach((line, lineIdx) => {
		const coords = line.coords;
		const lineSegs = segByLine[lineIdx] = [];
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
				intersections: null // 交差時のみ生成（空 Map の量産を回避）。Key: PackedBigInt, Value: {x, y, packed}
			};
			segments.push(seg);
			lineSegs[i] = seg;
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
	const segCount = segments.length; // ペアキーの基数（s1.id < s2.id なので一意）
	for (const segIds of grid.values()) {// 高精度交差エンジン
		if (segIds.length < 2 || segIds.length > 1500) continue;
		for (let i = 0; i < segIds.length; i++) {
			const s1 = segments[segIds[i]];
			for (let j = i + 1; j < segIds.length; j++) {
				const s2 = segments[segIds[j]];
				if (s1.lineIdx === s2.lineIdx && Math.abs(s1.sIdx - s2.sIdx) <= 1) continue;
				const pairKey = s1.id * segCount + s2.id;// ペアリングのハッシュ化（Number, BigInt回避）
				if (checkedPairs.has(pairKey)) continue;
				checkedPairs.add(pairKey);
				if (s1.bx2 < s2.bx1 || s1.bx1 > s2.bx2 || s1.by2 < s2.by1 || s1.by1 > s2.by2) continue;
				const pts = solver(s1, s2, SNAP_DIST_SQ, GRID_UNIT);
				if (pts) pts.forEach(pt => {
					const key = packXY(pt.x, pt.y);
					(s1.intersections || (s1.intersections = new Map())).set(key, pt);
					(s2.intersections || (s2.intersections = new Map())).set(key, pt);
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
		const lineSegs = segByLine[lineIdx];
		for (let i = 0; i < original.length - 1; i++) {
			pushClean(original[i]);
			const seg = lineSegs && lineSegs[i];
			if (seg && seg.intersections && seg.intersections.size > 0) {
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
	let hash = new Map(), aHash = new BigMap(64);
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
	metas.sort((p, q) => p.length > q.length ? -1 : 1);
	const aidToNewId = new Array(metas.length);
	metas.forEach((meta, newId) => { aidToNewId[meta.aid] = newId; });
	topo.forEach(t => {
		t.arcs = t.arcs.map(arcIdx => {
			const isRev = arcIdx < 0;
			const aid = isRev ? ~arcIdx : arcIdx;
			const newId = aidToNewId[aid];
			return isRev ? ~newId : newId;
		});
	});
	metas.forEach(q => { q.weight = q.length; delete q.length; });
	function calcMeta(q) {
		const { id, arcs } = q;
		q.length = 0;
		arcs.forEach(arcIdx => {
			const p = metas[arcIdx < 0 ? ~arcIdx : arcIdx];
			q.length += p.length;
			(p.owner = p.owner || []).push(arcIdx < 0 ? ~id : id);
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
	let hash = new Map(), aHash = new BigMap(64);
	let totalVerts = 0;
	for (const q of topo) for (const ring of q.coords) totalVerts += ring.length;
	const CHUNK = 4_000_000; // V8 Map 上限(2^24=16.7M)の25%に余裕を持たせた値
	if (totalVerts <= CHUNK) {
		topo.forEach(setHash);
		topo.forEach(setEdge);
	} else {
		// Morton コードでソートして空間的に近いポリゴンを同じチャンクに集める
		// → チャンク内の隣接ポリゴン間の共有辺を検出できる（チャンク境界をまたぐ数%は独立 arc になる）
		topo.sort((a, b) => { const va = a.coords[0]?.[0] ?? 0n, vb = b.coords[0]?.[0] ?? 0n; return va < vb ? -1 : va > vb ? 1 : 0; });
		for (let i = 0; i < topo.length;) {
			let cv = 0, j = i;
			while (j < topo.length && cv < CHUNK) { for (const ring of topo[j].coords) cv += ring.length; j++; }
			hash = new Map(); // チャンクごとにリセット（aHash は全チャンク共通で弧の重複登録を防ぐ）
			topo.slice(i, j).forEach(setHash);
			topo.slice(i, j).forEach(setEdge);
			i = j;
		}
	}
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
	topo.forEach(calcMeta);
	topo.sort((p, q) => p.weight > q.weight ? -1 : 1);
	const max_weight = topo[0] ? topo[0].weight : 0;
	metas.forEach(p => p.owner.length == 1 && !p.closed && (p.weight = max_weight));
	metas.sort((p, q) => p.weight > q.weight ? -1 : 1);
	const aidToNewId = new Array(metas.length);
	metas.forEach((meta, newId) => { aidToNewId[meta.aid] = newId; });
	topo.forEach(t => {
		t.arcs = t.arcs.map(ring => ring.map(arcIdx => {
			const isRev = arcIdx < 0;
			const aid = isRev ? ~arcIdx : arcIdx;
			const newId = aidToNewId[aid];
			return isRev ? ~newId : newId;
		}));
	});
	function calcMeta(q) {
		const { id, arcs } = q;
		let A = 0, L = 0;
		arcs[0].forEach(aid => {
			const { area, length } = metas[aid < 0 ? ~aid : aid];
			L += length, A += aid < 0 ? -area : area;
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
////	ARC
////===============================================================================================================
function metaArc(buffs) {
	const Radius = 6371008.8, RAD = Math.PI / 180;
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
			if (x1 < bbox[0]) bbox[0] = x1; else if (x1 > bbox[2]) bbox[2] = x1;
			if (y1 < bbox[1]) bbox[1] = y1; else if (y1 > bbox[3]) bbox[3] = y1;
			x0 = x1; y0 = y1; lng0 = lng1; lat0 = lat1;
		}
		return { aid, length: L * Radius, area: A * Radius * Radius / 2, closed, bbox };
	}
}
// Stream → Map<fid, [xMin,yMin,xMax,yMax]>。JS identify フォールバックのフィーチャー早期棄却用。
// polygon stream / polyline stream の両方に同じ 3 段構造 [fid][numGroups][arcCount][arcIdx...] が使える。
function buildFeatureBboxes(stream, arcMeta) {
    if (!stream || !arcMeta || !stream.length) return null;
    const byFid = new Map();
    let p = 0;
    while (p < stream.length) {
        const fid = stream[p++], numGroups = stream[p++];
        let bb = byFid.get(fid);
        if (!bb) { bb = [0xFFFFFFFF, 0xFFFFFFFF, 0, 0]; byFid.set(fid, bb); }
        for (let g = 0; g < numGroups; g++) {
            const arcCount = stream[p++];
            for (let a = 0; a < arcCount; a++) {
                const arcIdx = stream[p++], aid = arcIdx < 0 ? ~arcIdx : arcIdx, m = aid * 8;
                if (arcMeta[m+4] < bb[0]) bb[0] = arcMeta[m+4]; if (arcMeta[m+5] < bb[1]) bb[1] = arcMeta[m+5];
                if (arcMeta[m+6] > bb[2]) bb[2] = arcMeta[m+6]; if (arcMeta[m+7] > bb[3]) bb[3] = arcMeta[m+7];
            }
        }
    }
    return byFid;
}

// polygon_stream のコンポーネント（マルチポリゴン 1 島）と 1:1 の bbox。WASM identify_polygon に渡す。
function buildCompBboxes(polyStream, arcMeta) {
    if (!polyStream || !arcMeta || !polyStream.length) return null;
    const out = [];
    let p = 0;
    while (p < polyStream.length) {
        p++; // fid
        const numRings = polyStream[p++];
        let xMin = 0xFFFFFFFF, yMin = 0xFFFFFFFF, xMax = 0, yMax = 0;
        for (let r = 0; r < numRings; r++) {
            const arcCount = polyStream[p++];
            for (let a = 0; a < arcCount; a++) {
                const arcIdx = polyStream[p++], aid = arcIdx < 0 ? ~arcIdx : arcIdx, m = aid * 8;
                if (arcMeta[m+4] < xMin) xMin = arcMeta[m+4]; if (arcMeta[m+5] < yMin) yMin = arcMeta[m+5];
                if (arcMeta[m+6] > xMax) xMax = arcMeta[m+6]; if (arcMeta[m+7] > yMax) yMax = arcMeta[m+7];
            }
        }
        out.push(xMin, yMin, xMax, yMax);
    }
    return new Uint32Array(out);
}

// ── Stream ↔ JS array 変換（topojson.js / clean.js 向け後方互換） ──────────────────────────
function streamToPolygon(polyStream) {
    if (!polyStream || !polyStream.length) return null;
    const byFid = new Map(); let p = 0;
    while (p < polyStream.length) {
        const fid = polyStream[p++], numRings = polyStream[p++], rings = [];
        for (let r = 0; r < numRings; r++) {
            const arcCount = polyStream[p++], ring = [];
            for (let a = 0; a < arcCount; a++) ring.push(polyStream[p++]);
            rings.push(ring);
        }
        let comps = byFid.get(fid); if (!comps) { comps = []; byFid.set(fid, comps); }
        comps.push(rings);
    }
    return byFid.size ? [...byFid.entries()].map(([fid, comps]) => [fid, comps]) : null;
}
function streamToPolyline(lineStream) {
    if (!lineStream || !lineStream.length) return null;
    const out = []; let p = 0;
    while (p < lineStream.length) {
        const fid = lineStream[p++], numSets = lineStream[p++], sets = [];
        for (let s = 0; s < numSets; s++) {
            const arcCount = lineStream[p++], arcs = [];
            for (let a = 0; a < arcCount; a++) arcs.push(lineStream[p++]);
            sets.push(arcs);
        }
        out.push([fid, sets]);
    }
    return out.length ? out : null;
}
function streamToNeighbors(neighborStream) {
    if (!neighborStream || !neighborStream.length) return null;
    const out = []; let p = 0, hasAny = false;
    while (p < neighborStream.length) {
        const fid = neighborStream[p++], count = neighborStream[p++], nb = [];
        for (let i = 0; i < count; i++) nb.push(neighborStream[p++]);
        out[fid] = nb; hasAny = true;
    }
    return hasAny ? out : null;
}

function buildArcs(buffs, metas, startOffset = 0) {
	const count = buffs.length, mlen = 8;
	let total = 0, offset = 0;
	for (let i = 0; i < count; i++) total += buffs[i].length;
	const buffer = new BigUint64Array(total);
	const meta = new Uint32Array(count * mlen);
	for (let i = 0; i < count; i++) {
		const m = metas[i], arc = buffs[m.aid];
		gint.L1toL2(arc);
		buffer.set(arc, offset);
		meta.set([offset + startOffset, arc.length, m.weight, 0, ...m.bbox], i * mlen);
		offset += arc.length;
	}
	return { count, buffer, meta, mlen };
}
