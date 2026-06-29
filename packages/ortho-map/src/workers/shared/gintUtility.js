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
	// Normalize lambda to [-180, 180] before computing the integer center.
	// autoRotate accumulates rotate[0] as n*velocity (unbounded), and zoomToFeature's
	// wrap() can leave it at e.g. 225 (≡ -135). Without normalization,
	// (-225 + 180)*1e7 = -45e7 wraps to a wrong Uint32, making dx huge → all features off-screen.
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
	if (!arcMeta) return { metaU32: new Uint32Array(0), edgeCount: 0, polyEdgeByFid: new Map() };

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

	const addArc = (arcIdx, styleId, featId) => {
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
