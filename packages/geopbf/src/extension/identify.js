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

	// 最上位ビット跨ぎの分割判定：座標は最大3.6e9＝32bit幅で、JSビット演算は int32 に潰れる。
	// XORパターンは >>>0 で読み、マスクは 2^b の算術で計算（旧 (1<<31) 直書きは経度34.748°E跨ぎの窓で壊れていた）
	const split = (min, max) => {
		const xor = (min ^ max) >>> 0;
		if (xor < 2 ** 31) return null;   // 最上位ビットが同じ＝分割不要（発火条件は旧実装と同一）
		return Math.floor(max / 2 ** 31) * 2 ** 31;
	};
	const xMid = split(xMin, xMax), yMid = split(yMin, yMax);

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

// 線の描画レス識別＝lineStream の各arcを bbox 早期棄却→**線分距離**で照合（頂点だけでなく辺の途中もヒット）。
// 旧実装（2026-08-20 撤去）は arcBuffer を Morton 整列前提で二分探索していたが、
//   ①arcBuffer は arc 毎の頂点列＝Morton 非整列で二分探索が成立しない
//   ②探索窓が _pureMortonFromInt（bit63なし）なのに端点は L1＝TERMINAL_BIT 付きで窓に入らない
//   ③頂点近傍のみ＝2頂点ラインの中間クリックが原理的に外れる
// ＝呼び出し元ゼロのまま一度も機能していなかった（geoedit の線選択で発覚）。
// 距離は 1e-7 整数単位の平面近似（identifyAt が許容半径をこの単位へ換算して渡す）。遠い線分は
// 座標差が 2^53 を超えて精度が落ちるが、判定は errSq との比較＝近傍でのみ効く値なので実害はない。
function segDistSq(px, py, ax, ay, bx, by) {
	const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
	const c1 = vx * wx + vy * wy;
	if (c1 <= 0) return wx * wx + wy * wy;
	const c2 = vx * vx + vy * vy;
	if (c2 <= c1) { const dx = px - bx, dy = py - by; return dx * dx + dy * dy; }
	const t = c1 / c2, dx = wx - t * vx, dy = wy - t * vy;
	return dx * dx + dy * dy;
}
function findMortonNear(buffer, meta, lineStream, mix, miy, error) {
	const errSq = error * error;
	let p = 0;
	while (p < lineStream.length) {
		const fid = lineStream[p++], numSets = lineStream[p++];
		for (let s = 0; s < numSets; s++) {
			const arcCount = lineStream[p++];
			for (let a = 0; a < arcCount; a++) {
				const arcIdx = lineStream[p++], aid = arcIdx < 0 ? ~arcIdx : arcIdx;
				if (mix < meta[aid * 8 + 4] - error || miy < meta[aid * 8 + 5] - error ||
					mix > meta[aid * 8 + 6] + error || miy > meta[aid * 8 + 7] + error) continue;   // arc bbox 早期棄却
				const off = meta[aid * 8], len = meta[aid * 8 + 1];
				let px = 0, py = 0;
				for (let i = 0; i < len; i++) {
					const [ix, iy] = gint.unpackToInt(buffer[off + i]);
					if (i && segDistSq(mix, miy, px, py, ix, iy) <= errSq) return fid;
					px = ix; py = iy;
				}
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
