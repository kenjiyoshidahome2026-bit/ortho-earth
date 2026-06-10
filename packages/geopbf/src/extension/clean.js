import { gint } from "./gint.js";

export function cleanTopology(self, options = {}) {
	const gintData = self.unPackGint;
	if (!gintData) return self;

	const { arcBuffer, arcMeta, polygon, polyline } = gintData;
	const mlen = 8;
	const SNAP_DIST_SQ = BigInt(options.snapDistSq || 125);
	const GRID_UNIT = BigInt(options.gridUnit || 10);

	const segments = [];
	const intersections = new Map();

	for (let i = 0; i < gintData.arcCount; i++) {
		const mIdx = i * mlen;
		const offset = arcMeta[mIdx];
		const len = arcMeta[mIdx + 1];

		for (let j = 0; j < len - 1; j++) {
			const p1 = gint.unpackToInt(arcBuffer[offset + j]);
			const p2 = gint.unpackToInt(arcBuffer[offset + j + 1]);
			segments.push({
				arcId: i,
				segIdx: j,
				x1: BigInt(p1[0]), y1: BigInt(p1[1]),
				x2: BigInt(p2[0]), y2: BigInt(p2[1]),
				bx1: Math.min(p1[0], p2[0]), bx2: Math.max(p1[0], p2[0]),
				by1: Math.min(p1[1], p2[1]), by2: Math.max(p1[1], p2[1]),
				p1Raw: arcBuffer[offset + j], p2Raw: arcBuffer[offset + j + 1]
			});
		}
	}

	for (let i = 0; i < segments.length; i++) {
		const s1 = segments[i];
		for (let j = i + 1; j < segments.length; j++) {
			const s2 = segments[j];
			if (s1.arcId === s2.arcId && Math.abs(s1.segIdx - s2.segIdx) <= 1) continue;
			if (s1.bx2 < s2.bx1 || s1.bx1 > s2.bx2 || s1.by2 < s2.by1 || s1.by1 > s2.by2) continue;

			const dx1 = s1.x2 - s1.x1, dy1 = s1.y2 - s1.y1;
			const dx2 = s2.x2 - s2.x1, dy2 = s2.y2 - s2.y1;
			const det = dx1 * dy2 - dy1 * dx2;

			let cx, cy, packed;
			const eps = [
				{ x: s1.x1, y: s1.y1, p: s1.p1Raw }, { x: s1.x2, y: s1.y2, p: s1.p2Raw },
				{ x: s2.x1, y: s2.y1, p: s2.p1Raw }, { x: s2.x2, y: s2.y2, p: s2.p2Raw }
			];

			const resolvePt = (ix, iy) => {
				for (const ep of eps) {
					if ((ix - ep.x) ** 2n + (iy - ep.y) ** 2n <= SNAP_DIST_SQ) return ep;
				}
				const sx = Number((BigInt(ix) + GRID_UNIT / 2n) / GRID_UNIT * GRID_UNIT);
				const sy = Number((BigInt(iy) + GRID_UNIT / 2n) / GRID_UNIT * GRID_UNIT);
				return { x: BigInt(sx), y: BigInt(sy), p: gint.packFromInt(sx, sy) };
			};

			if (det !== 0n) {
				const nT = (s2.x1 - s1.x1) * dy2 - (s2.y1 - s1.y1) * dx2;
				const nU = (s2.x1 - s1.x1) * dy1 - (s2.y1 - s1.y1) * dx1;
				const isIn = (n, d) => d > 0n ? (n >= 0n && n <= d) : (n <= 0n && n >= d);
				if (isIn(nT, det) && isIn(nU, det)) {
					const pt = resolvePt(s1.x1 + (nT * dx1) / det, s1.y1 + (nT * dy1) / det);
					cx = pt.x; cy = pt.y; packed = pt.p;
				}
			}

			if (packed !== undefined) {
				[s1, s2].forEach(s => {
					intersections.set(`${s.arcId}-${s.segIdx}`, packed);
				});
			}
		}
	}

	const nextMeta = [];
	const nextBuffer = [];
	let currentOffset = 0;
	const arcRemap = new Map();

	for (let i = 0; i < gintData.arcCount; i++) {
		const mIdx = i * mlen;
		const offset = arcMeta[mIdx];
		const len = arcMeta[mIdx + 1];
		const weight = arcMeta[mIdx + 2];

		let currentArcPoints = [arcBuffer[offset]];
		const splittedArcs = [];

		for (let j = 0; j < len - 1; j++) {
			const key = `${i}-${j}`;
			if (intersections.has(key)) {
				const crossPt = intersections.get(key);
				if (currentArcPoints[currentArcPoints.length - 1] !== crossPt) {
					currentArcPoints.push(crossPt);
				}
				if (currentArcPoints.length >= 2) {
					splittedArcs.push(currentArcPoints);
				}
				currentArcPoints = [crossPt, arcBuffer[offset + j + 1]];
			} else {
				currentArcPoints.push(arcBuffer[offset + j + 1]);
			}
		}
		if (currentArcPoints.length >= 2) {
			splittedArcs.push(currentArcPoints);
		}

		const validSplitted = splittedArcs.filter(arc => {
			if (arc.length < 3 && arc[0] === arc[arc.length - 1]) return false;
			const pStart = gint.unpackToInt(arc[0]);
			const pEnd = gint.unpackToInt(arc[arc.length - 1]);
			if (arc.length === 2 && pStart[0] === pEnd[0] && pStart[1] === pEnd[1]) return false;
			return true;
		});

		const mappedIds = [];
		validSplitted.forEach(arc => {
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

	const rewriteRings = (structures) => {
		return structures.map(([id, rings]) => {
			const nextRings = [];
			for (const ring of rings) {
				const nextRing = [];
				for (const arcIdx of ring) {
					const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
					const mapped = arcRemap.get(aid) || [];
					const targets = arcIdx < 0 ? [...mapped].reverse().map(t => ~t) : mapped;
					nextRing.push(...targets);
				}
				if (nextRing.length > 0) nextRings.push(nextRing);
			}
			return [id, nextRings];
		}).filter(([_, rings]) => rings.length > 0);
	};

	gintData.polygon = rewriteRings(polygon);
	gintData.polyline = rewriteRings(polyline);
	gintData.arcCount = nextMeta.length / mlen;
	gintData.arcMeta = new Uint32Array(nextMeta);
	gintData.arcBuffer = new BigUint64Array(nextBuffer);

	return self;
}