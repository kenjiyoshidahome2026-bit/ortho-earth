// Texture management — called from both set() and context-restore. Rebuilds all textures from gintData.

import { s } from './gintState.js';
import { uploadTex2D, buildEdgeMeta, buildBoundaryEdgeMeta, buildPolyBboxByFid, deriveOutlineZoom, normalizeRingOrientation, buildWeightHist, dynamicLodRankForZoom } from './gintUtility.js';


export function uploadGintTextures() {
	const { gl, gintData } = s;
	if (!gl || !gintData) return;
	const { arcBuffer: ab, arcMeta: am, polyStream: ps, lineStream: ls, pointBuffer: pb } = gintData;

	// 逆巻きリングの参照符号を正規化（境界メタ netting の前提を担保）。データごとに一回。
	if (!gintData._ringsNormalized) {
		normalizeRingOrientation(ab, am, ps);
		gintData._ringsNormalized = true;
	}

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
	// 空間カリング用：メタは fid グループを bbox 中心 Morton 順に並べ（feature内の辺連続は維持）、
	// 約65536辺ごとの feature 境界でチャンク台帳（bbox付き）を作る。描画時は可視チャンクだけ drawArrays。
	s.polyBboxByFid = buildPolyBboxByFid(ps, am);   // 並べ替えキーに使うため先に計算
	const metaOpts = { orderBbox: s.polyBboxByFid, chunkEdges: 65536 };
	let capMinW = 0;   // 静的キャップ発火時の minWeight（境界メタも同値で構築＝塗りと線の kept 集合を一致させる）
	let metaResult = buildEdgeMeta(am, ps, ls, null, 0, metaOpts);
	let weightHist = null;   // 段階別メタ（下）と共用
	if (metaResult.edgeCount > MAX_SAFE_EDGES && ab?.length) {
		const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
		weightHist = buildWeightHist(am, ps, ls, arcU32);
		const { hist, nUsages } = weightHist;
		// totalEdges(w) = hist[w] - nUsages  (each arc usage contributes kept-1 edges)
		let minW = 63;
		for (let w = 0; w < 64; w++) {
			if (hist[w] - nUsages <= MAX_SAFE_EDGES) { minW = w; break; }
		}
		metaResult = buildEdgeMeta(am, ps, ls, ab, minW, metaOpts);
		capMinW = minW;
		console.info('[gint] LOD simplified: %d→%d edges (minWeight=%d)', metaResult.edgeCount + (hist[0] - nUsages | 0), metaResult.edgeCount, minW);
	}
	const { metaU32, edgeCount, polyEdgeCount, polyEdgeByFid } = metaResult;
	s.totalEdges    = edgeCount;
	s.polyEdges     = polyEdgeCount;
	s.polyEdgeByFid = polyEdgeByFid;
	s.metaChunks    = metaResult.chunks;
	console.debug('[gint] edges=%d chunks=%d', edgeCount, s.metaChunks?.length ?? 0);
	// アウトライン⇄ベタ塗りの切替ズームをデータの粒度から導出（筆→z≈15 / 市区町村→z≈6）。null=既定値へ
	// ライン専用データはポリゴン bbox が無い＝ライン feature bbox から導出
	// （lineStream は polyStream と同一の3層構造 [fid][ng][ac][arcIdx…] なので buildPolyBboxByFid がそのまま使える）
	s.outlineZoom = deriveOutlineZoom(s.polyBboxByFid) ?? deriveOutlineZoom(buildPolyBboxByFid(ls, am));
	if (s.outlineZoom !== null) console.debug('[gint] outlineZoom=%s (median feature ≈4px)', s.outlineZoom.toFixed(1));
	if (s.totalEdges > 0) {
		const metaH   = Math.ceil(s.totalEdges / s.TEX_META_W);
		const metaPad = new Uint32Array(s.TEX_META_W * metaH * 4);
		metaPad.set(metaU32);
		s.metaTex = uploadTex2D(gl, metaPad, s.TEX_META_W, metaH, gl.RGBA32UI, gl.RGBA_INTEGER);
	}

	// metaTexB: 境界エッジメタ（正味参照≠0 の arc のみ＋折れ線全量）。
	// stencil 塗りは常時こちら（winding 等価で桁違いに軽い）、線パスは低ズームで切替＝アウトライン表示。
	// ライン専用（polyStream 無し）は境界メタ＝基準メタの複製にしかならず消費者も居ない
	// （stencil は polyEdgesB=0 で無効・線パスは lnB 判定で不使用）＝構築ごとスキップ（VRAM/構築時間の節約）。
	if (s.metaTexB) gl.deleteTexture(s.metaTexB);
	s.metaTexB = null;
	s.totalEdgesB = 0;
	s.polyEdgesB  = 0;
	if (s.totalEdges > 0 && ps?.length) {
		const bResult = buildBoundaryEdgeMeta(am, ps, ls, ab, capMinW);
		s.totalEdgesB = bResult.edgeCount;
		s.polyEdgesB  = bResult.polyEdgeCount;
		if (bResult.edgeCount > 0) {
			const bH   = Math.ceil(bResult.edgeCount / s.TEX_META_W);
			const bPad = new Uint32Array(s.TEX_META_W * bH * 4);
			bPad.set(bResult.metaU32);
			s.metaTexB = uploadTex2D(gl, bPad, s.TEX_META_W, bH, gl.RGBA32UI, gl.RGBA_INTEGER);
		}
		console.debug('[gint] boundary edges=%d (%.1f%%)', s.totalEdgesB, s.totalEdges ? 100 * s.totalEdgesB / s.totalEdges : 0);
	}

	// ── 段階別 LOD メタ（低〜中ズームの VS 空回し対策）──────────────────────
	// 動的LOD(u_lod_rank)は閾値未満の辺も VS が起動して捨てる＝辺数が数百万を超えると
	// 「間引いた分がタダにならない」。rank 閾値で事前に間引いたメタを数段焼いておき、
	// 描画時は現在の動的 rank 以下の minWeight を持つ最粗メタへ差し替える。
	// kept 集合（weight >= rank）は動的LODと同一＝見た目は完全同一の純粋な VS 起動数削減。
	// lodSnap の線形歩行も tier 頂点密度に縮む＝二重に効く。
	if (s.lodTiers?.length) s.lodTiers.forEach(t => gl.deleteTexture(t.tex));
	s.lodTiers = [];
	if (s.tierB?.tex) gl.deleteTexture(s.tierB.tex);
	s.tierB = null;
	// tier は「全球・全国が視界内＝空間カリングが効かない低〜中ズーム」の担当。
	// rank↔zoom はデータ非依存（rank r ↔ z=(63−r)/3）なので固定 rank 梯子で刻む：
	// w38↔z8.3 / w42↔z7 / w46↔z5.7 / w50↔z4.3。これより高ズーム（rank<38）は
	// 可視チャンクカリングが担当、これより低ズーム（lowZoom）は境界メタ＋境界tierが担当。
	// 刻みが細かいほど lodSnap の線形歩行も短くなる（tier minW ≈ rank なら歩行ほぼゼロ）。
	// 細い側 26/30/34（↔z12.3/11/9.7）は「視界が巨大データそのもの＝可視チャンクカリングが効かない」帯の穴埋め（v2 と同判断）。
	const TIER_RANKS = [26, 30, 34, 38, 42, 46, 50];
	// 折れ線辺は境界メタでも縮減されない（全量含み）＝ライン主体データ（全米道路網級）は
	// 低ズームで tier が無いと毎フレーム全辺の VS 空回しになる。ライン辺数でも発火を判定する。
	const lineEdges = s.totalEdges - s.polyEdges;
	if (ab?.length && (s.totalEdges > 3_000_000 || lineEdges > 500_000)) {
		let prevEdges = s.totalEdges;
		for (const w of TIER_RANKS) {
			if (w <= capMinW) continue;                     // 基準メタより粗くならない＝無意味
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
	// 巨大ポリゴンは自動ベタ塗りを止める（v2 ortho-core と同判断）。塗り stencil は LOD 非対応の全密度で、
	// 境界メタ（共有 arc 除去）でも国立公園 nps_all 級の広域データは辺数が桁で残る。塗りの実辺数は
	// renderPasses の stCount と同じ選択（境界メタ優先）で測る。明示 fillColor は従来どおり全ズーム尊重。
	const FILL_MAX_EDGES = 2_000_000;
	const fillEdges = (s.metaTexB && s.totalEdgesB > 0) ? s.polyEdgesB : s.polyEdges;
	s.fillOff = fillEdges > FILL_MAX_EDGES;
	if (s.fillOff) console.info('[gint] fill edges=%d > %d＝自動ベタ塗りOFF（アウトラインのみ）', fillEdges, FILL_MAX_EDGES);

	// 境界メタの tier（lowZoom の線パス用）：lowZoom では rank ≥ rank(outlineZoom) が保証されるので
	// その minWeight で 1 段だけ焼けば全 lowZoom 帯をカバーする（lodSnap の線形歩行も消える）。
	// ライン専用（polyEdgesB=0）は線パスが境界メタを使わない（renderPasses の lnB 判定）＝焼かない。
	if (ab?.length && s.totalEdgesB > 500_000 && s.outlineZoom !== null && s.polyEdgesB > 0) {
		const wB = Math.max(capMinW, dynamicLodRankForZoom(s.outlineZoom));
		if (wB > capMinW) {
			const r = buildBoundaryEdgeMeta(am, ps, ls, ab, wB);
			if (r.edgeCount > 0 && r.edgeCount < s.totalEdgesB * 0.7) {
				const tH   = Math.ceil(r.edgeCount / s.TEX_META_W);
				const tPad = new Uint32Array(s.TEX_META_W * tH * 4);
				tPad.set(r.metaU32);
				s.tierB = { minW: wB, edgeCount: r.edgeCount,
					tex: uploadTex2D(gl, tPad, s.TEX_META_W, tH, gl.RGBA32UI, gl.RGBA_INTEGER) };
				console.debug('[gint] boundary tier: w%d=%d辺', wB, r.edgeCount);
			}
		}
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
	if (s.lodTiers?.length) s.lodTiers.forEach(t => gl.deleteTexture(t.tex));
	s.lodTiers = [];
	if (s.tierB?.tex) gl.deleteTexture(s.tierB.tex);
	s.tierB = null;
	s.arcTex = s.metaTex = s.metaTexB = s.ptTex = s.ptMetaTex = null;
}
