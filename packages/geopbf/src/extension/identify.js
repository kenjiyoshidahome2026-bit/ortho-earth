import { GeoPBF } from "../pbf-base.js";
import { gint } from "./gint.js";

export function identify(self, mx, my, proj, options = {}) {
	const geo = proj.invert([mx, my]);
	if (!geo) return null;

	const [mix, miy] = [Math.round((geo[0] + 180) * gint.SCALE_E), Math.round((geo[1] + 90) * gint.SCALE_E)];
	const scale = proj.scale();
	const pointError = ((options.point || 10) / scale) * gint.SCALE_E;
	const polylineError = ((options.polyline || 5) / scale) * gint.SCALE_E;
	const arcThreshold = (options.radius || 3) / scale * 0.5;

	if (!self.unPackGint) return null;
	const { arcBuffer, arcMeta, polygon, polyline, pointBuffer, point } = self.unPackGint;

	if (pointBuffer && point) {
		const owner = findPoint(pointBuffer, point, mix, miy, pointError);
		if (owner !== null) return owner;
	}
	if (arcBuffer && arcMeta && polyline) {
		const owner = findMortonNear(arcBuffer, arcMeta, polyline, mix, miy, polylineError, arcThreshold);
		if (owner !== null) return owner;
	}
	if (arcBuffer && arcMeta && polygon) {
		const owner = findPolygon(arcBuffer, arcMeta, polygon, mix, miy);
		if (owner !== null) return owner;
	}
	return null;
}

function findPoint(buffer, meta, mix, miy, error) {
	const count = meta.length;
	const mMin = gint.packFromInt(mix - error, miy - error);
	const mMax = gint.packFromInt(mix + error, miy + error);
	const errSq = error * error;
	let low = 0, high = count - 1, start = 0;
	while (low <= high) {
		let mid = (low + high) >>> 1;
		if (buffer[mid] < mMin) { low = mid + 1; start = low; }
		else high = mid - 1;
	}
	for (let i = start; i < count; i++) {
		const m = buffer[i];
		if (m > mMax) break;
		const [ix, iy] = gint.unpackToInt(m);
		const dx = ix - mix, dy = iy - miy;
		if (dx * dx + dy * dy <= errSq) return meta[i];
	}
	return null;
}

function findMortonNear(buffer, meta, polylineStructures, mix, miy, error, threshold) {
	const mMin = gint.packFromInt(Math.max(0, mix - error), Math.max(0, miy - error)) & ~gint.WEIGHT_MASK;
	const mMax = gint.packFromInt(mix + error, miy + error) | gint.WEIGHT_MASK;
	const errSq = error * error;

	let low = 0, high = buffer.length - 1, startIdx = 0;
	while (low <= high) {
		let mid = (low + high) >>> 1;
		if ((buffer[mid] & ~gint.WEIGHT_MASK) < mMin) { low = mid + 1; startIdx = low; }
		else high = mid - 1;
	}

	const hitArcs = new Set();
	for (let i = startIdx; i < buffer.length; i++) {
		const m = buffer[i] & ~gint.WEIGHT_MASK;
		if (m > mMax) break;

		const [ix, iy] = gint.unpackToInt(buffer[i]);
		const dx = ix - mix, dy = iy - miy;
		if (dx * dx + dy * dy <= errSq) {
			let lowA = 0, highA = (meta.length / 8) - 1, aid = 0;
			while (lowA <= highA) {
				let midA = (lowA + highA) >>> 1;
				const off = meta[midA * 8], len = meta[midA * 8 + 1];
				if (i >= off && i < off + len) { aid = midA; break; }
				if (off > i) highA = midA - 1;
				else lowA = midA + 1;
			}
			hitArcs.add(aid);
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
		const [id, rings] = polygonStructures[i];
		let inside = false;
		for (const ring of rings) {
			for (const arcIdx of ring) {
				const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
				const mIdx = aid * 8;
				if (mix < meta[mIdx + 4] || mix > meta[mIdx + 6] || miy < meta[mIdx + 5] || miy > meta[mIdx + 7]) continue;

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
	return null;
}

export function feature(self, id) {
	const idx = self.each(i => i).indexOf(id);
	if (idx === -1) return null;
	return { type: self.getType(idx), properties: self.getProperties(idx), bbox: self.getBbox(idx) };
}

export function info(self) {
	return `NAME: ${self.name()}`;
}