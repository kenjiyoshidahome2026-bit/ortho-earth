// gint 共有ユーティリティ（v2）。v1(ortho-map) の gintUtility を移植。
// bindSharedUniforms のみ node-dependent（site 2＝投影 uniform）。他は純データ構造＝逐語で携行。

// ── site 2：cam 由来の mvp/eye/origin を uniform へ（v1 の rotate/scale/rsincos/jac を建て替え）──
// mvp/eye/origin は worker が cam から一度だけ生成し data に載せる（site 3）。ここは受けて set するだけ。
// width/height は CSS px（fetchProject/toNDC が同単位で round-trip、dpr は線幅側で別処理）。
export function bindSharedUniforms(gl, u, data, arcTex, metaTex, arcW, metaW, width, height) {
	gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, arcTex);
	gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, metaTex);
	gl.uniform1i(u.u_arc_tex,  0);
	gl.uniform1i(u.u_meta_tex, 1);
	gl.uniform1i(u.u_arc_w,    arcW);
	gl.uniform1i(u.u_meta_w,   metaW);
	gl.uniformMatrix4fv(u.u_mvp, false, data.mvp);
	gl.uniform3f(u.u_eye,    data.eye[0], data.eye[1], data.eye[2]);
	// 経度は正規化（Morton 中心 ix_center と u_origin.x を同値に保つ）。dlonE7 が antimeridian を畳む。
	const lon = ((data.origin[0] % 360) + 540) % 360 - 180;
	gl.uniform2f(u.u_origin,   lon, data.origin[1]);
	gl.uniform2f(u.u_viewport, width, height);
	gl.uniform1ui(u.u_ix_center, (Math.round((lon             + 180) * 1e7)) >>> 0);
	gl.uniform1ui(u.u_iy_center, (Math.round((data.origin[1] +  90) * 1e7)) >>> 0);
}

// ── 以下 node-independent（投影に触れない純データ構造）＝v1 から逐語で携行 ──

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

// polygon/polyline flat stream から edge meta の flat Uint32Array を組む。
// 1 edge = [vert_A, vert_B, style_id, feat_id]。逆順 arc(arcIdx<0) は A/B を入れ替え stencil winding を保つ。
// polyStream: Int32Array — comp毎 [fid][numRings][arcCount][arcIdx...]（同fid連続＝multi-polygon）
// lineStream: Int32Array — feature毎 [fid][numSets][arcCount][arcIdx...]
// 返り値 polyEdgeByFid: Map<fid, [edgeStart, edgeCount]>（O(1) highlight レンジ）。
export function buildEdgeMeta(arcMeta, polyStream, lineStream, arcBuffer = null, minWeight = 0) {
	if (!arcMeta) return { metaU32: new Uint32Array(0), edgeCount: 0, polyEdgeByFid: new Map() };

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
			for (let i = 0; i < len - 1; i++) {
				buf[j++] = arcIdx >= 0 ? off + i     : off + len - 1 - i;
				buf[j++] = arcIdx >= 0 ? off + i + 1 : off + len - 2 - i;
				buf[j++] = (styleId & 0xFF) | (i << 8); buf[j++] = fid;
			}
		} else {
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

// feature毎の bbox Map（Morton整数空間）。JS polygon identify fallback 用。
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

// arcMeta bbox から minZoom/maxZoom を導き検証。maxZoom は precision の分解能上限で hard-clamp。
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
