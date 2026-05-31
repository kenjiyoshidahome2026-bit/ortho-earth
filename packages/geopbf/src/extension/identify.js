import { GeoPBF } from "../pbf-base.js";
import { gint } from "./gint.js";
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
function unproject(mx, my) {
	if (mx == null || my == null) return null;
	const S = 1e7, x = mx / S, y = my / S;
	const z = Math.sqrt(x * x + y * y);
	if (z === 0) return [0, 0];
	const c = 2 * Math.atan(z) / z;
	return [x * c, y * c];
}
function view(buffer) {
	if (buffer instanceof DataView) return buffer;
	if (buffer instanceof ArrayBuffer) return new DataView(buffer);
	if (buffer instanceof Uint8Array) return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	if (buffer instanceof Uint16Array) return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	if (buffer instanceof Uint32Array) return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	throw new Error("Unsupported buffer type");
}
////----------------------------------------------------------------- 指定したインデックスのFeatureを返す
export function feature(self, id) {
	const idx = self.each(i => i).indexOf(id);
	if (idx === -1) return null;
	const type = self.getType(idx), properties = self.getProperties(idx), bbox = self.getBbox(idx);
	return { type, properties, bbox };
}
////----------------------------------------------------------------- 全てのFeatureを文字列化して返す
export function info(self, options = {}) {
	const str = [];
	str.push(`NAME: ${self.name()}`);
}