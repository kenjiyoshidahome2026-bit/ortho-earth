export function bindSharedUniforms(gl, u, data, arcTex, metaTex, arcW, metaW, width, height) {
	gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, arcTex);
	gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, metaTex);
	gl.uniform1i(u.u_arc_tex,  0);
	gl.uniform1i(u.u_meta_tex, 1);
	gl.uniform1i(u.u_arc_w,    arcW);
	gl.uniform1i(u.u_meta_w,   metaW);
	gl.uniform3f(u.u_rotate,   data.rotate[0], data.rotate[1], data.rotate[2] ?? 0);
	gl.uniform1f(u.u_scale,    data.scale);
	gl.uniform2f(u.u_viewport, width, height);
	const r1 = data.rotate[1] * Math.PI / 180, r2 = (data.rotate[2] ?? 0) * Math.PI / 180;
	const cf = Math.cos(r1), sf = Math.sin(r1), cg = Math.cos(r2), sg = Math.sin(r2);
	gl.uniform4f(u.u_rsincos,  cf, sf, cg, sg);
	// Normalize: autoRotate accumulates rotate[0] unbounded; wrap() may leave it outside [-180,180].
	const lambda = ((data.rotate[0] % 360) + 540) % 360 - 180;
	gl.uniform1ui(u.u_ix_center, (Math.round((-lambda + 180) * 1e7)) >>> 0);
	gl.uniform1ui(u.u_iy_center, (Math.round((-data.rotate[1] +  90) * 1e7)) >>> 0);
	// Jacobian: maps integer (dx,dy) RTC coords → screen pixel offsets.
	// Active at high zoom (scale > 2e5 ≈ z13+) where the sphere is locally flat.
	// Computed at float64 in JS; the shader does two MADs per vertex — no trig,
	// no catastrophic cancellation → zero jitter.
	if (data.scale > 2e5) {
		const k = data.scale * (Math.PI / 180) * 1e-7;
		gl.uniform4f(u.u_jac, cf*cg*k, -cf*sg*k, -sg*k, -cg*k);
	} else {
		gl.uniform4f(u.u_jac, 0, 0, 0, 0);
	}
	// GPU Dynamic LOD 閾値: 1px が覆う地表面積(sq-deg)を encoder getPhysRank と同式で rank 化。
	// 正射の中心 1px = (180/π/scale)°。VW eff-area は経度側 cos(lat) 補正済みなので
	// pxArea = pxDeg² は緯度非依存。rank = 1.5·log2(pxArea)+61.524 = 3·log2(pxDeg)+61.524。
	// この rank 未満の頂点(辺)は VS が discard＝低ズームの描画コストを桁で削減。
	// 高ズームでは閾値が 0 に落ちて全頂点＝正確さ無損失（サブpx頂点のみ間引き）。
	if (u.u_lod_rank) {
		const pxDeg = (180 / Math.PI) / data.scale;
		const rank = Math.max(0, Math.min(63, Math.floor(3 * Math.log2(pxDeg) + 61.524)));
		gl.uniform1f(u.u_lod_rank, rank);
	}
}



export function uploadTex2D(gl, u32, w, h, internalFmt, fmt) {
	const tex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, fmt, gl.UNSIGNED_INT, u32);
	return tex;
}

// Build flat Uint32Array of edge meta from polygon/polyline flat streams.
// One entry per arc edge: [vert_A, vert_B, style_id, feat_id].
// Reversed arcs (arcIdx < 0) swap A/B to preserve correct stencil winding.
//
// polyStream: Int32Array — per comp: [fid][numRings][arcCount][arcIdx...]
//   comps with same fid are consecutive (multi-polygon support)
// lineStream: Int32Array — per feature: [fid][numSets][arcCount][arcIdx...]
//
// Returns polyEdgeByFid: Map<fid, [edgeStart, edgeCount]> for O(1) highlight range lookup.
// When arcBuffer is provided and minWeight > 0, L2 vertices below minWeight are skipped,
// producing "long-jump edges" that directly connect kept vertices.
// This reduces totalEdges (i.e. the drawArrays count) itself.
// minWeight = 0 (default) keeps all vertices at full density.
export function buildEdgeMeta(arcMeta, polyStream, lineStream, arcBuffer = null, minWeight = 0) {
	if (!arcMeta) return { metaU32: new Uint32Array(0), edgeCount: 0, polyEdgeCount: 0, polyEdgeByFid: new Map() };

	// Read weights via Uint32Array view to avoid BigInt.
	// L1 vertices (TERMINAL_BIT = bit63) always have weight 63; L2 weight is the low 6 bits of lo-word.
	const arcU32 = (arcBuffer?.length && minWeight > 0)
		? new Uint32Array(arcBuffer.buffer, arcBuffer.byteOffset, arcBuffer.byteLength / 4)
		: null;
	const getW = arcU32
		? (idx) => (arcU32[idx * 2 + 1] & 0x80000000) ? 63 : (arcU32[idx * 2] & 0x3F)
		: null;

	// Effective edge count per arc usage (simplified or full density).
	const arcEdges = (aid) => {
		const len = arcMeta[aid * 8 + 1];
		if (!getW) return len - 1;
		const off = arcMeta[aid * 8];
		let kept = 0;
		for (let i = 0; i < len; i++) if (getW(off + i) >= minWeight) kept++;
		return Math.max(0, kept - 1);
	};

	let total = 0;
	const scanStream = s => { if (!s) return; let p = 0;
		while (p < s.length) { p++; const ng = s[p++];
			for (let g = 0; g < ng; g++) { const ac = s[p++];
				for (let a = 0; a < ac; a++) { const ai = s[p++]; total += arcEdges(ai < 0 ? ~ai : ai); }
			}
		}
	};
	scanStream(polyStream); scanStream(lineStream);

	const buf = new Uint32Array(total * 4);
	let j = 0;

	const addArc = (arcIdx, styleId, featId) => { j = emitArcEdges(buf, j, arcIdx, styleId, featId, arcMeta, getW, minWeight); };

	const polyEdgeByFid = new Map();
	if (polyStream) { let p = 0;
		while (p < polyStream.length) {
			const fid = polyStream[p], eStart = j >> 2;
			while (p < polyStream.length && polyStream[p] === fid) {
				p++; const numRings = polyStream[p++];
				for (let r = 0; r < numRings; r++) {
					const ac = polyStream[p++];
					for (let a = 0; a < ac; a++) addArc(polyStream[p++], 0, fid);
				}
			}
			polyEdgeByFid.set(fid, [eStart, (j >> 2) - eStart]);
		}
	}
	const polyEdgeCount = j >> 2;   // ポリゴン辺は先頭に連続配置＝stencil 塗りはこの範囲だけ描く（折れ線辺をファンさせない）
	if (lineStream) { let p = 0;
		while (p < lineStream.length) { const fid = lineStream[p++], ns = lineStream[p++];
			for (let s = 0; s < ns; s++) { const ac = lineStream[p++];
				for (let a = 0; a < ac; a++) addArc(lineStream[p++], 1, fid); }
		}
	}
	return { metaU32: buf, edgeCount: total, polyEdgeCount, polyEdgeByFid };
}

// 1 arc 分の辺を書き出す共通実装（buildEdgeMeta / buildBoundaryEdgeMeta で共用）。返り値=新しい j。
function emitArcEdges(buf, j, arcIdx, styleId, featId, arcMeta, getW, minWeight) {
	const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
	const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1], fid = featId >>> 0;
	if (!getW) {
		// Full density mode.
		for (let i = 0; i < len - 1; i++) {
			buf[j++] = arcIdx >= 0 ? off + i     : off + len - 1 - i;
			buf[j++] = arcIdx >= 0 ? off + i + 1 : off + len - 2 - i;
			buf[j++] = (styleId & 0xFF) | (i << 8); buf[j++] = fid;
		}
	} else {
		// Long-jump mode: connect kept vertices directly, skipping low-weight ones.
		let prev = -1, ei = 0;
		const step = arcIdx >= 0 ? 1 : -1;
		const iStart = arcIdx >= 0 ? 0 : len - 1;
		const iEnd   = arcIdx >= 0 ? len : -1;
		for (let i = iStart; i !== iEnd; i += step) {
			const idx = off + i;
			if (getW(idx) >= minWeight) {
				if (prev !== -1) { buf[j++] = prev; buf[j++] = idx; buf[j++] = (styleId & 0xFF) | (ei++ << 8); buf[j++] = fid; }
				prev = idx;
			}
		}
	}
	return j;
}

// 境界エッジメタ＝「正味参照（forward:+1 / reversed:−1 の符号付き合計）が 0 でない arc」だけの辺集合。
// 隣接筆が共有する arc は必ず逆向きに 2 回参照される＝正味 0 ＝ winding 寄与ゼロなので落として同一。
// - stencil(NOTEQUAL 0 塗り)は全ズームでこれに置換しても数学的に等価（重複筆=同向き2回も正味±2≠0で保持）。
// - 線パスは低ズーム(z<outlineZoom)でこれに切替＝筆内部の線は視認不能(ベタ)なのでアウトラインのみ描く。
// lineStream(折れ線)の arc は面の分割に関与しないため常に全量含める。
export function buildBoundaryEdgeMeta(arcMeta, polyStream, lineStream, arcBuffer = null, minWeight = 0) {
	if (!arcMeta) return { metaU32: new Uint32Array(0), edgeCount: 0, polyEdgeCount: 0 };
	const nArcs = (arcMeta.length / 8) | 0;
	const net   = new Int32Array(nArcs);
	const fidOf = new Int32Array(nArcs).fill(-1);
	if (polyStream) { let p = 0;
		while (p < polyStream.length) { const fid = polyStream[p++], nr = polyStream[p++];
			for (let r = 0; r < nr; r++) { const ac = polyStream[p++];
				for (let a = 0; a < ac; a++) { const ai = polyStream[p++], aid = ai < 0 ? ~ai : ai;
					net[aid] += ai < 0 ? -1 : 1;
					if (fidOf[aid] === -1) fidOf[aid] = fid;
				}
			}
		}
	}

	const arcU32 = (arcBuffer?.length && minWeight > 0)
		? new Uint32Array(arcBuffer.buffer, arcBuffer.byteOffset, arcBuffer.byteLength / 4)
		: null;
	const getW = arcU32
		? (idx) => (arcU32[idx * 2 + 1] & 0x80000000) ? 63 : (arcU32[idx * 2] & 0x3F)
		: null;
	const arcEdges = (aid) => {
		const len = arcMeta[aid * 8 + 1];
		if (!getW) return len - 1;
		const off = arcMeta[aid * 8];
		let kept = 0;
		for (let i = 0; i < len; i++) if (getW(off + i) >= minWeight) kept++;
		return Math.max(0, kept - 1);
	};

	let total = 0;
	for (let aid = 0; aid < nArcs; aid++) if (net[aid] !== 0) total += arcEdges(aid);
	if (lineStream) { let p = 0;
		while (p < lineStream.length) { p++; const ns = lineStream[p++];
			for (let g = 0; g < ns; g++) { const ac = lineStream[p++];
				for (let a = 0; a < ac; a++) { const ai = lineStream[p++]; total += arcEdges(ai < 0 ? ~ai : ai); } }
		}
	}

	const buf = new Uint32Array(total * 4);
	let j = 0;
	// winding の符号を保つため、描画向きは正味符号に従う（向きを反転すると chain が壊れ塗りが崩れる）。
	for (let aid = 0; aid < nArcs; aid++) {
		if (net[aid] !== 0) j = emitArcEdges(buf, j, net[aid] > 0 ? aid : ~aid, 0, fidOf[aid] < 0 ? 0 : fidOf[aid], arcMeta, getW, minWeight);
	}
	const polyEdgeCount = j >> 2;   // ポリゴン境界辺は先頭に連続配置（buildEdgeMeta と同じ規約）
	if (lineStream) { let p = 0;
		while (p < lineStream.length) { const fid = lineStream[p++], ns = lineStream[p++];
			for (let g = 0; g < ns; g++) { const ac = lineStream[p++];
				for (let a = 0; a < ac; a++) j = emitArcEdges(buf, j, lineStream[p++], 1, fid, arcMeta, getW, minWeight); }
		}
	}
	return { metaU32: buf, edgeCount: total, polyEdgeCount };
}

// ── リング向き正規化 ─────────────────────────────────────────────
// 境界メタの「正味参照で相殺」はリング巻き向きの一貫性が前提。実データには逆巻きリングが混入し
// （NOTEQUAL 0 塗りは −1 も塗るため従来は無症状）、netting すると相殺すべきでない arc が消え
// winding 0 の穴 / 負の斑点になる。ロード時に一回、符号付き面積で全リングの向きを検査し、
// polyStream の参照符号を反転して正規化する。基準は外環の多数決（=現に正しく塗れている向き）。
// 幾何から毎回再計算するので冪等。stencil は辺集合の向きだけ見る（順序不問）ため符号反転のみで足る。

// GLSL compact16 の JS 写し（偶数ビット抽出）
function _compact16(m) {
	m &= 0x55555555;
	m = (m | (m >>> 1)) & 0x33333333;
	m = (m | (m >>> 2)) & 0x0F0F0F0F;
	m = (m | (m >>> 4)) & 0x00FF00FF;
	m = (m | (m >>> 8)) & 0x0000FFFF;
	return m;
}

export function normalizeRingOrientation(arcBuffer, arcMeta, polyStream) {
	if (!arcBuffer?.length || !arcMeta || !polyStream?.length) return 0;
	const arcU32 = new Uint32Array(arcBuffer.buffer, arcBuffer.byteOffset, arcBuffer.byteLength / 4);

	// idx → [ix, iy]（shader fetchProject と同一の Morton 展開。L2 は下位6bit=rank をマスク）
	const decode = (idx, out) => {
		const lo = arcU32[idx * 2], hi = arcU32[idx * 2 + 1];
		const loC = (hi & 0x80000000) ? lo : (lo & 0xFFFFFFC0);
		const hiC = hi & 0x7FFFFFFF;
		out[0] = ((_compact16(hiC) << 16) | _compact16(loC)) >>> 0;
		out[1] = ((_compact16(hiC >>> 1) << 16) | _compact16(loC >>> 1)) >>> 0;
	};

	// リングの符号付き面積×2（e7²単位）。座標はリング先頭からの相対（double 53bit に収める）、
	// 経度差は 360e7 周期でラップ（antimeridian 跨ぎ対策）。
	const v = [0, 0];
	const ringArea2 = (refStart, arcCount) => {
		let area2 = 0, x0 = 0, y0 = 0, px = 0, py = 0, first = true;
		for (let a = 0; a < arcCount; a++) {
			const ai = polyStream[refStart + a], aid = ai < 0 ? ~ai : ai;
			const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
			for (let i = 0; i < len; i++) {
				decode(ai < 0 ? off + len - 1 - i : off + i, v);
				if (first) { x0 = v[0]; y0 = v[1]; first = false; px = 0; py = 0; continue; }
				let dx = v[0] - x0;
				if (dx > 1.8e9) dx -= 3.6e9; else if (dx < -1.8e9) dx += 3.6e9;
				const dy = v[1] - y0;
				area2 += px * dy - dx * py;
				px = dx; py = dy;
			}
		}
		return area2;   // 閉路の締め項は先頭が原点(0,0)なので0＝不要
	};

	// 1st pass: 全リングの面積と位置を収集、外環の多数派符号を採る
	const starts = [], counts = [], outers = [], areas = [];
	let p = 0, outerPlus = 0, outerMinus = 0;
	while (p < polyStream.length) {
		p++; const nr = polyStream[p++];
		for (let r = 0; r < nr; r++) {
			const ac = polyStream[p++];
			const a2 = ringArea2(p, ac);
			starts.push(p); counts.push(ac); outers.push(r === 0); areas.push(a2);
			if (r === 0) { if (a2 > 0) outerPlus++; else if (a2 < 0) outerMinus++; }
			p += ac;
		}
	}
	const majority = outerPlus >= outerMinus ? 1 : -1;

	// 2nd pass: 外環=多数派・穴=逆、に合わない参照を符号反転（面積0の退化リングは触らない）
	let flipped = 0;
	for (let k = 0; k < starts.length; k++) {
		const want = outers[k] ? majority : -majority;
		if (areas[k] === 0 || Math.sign(areas[k]) === want) continue;
		const st = starts[k], ac = counts[k];
		for (let a = 0; a < ac; a++) polyStream[st + a] = ~polyStream[st + a];
		flipped++;
	}
	if (flipped > 0) console.info('[gint] ring orientation normalized: %d/%d rings flipped (outer majority %s)',
		flipped, starts.length, majority > 0 ? 'CCW' : 'CW');
	return flipped;
}

// アウトライン⇄ベタ塗りの切替ズームをデータから導出する。
// 基準＝「中央値ポリゴンの bbox 対角が画面上 targetPx(CSS px) を跨ぐズーム」。
// それ未満では線は面から分離して読めない（サブピクセルの破れたレース）ので面＝塗りで表現し、
// それ以上では個々のポリゴンが読める＝アウトライン表現へ切り替える。
// 導出：px = diag_e7 × scale × (π/180) × 1e-7（点シェーダのヤコビアン k と同式）、scale = 40.74·2^z を解く。
// 目安：筆20m級→z≈15 / 市区町村→z≈6 / 都道府県→z≈3。ポリゴン無し・bbox 無しは null（呼び側で既定値へ）。
export function deriveOutlineZoom(polyBboxByFid, targetPx = 4) {
	if (!polyBboxByFid?.size) return null;
	const diags = [];
	for (const bb of polyBboxByFid.values()) {
		const dx = bb[2] - bb[0], dy = bb[3] - bb[1];
		if (dx > 0 || dy > 0) diags.push(Math.hypot(dx, dy));
	}
	if (!diags.length) return null;
	diags.sort((a, b) => a - b);
	const med = diags[diags.length >> 1];   // e7 単位（1e-7 度）。中央値＝antimeridian 跨ぎ等の外れ bbox に頑健
	const z = Math.log2(targetPx / (med * 40.74 * (Math.PI / 180) * 1e-7));
	return Math.min(16, Math.max(2, z));
}

// Per-feature bbox Map computed in the worker from polyStream (for JS polygon identify fallback).
export function buildPolyBboxByFid(polyStream, arcMeta) {
	if (!polyStream || !arcMeta || !polyStream.length) return null;
	const byFid = new Map(); let p = 0;
	while (p < polyStream.length) {
		const fid = polyStream[p++], numRings = polyStream[p++];
		let bb = byFid.get(fid); if (!bb) { bb = [0xFFFFFFFF, 0xFFFFFFFF, 0, 0]; byFid.set(fid, bb); }
		for (let r = 0; r < numRings; r++) { const ac = polyStream[p++];
			for (let a = 0; a < ac; a++) {
				const ai = polyStream[p++], aid = ai < 0 ? ~ai : ai, m = aid * 8;
				if (arcMeta[m+4] < bb[0]) bb[0] = arcMeta[m+4]; if (arcMeta[m+5] < bb[1]) bb[1] = arcMeta[m+5];
				if (arcMeta[m+6] > bb[2]) bb[2] = arcMeta[m+6]; if (arcMeta[m+7] > bb[3]) bb[3] = arcMeta[m+7];
			}
		}
	}
	return byFid;
}

// Derive minZoom/maxZoom from arcMeta bbox and validate them.
// maxZoom is hard-clamped if it exceeds the resolution limit for the given precision.
// minZoom is only suggested (not enforced) when unset and the suggested value > 0.
// Returns { minZoom, maxZoom } — minZoom may remain null.
export function checkZoomRange({ arcMeta, minZoom, maxZoom, precision = 6 }) {
	const precisionMax = Math.floor(0.491 + precision * 3.322);
	const requestedMax = maxZoom ?? precisionMax;
	if (requestedMax > precisionMax) {
		console.warn(`[gint] maxZoom(${requestedMax}) exceeds precision(${precision}) limit → clamped to ${precisionMax}`);
	}
	const effectiveMax = Math.min(requestedMax, precisionMax);

	let effectiveMin = minZoom ?? null;
	if (effectiveMin === null && arcMeta?.length) {
		let bxMin = 0xFFFFFFFF, byMin = 0xFFFFFFFF, bxMax = 0, byMax = 0;
		for (let i = 0, n = (arcMeta.length / 8) | 0; i < n; i++) {
			const b = i * 8;
			if (arcMeta[b+4] < bxMin) bxMin = arcMeta[b+4];
			if (arcMeta[b+5] < byMin) byMin = arcMeta[b+5];
			if (arcMeta[b+6] > bxMax) bxMax = arcMeta[b+6];
			if (arcMeta[b+7] > byMax) byMax = arcMeta[b+7];
		}
		const maxDim = Math.max(bxMax - bxMin, byMax - byMin) * 1e-7;
		if (maxDim > 0) {
			const suggested = Math.max(0, Math.floor(Math.log2(360 / maxDim)) - 1);
			if (suggested > 0) {
				console.warn(`[gint] minZoom not set. Suggested: ${suggested} (data spans ~${maxDim.toFixed(1)}°)`);
			}
		}
	}

	return { minZoom: effectiveMin, maxZoom: effectiveMax };
}
