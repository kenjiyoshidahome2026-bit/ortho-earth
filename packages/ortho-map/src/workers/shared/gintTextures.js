// Texture management — called from both set() and context-restore. Rebuilds all textures from gintData.

import { s } from './gintState.js';
import { uploadTex2D, buildEdgeMeta, buildBoundaryEdgeMeta, buildPolyBboxByFid } from './gintUtility.js';


export function uploadGintTextures() {
	const { gl, gintData } = s;
	if (!gl || !gintData) return;
	const { arcBuffer: ab, arcMeta: am, polyStream: ps, lineStream: ls, pointBuffer: pb } = gintData;

	// arcTex: RG32UI — 64-bit Morton vertex (lo32, hi32)
	if (s.arcTex) gl.deleteTexture(s.arcTex);
	s.arcTex = null;
	if (ab?.length) {
		const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
		const arcH   = Math.ceil(arcU32.length / 2 / s.TEX_ARC_W);
		const arcPad = new Uint32Array(s.TEX_ARC_W * arcH * 2);
		arcPad.set(arcU32);
		s.arcTex = uploadTex2D(gl, arcPad, s.TEX_ARC_W, arcH, gl.RG32UI, gl.RG_INTEGER);
	}

	// metaTex: RGBA32UI — edge metadata (vert_A, vert_B, style_id, feat_id)
	// When edge count exceeds MAX_SAFE_EDGES, automatically LOD-simplify using Visvalingam-Whyatt rank.
	// Binary-search for the minimum minWeight that brings edge count within the limit.
	if (s.metaTex) gl.deleteTexture(s.metaTex);
	s.metaTex = null;
	// 2M→10M: いわき市(登記所備付地図・約6.9M辺)級でも静的間引きを発火させない＝筆界の正確さ優先。
	// 描画コスト(VS呼び出し数)は増える＝重ければ GPU 動的LOD (ortho-core 方式) の移植で回収する。
	const MAX_SAFE_EDGES = 10_000_000;
	let capMinW = 0;   // 静的キャップ発火時の minWeight（境界メタも同値で構築＝塗りと線の kept 集合を一致させる）
	let metaResult = buildEdgeMeta(am, ps, ls);
	if (metaResult.edgeCount > MAX_SAFE_EDGES && ab?.length) {
		const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
		const getW = (idx) => (arcU32[idx * 2 + 1] & 0x80000000) ? 63 : (arcU32[idx * 2] & 0x3F);
		// Build a cumulative histogram of kept vertex counts per weight level in one pass.
		const hist = new Float64Array(64);
		let nUsages = 0;
		const countStream = (str) => {
			if (!str) return; let p = 0;
			while (p < str.length) { p++; const ng = str[p++];
				for (let g = 0; g < ng; g++) { const ac = str[p++];
					for (let a = 0; a < ac; a++) {
						const aid = (str[p] < 0 ? ~str[p] : str[p]); p++; nUsages++;
						const off = am[aid * 8], len = am[aid * 8 + 1];
						for (let i = 0; i < len; i++) hist[getW(off + i)]++;
					}
				}
			}
		};
		countStream(ps); countStream(ls);
		// Accumulate right-to-left: hist[w] = total vertices with weight >= w.
		for (let w = 62; w >= 0; w--) hist[w] += hist[w + 1];
		// totalEdges(w) = hist[w] - nUsages  (each arc usage contributes kept-1 edges)
		let minW = 63;
		for (let w = 0; w < 64; w++) {
			if (hist[w] - nUsages <= MAX_SAFE_EDGES) { minW = w; break; }
		}
		metaResult = buildEdgeMeta(am, ps, ls, ab, minW);
		capMinW = minW;
		console.info('[gint] LOD simplified: %d→%d edges (minWeight=%d)', metaResult.edgeCount + (hist[0] - nUsages | 0), metaResult.edgeCount, minW);
	}
	const { metaU32, edgeCount, polyEdgeByFid } = metaResult;
	s.totalEdges    = edgeCount;
	s.polyEdgeByFid = polyEdgeByFid;
	console.debug('[gint] edges=%d', edgeCount);
	s.polyBboxByFid = buildPolyBboxByFid(ps, am);
	if (s.totalEdges > 0) {
		const metaH   = Math.ceil(s.totalEdges / s.TEX_META_W);
		const metaPad = new Uint32Array(s.TEX_META_W * metaH * 4);
		metaPad.set(metaU32);
		s.metaTex = uploadTex2D(gl, metaPad, s.TEX_META_W, metaH, gl.RGBA32UI, gl.RGBA_INTEGER);
	}

	// metaTexB: 境界エッジメタ（正味参照≠0 の arc のみ＋折れ線全量）。
	// stencil 塗りは常時こちら（winding 等価で桁違いに軽い）、線パスは低ズームで切替＝アウトライン表示。
	if (s.metaTexB) gl.deleteTexture(s.metaTexB);
	s.metaTexB = null;
	s.totalEdgesB = 0;
	if (s.totalEdges > 0) {
		const bResult = buildBoundaryEdgeMeta(am, ps, ls, ab, capMinW);
		s.totalEdgesB = bResult.edgeCount;
		if (bResult.edgeCount > 0) {
			const bH   = Math.ceil(bResult.edgeCount / s.TEX_META_W);
			const bPad = new Uint32Array(s.TEX_META_W * bH * 4);
			bPad.set(bResult.metaU32);
			s.metaTexB = uploadTex2D(gl, bPad, s.TEX_META_W, bH, gl.RGBA32UI, gl.RGBA_INTEGER);
		}
		console.debug('[gint] boundary edges=%d (%.1f%%)', s.totalEdgesB, s.totalEdges ? 100 * s.totalEdgesB / s.totalEdges : 0);
	}

	// ptTex: RG32UI — point coordinates (same format as arcTex)
	// ptMetaTex: R32UI — feature ID per point (point[pt_id])
	if (s.ptTex)     { gl.deleteTexture(s.ptTex);     s.ptTex     = null; }
	if (s.ptMetaTex) { gl.deleteTexture(s.ptMetaTex); s.ptMetaTex = null; }
	if (pb?.length) {
		const ptU32    = new Uint32Array(pb.buffer, pb.byteOffset, pb.byteLength / 4);
		s.totalPoints  = ptU32.length / 2;
		const ptH      = Math.ceil(s.totalPoints / s.TEX_ARC_W);
		const ptPad    = new Uint32Array(s.TEX_ARC_W * ptH * 2);
		ptPad.set(ptU32);
		s.ptTex = uploadTex2D(gl, ptPad, s.TEX_ARC_W, ptH, gl.RG32UI, gl.RG_INTEGER);
		const ptMetaH   = Math.ceil(s.totalPoints / s.TEX_ARC_W);
		const ptMetaPad = new Uint32Array(s.TEX_ARC_W * ptMetaH);
		ptMetaPad.set(gintData.point.subarray(0, s.totalPoints));
		s.ptMetaTex = uploadTex2D(gl, ptMetaPad, s.TEX_ARC_W, ptMetaH, gl.R32UI, gl.RED_INTEGER);
	} else {
		s.totalPoints = 0;
	}
}

export function deleteTextures() {
	const { gl } = s;
	if (!gl) return;
	if (s.arcTex)    gl.deleteTexture(s.arcTex);
	if (s.metaTex)   gl.deleteTexture(s.metaTex);
	if (s.metaTexB)  gl.deleteTexture(s.metaTexB);
	if (s.ptTex)     gl.deleteTexture(s.ptTex);
	if (s.ptMetaTex) gl.deleteTexture(s.ptMetaTex);
	s.arcTex = s.metaTex = s.metaTexB = s.ptTex = s.ptMetaTex = null;
}
