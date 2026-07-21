// テクスチャ管理 — set() と context-restore の両方から呼ばれ、gintData から全テクスチャを再構築。
// v1(ortho-map) の gintTextures を移植。node-free（GintBUF→テクスチャ、投影に触れない）＝逐語で携行。

import { s } from './state.js';
import { uploadTex2D, buildEdgeMeta, buildPolyBboxByFid, deriveOutlineZoom, buildWeightHist } from './utility.js';


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
	// edge 数が MAX_SAFE_EDGES を超えたら Visvalingam-Whyatt rank で自動 LOD 簡約（安全上限のキャップ）。
	// per-zoom の Dynamic LOD は GPU 側（VS の rank discard）で行う＝ここは全密度アップロードのみ。
	if (s.metaTex) gl.deleteTexture(s.metaTex);
	s.metaTex = null;
	// 2M→10M: いわき市(登記所備付地図・約6.9M辺)級でも静的間引きを発火させない＝筆界の正確さ優先
	//（ortho-map と同判断）。描画コストは段階別tier＋可視チャンクカリングが回収する。
	const MAX_SAFE_EDGES = 10_000_000;
	// 空間カリング用：fid グループを bbox Morton 順に並べ替え＋約65536辺のチャンク台帳（bbox付き）。
	s.polyBboxByFid = buildPolyBboxByFid(ps, am);   // 並べ替えキーに使うため先に計算
	const metaOpts = { orderBbox: s.polyBboxByFid, chunkEdges: 65536 };
	let capMinW = 0;
	let weightHist = null;
	let metaResult = buildEdgeMeta(am, ps, ls, null, 0, metaOpts);
	if (metaResult.edgeCount > MAX_SAFE_EDGES && ab?.length) {
		const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
		weightHist = buildWeightHist(am, ps, ls, arcU32);
		const { hist, nUsages } = weightHist;
		let minW = 63;
		for (let w = 0; w < 64; w++) {
			if (hist[w] - nUsages <= MAX_SAFE_EDGES) { minW = w; break; }
		}
		metaResult = buildEdgeMeta(am, ps, ls, ab, minW, metaOpts);
		capMinW = minW;
		console.info('[gint] LOD cap: %d→%d edges (minWeight=%d)', metaResult.edgeCount + (hist[0] - nUsages | 0), metaResult.edgeCount, minW);
	}
	const { metaU32, edgeCount, polyEdgeCount, polyEdgeByFid } = metaResult;
	s.totalEdges    = edgeCount;
	s.polyEdges     = polyEdgeCount;
	s.polyEdgeByFid = polyEdgeByFid;
	s.metaChunks    = metaResult.chunks;
	console.debug('[gint] edges=%d chunks=%d', edgeCount, s.metaChunks?.length ?? 0);
	s.outlineZoom = deriveOutlineZoom(s.polyBboxByFid);   // 低ズームのベタ塗り切替閾値（ポリゴン無し=null=既定へ）
	if (s.totalEdges > 0) {
		const metaH   = Math.ceil(s.totalEdges / s.TEX_META_W);
		const metaPad = new Uint32Array(s.TEX_META_W * metaH * 4);
		metaPad.set(metaU32);
		s.metaTex = uploadTex2D(gl, metaPad, s.TEX_META_W, metaH, gl.RGBA32UI, gl.RGBA_INTEGER);
	}

	// ── 段階別 LOD メタ（ortho-map から移植）──
	// 「全球・全国が視界内＝空間カリングが効かない低〜中ズーム」担当。rank↔zoom はデータ非依存
	//（r ↔ z=(63-r)/3）なので固定 rank 梯子：w38↔z8.3 / w42↔z7 / w46↔z5.7 / w50↔z4.3。
	// kept 集合は動的LOD（u_lod_rank）と同一＝見た目不変の純粋な VS 起動数削減。
	// 高ズーム（rank<38）は可視チャンクカリングが担当。
	if (s.lodTiers?.length) s.lodTiers.forEach(t => gl.deleteTexture(t.tex));
	s.lodTiers = [];
	const TIER_RANKS = [38, 42, 46, 50];
	if (ab?.length && s.totalEdges > 3_000_000) {
		let prevEdges = s.totalEdges;
		for (const w of TIER_RANKS) {
			if (w <= capMinW) continue;
			const r = buildEdgeMeta(am, ps, ls, ab, w);
			if (!r.edgeCount || r.edgeCount >= prevEdges * 0.7) continue;   // weight無しデータ等＝空/効果薄はスキップ
			const tH   = Math.ceil(r.edgeCount / s.TEX_META_W);
			const tPad = new Uint32Array(s.TEX_META_W * tH * 4);
			tPad.set(r.metaU32);
			s.lodTiers.push({ minW: w, edgeCount: r.edgeCount,
				tex: uploadTex2D(gl, tPad, s.TEX_META_W, tH, gl.RGBA32UI, gl.RGBA_INTEGER) });
			prevEdges = r.edgeCount;
		}
		if (s.lodTiers.length) console.debug('[gint] LOD tiers: %s',
			s.lodTiers.map(t => `w${t.minW}=${t.edgeCount}辺`).join(' / '));
	}

	// ptTex: RG32UI — 点座標（arcTex と同形式）。ptMetaTex: R32UI — 点毎の feature ID。
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
	if (s.ptTex)     gl.deleteTexture(s.ptTex);
	if (s.ptMetaTex) gl.deleteTexture(s.ptMetaTex);
	if (s.lodTiers?.length) s.lodTiers.forEach(t => gl.deleteTexture(t.tex));
	s.lodTiers = [];
	s.metaChunks = null;
	s.arcTex = s.metaTex = s.ptTex = s.ptMetaTex = null;
}
