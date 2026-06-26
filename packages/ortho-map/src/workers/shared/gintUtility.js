// ── GL utility ────────────────────────────────────────────────────────────────

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
	gl.uniform4f(u.u_rsincos,  Math.cos(r1), Math.sin(r1), Math.cos(r2), Math.sin(r2));
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

// ── Geometry ──────────────────────────────────────────────────────────────────

// Build flat Uint32Array of edge meta from polygon/polyline flat streams.
// One entry per arc edge: [vert_A, vert_B, style_id, feat_id].
// Reversed arcs (arcIdx < 0) swap A/B to preserve correct stencil winding.
//
// polyStream: Int32Array — per comp: [fid][numRings][arcCount][arcIdx...]
//   comps with same fid are consecutive (multi-polygon support)
// lineStream: Int32Array — per feature: [fid][numSets][arcCount][arcIdx...]
//
// Returns polyEdgeByFid: Map<fid, [edgeStart, edgeCount]> for O(1) highlight range lookup.
export function buildEdgeMeta(arcMeta, polyStream, lineStream) {
	if (!arcMeta) return { metaU32: new Uint32Array(0), edgeCount: 0, polyEdgeByFid: new Map() };
	let total = 0;
	const scanStream = s => { if (!s) return; let p = 0;
		while (p < s.length) { p++; const ng = s[p++];
			for (let g = 0; g < ng; g++) { const ac = s[p++];
				for (let a = 0; a < ac; a++) { const ai = s[p++]; total += arcMeta[(ai < 0 ? ~ai : ai) * 8 + 1] - 1; }
			}
		}
	};
	scanStream(polyStream); scanStream(lineStream);

	const buf = new Uint32Array(total * 4);
	let j = 0;
	const addArc = (arcIdx, styleId, featId) => {
		const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
		const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1], fid = featId >>> 0;
		for (let i = 0; i < len - 1; i++) {
			buf[j++] = arcIdx >= 0 ? off + i     : off + len - 1 - i;
			buf[j++] = arcIdx >= 0 ? off + i + 1 : off + len - 2 - i;
			buf[j++] = (styleId & 0xFF) | (i << 8); buf[j++] = fid;
		}
	};

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
	if (lineStream) { let p = 0;
		while (p < lineStream.length) { const fid = lineStream[p++], ns = lineStream[p++];
			for (let s = 0; s < ns; s++) { const ac = lineStream[p++];
				for (let a = 0; a < ac; a++) addArc(lineStream[p++], 1, fid); }
		}
	}
	return { metaU32: buf, edgeCount: total, polyEdgeByFid };
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

// ── Zoom range check ──────────────────────────────────────────────────────────
// arcMeta の bbox から全体の地理的広がりを算出し、minZoom/maxZoom の妥当性を検査。
// maxZoom は precision の解像度限界を超えていれば強制クランプ（warning あり）。
// minZoom は未設定かつ推奨値 > 0 なら suggestion を出すのみ（強制しない）。
// 戻り値: { minZoom, maxZoom }（minZoom は null のまま返す場合あり）
export function checkZoomRange({ arcMeta, minZoom, maxZoom, precision = 6 }) {
	// maxZoom: precision から上限を強制
	const precisionMax = Math.floor(0.491 + precision * 3.322);
	const requestedMax = maxZoom ?? precisionMax;
	if (requestedMax > precisionMax) {
		console.warn(`[gint] maxZoom(${requestedMax}) exceeds precision(${precision}) limit → clamped to ${precisionMax}`);
	}
	const effectiveMax = Math.min(requestedMax, precisionMax);

	// minZoom: bbox から推奨値を算出して suggestion のみ
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
