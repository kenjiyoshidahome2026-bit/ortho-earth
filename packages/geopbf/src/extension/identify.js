import { GeoPBF } from "../pbf-base.js";
import { gint } from "./gint.js";
import initWasm, { GintConverter } from '../../wasm/pkg/gint_wasm.js';

// ── WASM state ────────────────────────────────────────────────────────────────
let _wasmOk = null;        // null=未試行, true=OK, false=失敗
let _converter = null;     // GintConverter instance（null=JSフォールバック）
let _pendingData = null;   // buildConverter の多重呼び出しを無効化するためのガード
let _viewBbox = null;      // ビューポート bbox [xMin,yMin,xMax,yMax]（Morton 整数空間）

async function ensureWasm() {
    if (_wasmOk === null) {
        try { await initWasm(); _wasmOk = true; }
        catch { _wasmOk = false; }
    }
    return _wasmOk;
}

// BigUint64Array を Uint32Array として見る（lo32, hi32 ペア、リトルエンディアン）
function u64AsU32(buf) {
    return buf?.length
        ? new Uint32Array(buf.buffer, buf.byteOffset, buf.length * 2)
        : new Uint32Array(0);
}

// polygon [[fid, comps], ...] → flat Int32Array [fid, numRings, numArcs, arcIdx, ...]
function buildPolygonStream(polygon) {
    const out = [];
    for (const [fid, comps] of polygon)
        for (const rings of comps) {
            out.push(fid, rings.length);
            for (const ring of rings) { out.push(ring.length); for (const a of ring) out.push(a); }
        }
    return new Int32Array(out);
}

// polyline [[fid, sets], ...] → flat Int32Array [fid, numSets, numArcs, arcIdx, ...]
function buildPolylineStream(polyline) {
    const out = [];
    for (const [fid, sets] of polyline) {
        out.push(fid, sets.length);
        for (const arcs of sets) { out.push(arcs.length); for (const a of arcs) out.push(a); }
    }
    return new Int32Array(out);
}

// drawing() ごとにビューポート bbox を更新する。WASM と JS フォールバック両方で使用。
export function setViewBbox(bbox) {
    _viewBbox = bbox;
    if (_converter && bbox) _converter.set_view_bbox(bbox[0], bbox[1], bbox[2], bbox[3]);
}

// gintData から GintConverter を非同期で構築してモジュール変数に格納する。
// gint.js の set() 後に fire-and-forget で呼ぶ。
export async function buildConverter(gintData) {
    _converter = null;
    _pendingData = gintData;
    if (!await ensureWasm()) return;
    if (_pendingData !== gintData) return;  // データが更新済み → キャンセル
    const { arcBuffer, arcMeta, polygon, polyline, pointBuffer, point, polyCompBbox } = gintData;
    _converter = new GintConverter(
        u64AsU32(arcBuffer),
        arcMeta     ?? new Uint32Array(0),
        u64AsU32(pointBuffer),
        point       ? new Uint32Array(point) : new Uint32Array(0),
        polygon     ? buildPolygonStream(polygon)  : new Int32Array(0),
        polyline    ? buildPolylineStream(polyline) : new Int32Array(0),
        polyCompBbox ?? new Uint32Array(0),
    );
}

// ── Public API ────────────────────────────────────────────────────────────────

export function contain(self, lng, lat) {
	if (!self.unPackGint) return null;
	const { arcBuffer, arcMeta, polygon, polyBbox } = self.unPackGint;
	if (!arcBuffer || !arcMeta || !polygon) return null;
	const mix = Math.round((lng + 180) * gint.SCALE_E);
	const miy = Math.round((lat + 90) * gint.SCALE_E);
	return findPolygon(arcBuffer, arcMeta, polygon, mix, miy, polyBbox);
}

export function identify(self, mx, my, proj, options = {}) {
	const geo = proj.invert([mx, my]);
	if (!geo) return null;

	const [mix, miy] = [Math.round((geo[0] + 180) * gint.SCALE_E), Math.round((geo[1] + 90) * gint.SCALE_E)];
	const scale = proj.scale();
	const pointError = ((options.point || 10) / scale) * gint.SCALE_E;
	const polylineError = ((options.polyline || 5) / scale) * gint.SCALE_E;
	if (!self.unPackGint) return null;
	const { arcBuffer, arcMeta, polygon, polyline, pointBuffer, point, polyBbox } = self.unPackGint;

	if (_converter) {
		let r;
		if (pointBuffer && point) {
			r = _converter.identify_point(mix, miy, Math.round(pointError));
			if (r !== -1) return r;
		}
		if (arcBuffer && arcMeta && polyline) {
			r = _converter.identify_polyline(mix, miy, Math.round(polylineError));
			if (r !== -1) return r;
		}
		if (arcBuffer && arcMeta && polygon) {
			r = _converter.identify_polygon(mix, miy);
			if (r !== -1) return r;
		}
		return null;
	}

	// JS フォールバック（WASM 未初期化 or 失敗時）
	if (pointBuffer && point) {
		const owner = findPoint(pointBuffer, point, mix, miy, pointError);
		if (owner !== null) return owner;
	}
	if (arcBuffer && arcMeta && polyline) {
		const owner = findMortonNear(arcBuffer, arcMeta, polyline, mix, miy, polylineError);
		if (owner !== null) return owner;
	}
	if (arcBuffer && arcMeta && polygon) {
		const owner = findPolygon(arcBuffer, arcMeta, polygon, mix, miy, polyBbox);
		if (owner !== null) return owner;
	}
	return null;
}

// ── JS 実装（WASM フォールバック用）────────────────────────────────────────────

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

function findPolygon(buffer, meta, polygonStructures, mix, miy, polyBbox) {
	const vb = _viewBbox;
	for (let i = 0; i < polygonStructures.length; i++) {
		if (polyBbox) {
			const b = i * 4;
			const bx0 = polyBbox[b], by0 = polyBbox[b+1], bx1 = polyBbox[b+2], by1 = polyBbox[b+3];
			// ビューポート交差チェック（画面外を先に弾く）
			if (vb && (bx1 < vb[0] || bx0 > vb[2] || by1 < vb[1] || by0 > vb[3])) continue;
			// クエリ点チェック
			if (mix < bx0 || mix > bx1 || miy < by0 || miy > by1) continue;
		}
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
