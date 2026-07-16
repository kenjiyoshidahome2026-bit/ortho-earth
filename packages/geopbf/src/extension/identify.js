import { GeoPBF } from "../pbf-base.js";
import { gint } from "./gint.js";
import initWasm, { GintConverter } from '../../wasm/pkg/gint_wasm.js';

// ── WASM state ────────────────────────────────────────────────────────────────
let _wasmOk = null;        // null=not attempted, true=OK, false=failed
let _converter = null;     // GintConverter instance (null = JS fallback)
let _pendingData = null;   // guard against concurrent buildConverter calls
let _viewBbox = null;      // viewport bbox [xMin,yMin,xMax,yMax] in Morton integer space

async function ensureWasm() {
	if (_wasmOk === null) {
		try { await initWasm(); _wasmOk = true; }
		catch { _wasmOk = false; }
	}
	return _wasmOk;
}

// Reinterpret a BigUint64Array as Uint32Array of (lo32, hi32) pairs (little-endian).
function u64AsU32(buf) {
	return buf?.length
		? new Uint32Array(buf.buffer, buf.byteOffset, buf.length * 2)
		: new Uint32Array(0);
}

// Update the viewport bbox on each drawing() call; used by both WASM and JS fallback.
export function setViewBbox(bbox) {
	_viewBbox = bbox;
	if (_converter && bbox) _converter.set_view_bbox(bbox[0], bbox[1], bbox[2], bbox[3]);
}

// Build a GintConverter from gintData and store it in the module variable.
// polyStream / lineStream are transferred directly from GintBUF v2 — no conversion needed.
export async function buildConverter(gintData) {
	_converter = null;
	_pendingData = gintData;
	if (!await ensureWasm()) return;
	if (_pendingData !== gintData) return;
	const { arcBuffer, arcMeta, polyStream, lineStream, pointBuffer, point, polyCompBbox } = gintData;
	_converter = new GintConverter(
		u64AsU32(arcBuffer),
		arcMeta      ?? new Uint32Array(0),
		u64AsU32(pointBuffer),
		point        ? new Uint32Array(point) : new Uint32Array(0),
		polyStream   ?? new Int32Array(0),
		lineStream   ?? new Int32Array(0),
		polyCompBbox ?? new Uint32Array(0),
	);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function contain(self, lng, lat) {
	if (!self.unPackGint) return null;
	const { arcBuffer, arcMeta, polyStream, polyBboxByFid } = self.unPackGint;
	if (!arcBuffer || !arcMeta || !polyStream) return null;
	const mix = Math.round((lng + 180) * gint.SCALE_E);
	const miy = Math.round((lat + 90) * gint.SCALE_E);
	return findPolygon(arcBuffer, arcMeta, polyStream, mix, miy, polyBboxByFid);
}

export function identify(self, mx, my, proj, options = {}) {
	const geo = proj.invert([mx, my]);
	if (!geo) return null;

	const [mix, miy] = [Math.round((geo[0] + 180) * gint.SCALE_E), Math.round((geo[1] + 90) * gint.SCALE_E)];
	const scale = proj.scale();
	const pointError = ((options.point || 16) / scale) * gint.SCALE_E;
	const polylineError = ((options.polyline || 10) / scale) * gint.SCALE_E;
	if (!self.unPackGint) return null;
	const { arcBuffer, arcMeta, polyStream, lineStream, pointBuffer, point, polyBboxByFid } = self.unPackGint;

	if (_converter) {
		let r;
		if (pointBuffer && point) {
			r = _converter.identify_point(mix, miy, Math.round(pointError));
			if (r !== -1) return r;
		}
		if (arcBuffer && arcMeta && lineStream) {
			r = _converter.identify_polyline(mix, miy, Math.round(polylineError));
			if (r !== -1) return r;
		}
		if (arcBuffer && arcMeta && polyStream) {
			r = _converter.identify_polygon(mix, miy);
			if (r !== -1) return r;
		}
		return null;
	}

	// JS fallback (WASM not initialized or failed).
	if (pointBuffer && point) {
		const owner = findPoint(pointBuffer, point, mix, miy, pointError);
		if (owner !== null) return owner;
	}
	if (arcBuffer && arcMeta && lineStream) {
		const owner = findMortonNear(arcBuffer, arcMeta, lineStream, mix, miy, polylineError);
		if (owner !== null) return owner;
	}
	if (arcBuffer && arcMeta && polyStream) {
		const owner = findPolygon(arcBuffer, arcMeta, polyStream, mix, miy, polyBboxByFid);
		if (owner !== null) return owner;
	}
	return null;
}

// ── JS implementations (WASM fallback) ────────────────────────────────────────

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

function findMortonNear(buffer, meta, lineStream, mix, miy, error) {
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
		const qMin = gint._pureMortonFromInt(q[0], q[2]) & ~gint.WEIGHT_MASK;
		const qMax = gint._pureMortonFromInt(q[1], q[3]) | gint.WEIGHT_MASK;

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

	let p = 0;
	while (p < lineStream.length) {
		const fid = lineStream[p++], numSets = lineStream[p++];
		for (let s = 0; s < numSets; s++) {
			const arcCount = lineStream[p++];
			for (let a = 0; a < arcCount; a++) {
				const arcIdx = lineStream[p++], aid = arcIdx < 0 ? ~arcIdx : arcIdx;
				if (hitArcs.has(aid)) return fid;
			}
		}
	}
	return null;
}

// 重なり・入れ子は「最小の地物」を返す（smallest-wins）。polyStream は topology() が
// 地物weight降順（大→小）で書き出すため、全走査して最後にヒットした fid ＝最小地物。
// 旧・先勝ちは常に外側の大物を返し、入れ子の内側（地種区分の内側ゾーン等）が選べなかった。
export function findPolygon(buffer, meta, polyStream, mix, miy, polyBboxByFid, viewBbox) {
	const vb = viewBbox ?? _viewBbox;
	let best = null;
	let p = 0;
	while (p < polyStream.length) {
		const fid = polyStream[p];

		// Early rejection using per-feature bbox.
		if (polyBboxByFid) {
			const bb = polyBboxByFid.get(fid);
			if (bb) {
				const skip = (vb && (bb[2] < vb[0] || bb[0] > vb[2] || bb[3] < vb[1] || bb[1] > vb[3]))
				          || mix < bb[0] || mix > bb[2] || miy < bb[1] || miy > bb[3];
				if (skip) {
					while (p < polyStream.length && polyStream[p] === fid) {
						p++; const nr = polyStream[p++];
						for (let r = 0; r < nr; r++) { const ac = polyStream[p++]; p += ac; }
					}
					continue;
				}
			}
		}

		let inside = false;
		while (p < polyStream.length && polyStream[p] === fid) {
			p++; // fid
			const numRings = polyStream[p++];
			for (let ri = 0; ri < numRings; ri++) {
				const arcCount = polyStream[p++];
				for (let ai = 0; ai < arcCount; ai++) {
					const arcIdx = polyStream[p++];
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
		}
		if (inside) best = fid;
	}
	return best;
}
