import { gint } from "./gint.js";

// 全て純JS実装。wasm側 GintConverter(identify.rs) との連携コード（buildConverter等）は
// 呼び出し元ゼロのまま識別経路が findPolygon(JS) に一本化されたため 2026-07-17 に撤去した。
// 再配線するなら identify.rs の TODO（smallest-wins揃え）を参照。

// ── Public API ────────────────────────────────────────────────────────────────
// 【設計意図】ここは「描画レス識別」＝Gint知性面の入口（pbf.identifyAt / pbf.contain / pbf.identify）。
// レンダラを一切介さず GintBUF のデータ構造だけで「この座標に何があるか」に答える。
// 地図の hover/click（worker の GPU pick + findPolygon）とは独立した公開 API＝突合・ドリル連携・
// 逆引き（座標→町丁字コード等）の土台。アプリ内で未使用でも削除しないこと。

// 描画レス識別の本命: proj 不要・経緯度と許容半径[m]で問い合わせる（点→線→面の順に照合）。
// 許容半径は等方近似（1度≒111.32km）で gint 格子単位へ変換する。面は許容半径不要（内包判定）。
export function identifyAt(self, lng, lat, options = {}) {
	if (!self.unPackGint) return null;
	const { arcBuffer, arcMeta, polyStream, lineStream, pointBuffer, point, polyBboxByFid } = self.unPackGint;
	const mix = Math.round((lng + 180) * gint.SCALE_E);
	const miy = Math.round((lat + 90) * gint.SCALE_E);
	const toUnits = m => (m / 111320) * gint.SCALE_E;
	const pointError = toUnits(options.point ?? 50);        // 既定: 点は半径50m
	const polylineError = toUnits(options.polyline ?? 30);  // 既定: 線は半径30m

	if (pointBuffer && point && pointError > 0) {
		const owner = findPoint(pointBuffer, point, mix, miy, pointError);
		if (owner !== null) return owner;
	}
	if (arcBuffer && arcMeta && lineStream && polylineError > 0) {
		const owner = findMortonNear(arcBuffer, arcMeta, lineStream, mix, miy, polylineError);
		if (owner !== null) return owner;
	}
	if (arcBuffer && arcMeta && polyStream) {
		const owner = findPolygon(arcBuffer, arcMeta, polyStream, mix, miy, polyBboxByFid);
		if (owner !== null) return owner;
	}
	return null;
}

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

// ── JS implementations ────────────────────────────────────────────────────────

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
	const vb = viewBbox ?? null;
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
