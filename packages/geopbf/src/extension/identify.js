import { GeoPBF } from "../pbf-base.js";
import { gint } from "./gint.js";

export function identify(self, mx, my, proj, options = {}) {
	const geo = proj.invert([mx, my]);
	if (!geo) return null;

	const [mix, miy] = [Math.round((geo[0] + 180) * gint.SCALE_E), Math.round((geo[1] + 90) * gint.SCALE_E)];
	const scale = proj.scale();
	const pointError = ((options.point || 10) / scale) * gint.SCALE_E;
	const polylineError = ((options.polyline || 5) / scale) * gint.SCALE_E;
	if (!self.unPackGint) return null;
	const { arcBuffer, arcMeta, polygon, polyline, pointBuffer, point } = self.unPackGint;

	if (pointBuffer && point) {
		const owner = findPoint(pointBuffer, point, mix, miy, pointError);
		if (owner !== null) return owner;
	}
	if (arcBuffer && arcMeta && polyline) {
		const owner = findMortonNear(arcBuffer, arcMeta, polyline, mix, miy, polylineError);
		if (owner !== null) return owner;
	}
	if (arcBuffer && arcMeta && polygon) {
		const owner = findPolygon(arcBuffer, arcMeta, polygon, mix, miy);
		if (owner !== null) return owner;
	}
	return null;
}

function findPoint(buffer, pointMeta, mix, miy, error) {
	const errSq = error * error;
	const xMin = Math.max(0, mix - error), xMax = mix + error;
	const yMin = Math.max(0, miy - error), yMax = miy + error;

	const xMid = ((xMin ^ xMax) & (1 << 31)) ? (xMax & ~((1 << (31 - Math.clz32(xMin ^ xMax))) - 1)) : null;
	const yMid = ((yMin ^ yMax) & (1 << 31)) ? (yMax & ~((1 << (31 - Math.clz32(yMin ^ yMax))) - 1)) : null;

	const subQuads = [
		[xMin, xMid !== null ? xMid - 1 : xMax, yMin, yMid !== null ? yMid - 1 : yMax],
		xMid !== null ? [xMid, xMax, yMin, yMid !== null ? yMid - 1 : yMax] : null,
		yMid !== null ? [xMin, xMid !== null ? xMid - 1 : xMax, yMid, yMax] : null,
		(xMid !== null && yMid !== null) ? [xMid, xMax, yMid, yMax] : null
	];

	for (const q of subQuads) {
		if (!q) continue;
		const qMin = gint.packFromInt(q[0], q[2]);
		const qMax = gint.packFromInt(q[1], q[3]);

		let low = 0, high = buffer.length - 1, startIdx = -1;
		while (low <= high) {
			let mid = (low + high) >>> 1;
			if (buffer[mid] >= qMin) {
				startIdx = mid;
				high = mid - 1;
			} else {
				low = mid + 1;
			}
		}

		if (startIdx === -1) continue;

		for (let i = startIdx; i < buffer.length; i++) {
			const m = buffer[i];
			if (m > qMax) break;

			const [ix, iy] = gint.unpackToInt(m);
			if (ix >= xMin && ix <= xMax && iy >= yMin && iy <= yMax) {
				const dx = ix - mix, dy = iy - miy;
				if (dx * dx + dy * dy <= errSq) return pointMeta[i];
			}
		}
	}
	return null;
}

function findMortonNear(buffer, meta, polylineStructures, mix, miy, error) {
	const errSq = error * error;
	const hitArcs = new Set();

	const xMin = Math.max(0, mix - error), xMax = mix + error;
	const yMin = Math.max(0, miy - error), yMax = miy + error;

	const xMid = ((xMin ^ xMax) & (1 << 31)) ? (xMax & ~((1 << (31 - Math.clz32(xMin ^ xMax))) - 1)) : null;
	const yMid = ((yMin ^ yMax) & (1 << 31)) ? (yMax & ~((1 << (31 - Math.clz32(yMin ^ yMax))) - 1)) : null;

	const subQuads = [
		[xMin, xMid !== null ? xMid - 1 : xMax, yMin, yMid !== null ? yMid - 1 : yMax],
		xMid !== null ? [xMid, xMax, yMin, yMid !== null ? yMid - 1 : yMax] : null,
		yMid !== null ? [xMin, xMid !== null ? xMid - 1 : xMax, yMid, yMax] : null,
		(xMid !== null && yMid !== null) ? [xMid, xMax, yMid, yMax] : null
	];

	for (const q of subQuads) {
		if (!q) continue;
		const qMin = gint.packFromInt(q[0], q[2]) & ~gint.WEIGHT_MASK;
		const qMax = gint.packFromInt(q[1], q[3]) | gint.WEIGHT_MASK;

		let low = 0, high = buffer.length - 1, startIdx = -1;
		while (low <= high) {
			let mid = (low + high) >>> 1;
			if ((buffer[mid] & ~gint.WEIGHT_MASK) >= qMin) {
				startIdx = mid;
				high = mid - 1;
			} else {
				low = mid + 1;
			}
		}

		if (startIdx === -1) continue;

		for (let i = startIdx; i < buffer.length; i++) {
			const m = buffer[i] & ~gint.WEIGHT_MASK;
			if (m > qMax) break;

			const [ix, iy] = gint.unpackToInt(buffer[i]);
			if (ix >= xMin && ix <= xMax && iy >= yMin && iy <= yMax) {
				const dx = ix - mix, dy = iy - miy;
				if (dx * dx + dy * dy <= errSq) {
					let lowA = 0, highA = (meta.length / 8) - 1, aid = -1;
					while (lowA <= highA) {
						let midA = (lowA + highA) >>> 1;
						const off = meta[midA * 8], len = meta[midA * 8 + 1];
						if (i >= off && i < off + len) { aid = midA; break; }
						if (off > i) highA = midA - 1;
						else lowA = midA + 1;
					}
					if (aid !== -1) hitArcs.add(aid);
				}
			}
		}
	}

	if (hitArcs.size === 0) return null;

	for (let i = 0; i < polylineStructures.length; i++) {
		const [id, lines] = polylineStructures[i];
		for (const line of lines) {
			for (const arcIdx of line) {
				const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
				if (hitArcs.has(aid)) return id;
			}
		}
	}
	return null;
}

function findPolygon(buffer, meta, polygonStructures, mix, miy) {
	for (let i = 0; i < polygonStructures.length; i++) {
		const [id, polygons] = polygonStructures[i];
		for (const rings of polygons) {
			let inside = false;
			for (const ring of rings) {
				for (const arcIdx of ring) {
					const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
					const mIdx = aid * 8;
					if (mix > meta[mIdx + 6] || miy < meta[mIdx + 5] || miy > meta[mIdx + 7]) continue;

					const off = meta[mIdx], len = meta[mIdx + 1];
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
	}
	return null;
}