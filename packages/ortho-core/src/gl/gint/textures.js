// テクスチャ管理 — set() と context-restore の両方から呼ばれ、gintData から全テクスチャを再構築。
// v1(ortho-map) の gintTextures を移植。node-free（GintBUF→テクスチャ、投影に触れない）＝逐語で携行。

import { s } from './state.js';
import { uploadTex2D, buildEdgeMeta, buildBoundaryEdgeMeta, normalizeRingOrientation, buildPolyBboxByFid, deriveOutlineZoom, buildWeightHist } from './utility.js';


export function uploadGintTextures() {
	const { gl, gintData } = s;
	if (!gl || !gintData) return;
	const { arcBuffer: ab, arcMeta: am, polyStream: ps, lineStream: ls, pointBuffer: pb } = gintData;

	// 逆巻きリングの参照符号を正規化（境界メタ netting の前提＋IDバッファ塗りの符号一貫）。データごとに一回。
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
	// edge 数が MAX_SAFE_EDGES を超えたら Visvalingam-Whyatt rank で自動 LOD 簡約（安全上限のキャップ）。
	// per-zoom の Dynamic LOD は GPU 側（VS の rank discard）で行う＝ここは全密度アップロードのみ。
	if (s.metaTex) gl.deleteTexture(s.metaTex);
	s.metaTex = null;
	// 2M→10M: いわき市(登記所備付地図・約6.9M辺)級でも静的間引きを発火させない＝筆界の正確さ優先
	//（ortho-map と同判断）。描画コストは段階別tier＋可視チャンクカリングが回収する。
	const MAX_SAFE_EDGES = 10_000_000;
	// 空間カリング用：fid グループを bbox Morton 順に並べ替え＋約16384辺のチャンク台帳（bbox付き・tier と同粒度）。
	// 旧 65536 は筆層（37万辺＝台帳6個）でカリングがほぼ効かず、高ズームでも数十万辺を毎フレーム描いた。
	// 16384 なら台帳走査は数十個＝タダのまま、可視は1-3チャンクへ絞れる（anchor支配で tier が組めない層の生命線）。
	s.polyBboxByFid = buildPolyBboxByFid(ps, am);   // 並べ替えキーに使うため先に計算
	const metaOpts = { orderBbox: s.polyBboxByFid, chunkEdges: 16384 };
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
	console.debug('[gint] edges=%d chunks=%d ck0=%s', edgeCount, s.metaChunks?.length ?? 0, JSON.stringify(s.metaChunks?.[0]?.bbox ?? null));   // ck0＝bbox欠落データ（全ゼロ）の検出用
	s.outlineZoom = deriveOutlineZoom(s.polyBboxByFid);   // 低ズームのベタ塗り切替閾値（ポリゴン無し=null=既定へ）
	// per-feature bbox テクスチャ（fid→bbox e7整数・RGBA32UI）。用途は2つ：
	// ① stencil 塗りの扇要（bbox中心）：旧・クリップ原点（画面中心）要は全三角形が「画面中心→辺」＝
	//    TBDR(Apple GPU)のビニング用パラメータバッファが辺数×画面級三角形で爆発（筆50.9万辺の fill
	//    表示瞬間に GPU プロセスがGB級膨張＝実機実測）。巻き数は閉リングなら要の位置に依存しない＝
	//    feature 局所要で正確さ不変・三角形は筆サイズ＝バッファ正常化。
	// ② feature 単位の GPU bbox カリング：チャンク粒度（広域ポリゴン＝国立公園級で無力）より細かく、
	//    VS 冒頭で fid→bbox × 視野bbox の交差判定＝視野外 feature の辺/塗りを丸ごと捨てる。
	if (s.pivotTex) { gl.deleteTexture(s.pivotTex); s.pivotTex = null; }
	s.pivotW = 0;
	if (s.polyBboxByFid?.size) {
		let maxFid = 0;
		for (const fid of s.polyBboxByFid.keys()) if (fid > maxFid) maxFid = fid;
		if (maxFid < (1 << 22)) {   // 異常に疎な fid はテクスチャが無駄に巨大化＝従来要へフォールバック
			const W = Math.min(4096, s.TEX_ARC_W), H = Math.ceil((maxFid + 1) / W);
			const px = new Uint32Array(W * H * 4);
			for (const [fid, bb] of s.polyBboxByFid) {
				px[fid * 4] = bb[0]; px[fid * 4 + 1] = bb[1]; px[fid * 4 + 2] = bb[2]; px[fid * 4 + 3] = bb[3];
			}
			s.pivotTex = uploadTex2D(gl, px, W, H, gl.RGBA32UI, gl.RGBA_INTEGER);
			s.pivotW = W;
		}
	}

	// 巨大ポリゴンデータは自動ベタ塗りを止める（アウトラインのみ）。塗り stencil は tier/カリング非対応の全密度
	//（斑点根治の設計判断）＝polyEdges×3頂点が毎フレーム走り、国立公園 nps_all（数M辺・広域）で顕在化した。
	// 明示 fillColor は従来どおり全ズーム尊重（renderCleanScene 側の ?? 条件）＝呼び出し側の意思で塗れる。
	const FILL_MAX_EDGES = 2_000_000;
	s.fillOff = polyEdgeCount > FILL_MAX_EDGES;
	if (s.fillOff) console.info('[gint] polyEdges=%d > %d＝自動ベタ塗りOFF（アウトラインのみ）', polyEdgeCount, FILL_MAX_EDGES);
	if (s.totalEdges > 0) {
		const metaH   = Math.ceil(s.totalEdges / s.TEX_META_W);
		const metaPad = new Uint32Array(s.TEX_META_W * metaH * 4);
		metaPad.set(metaU32);
		s.metaTex = uploadTex2D(gl, metaPad, s.TEX_META_W, metaH, gl.RGBA32UI, gl.RGBA_INTEGER);
	}

	// metaTexB: 境界エッジメタ（正味参照≠0 の arc のみ＋折れ線全量）。v1 から移植。
	// stencil 単色塗りは常時こちら（winding 等価で桁違いに軽い）、線パスは低ズーム(z<outlineZoom)で切替＝
	// アウトライン表示。anchor支配で tier が組めない筆系の中ズーム（37万辺フル密度＝gpuGint 20-37ms実測）の答え。
	// ライン専用（polyStream 無し）は縮減されない＝構築ごとスキップ。IDバッファ塗りは fid 重みのため使えない＝基準メタ固定。
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

	// ── 段階別 LOD メタ（ortho-map から移植）──
	// 「全球・全国が視界内＝空間カリングが効かない低〜中ズーム」担当。rank↔zoom はデータ非依存
	//（r ↔ z=(63-r)/3）なので固定 rank 梯子：w38↔z8.3 / w42↔z7 / w46↔z5.7 / w50↔z4.3 / w54↔z3 / w58↔z1.7。
	// kept 集合は動的LOD（u_lod_rank）と同一＝見た目不変の純粋な VS 起動数削減。
	// 高ズーム（rank<38）は可視チャンクカリングが担当。
	// 発動閾値 200k：海岸線(NE10m≈41万辺)級を全球ビュー（z<4＝gint が地図そのもの・view bbox=null＝
	// カリング不能）で毎フレーム全辺 VS＋アンカー辺の長大 walk にしない＝「軽さ」の決め手。
	// 各 tier にもチャンク台帳（16k辺粒度）＝中ズームで tier×可視カリングを併用。
	//
	// 【構築は 1 tier ずつ macrotask に刻む】set() 内で同期に全段作ると、14条級（数百k〜数M辺）の
	// ドロップ急寄りで worker が数百ms〜秒単位ブロック＝sync(drawing) が詰まり直前フレーム（海岸線）が
	// 残像として固まる。tier は未完成でも基準メタで正しく描ける（遅いだけ）＝遅延構築が常に安全。
	// 採否（0.7 ガード）は buildWeightHist の正確な件数（edgeCount(w)=hist[w]-nUsages）で先に判定し、
	// 作らない tier は走査もしない。構築順は粗い側から＝全球ビューが最初の1段で即恩恵。
	if (s.lodTiers?.length) s.lodTiers.forEach(t => gl.deleteTexture(t.tex));
	s.lodTiers = [];
	const gen = s.tierGen = (s.tierGen ?? 0) + 1;   // 差し替え/クリア/context復元で旧スケジュールを無効化
	// 細い側 26/30/34（↔z12.3/11/9.7）は「視界が巨大データそのもの＝可視チャンクカリングが効かない」帯の穴埋め。
	// 国立公園451万辺の実測で z8(rank35)=最細tier(w38)不適格＋カリング無力＝z6比12倍のフレームコストだった。
	const TIER_RANKS = [26, 30, 34, 38, 42, 46, 50, 54, 58];
	if (ab?.length && s.totalEdges > 200_000) {
		const tierOpts = { orderBbox: s.polyBboxByFid, chunkEdges: 16384 };
		const buildPlan = () => {
			const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
			const { hist, nUsages } = weightHist ?? buildWeightHist(am, ps, ls, arcU32);
			const plan = [];
			let prevEdges = s.totalEdges;
			for (const w of TIER_RANKS) {
				if (w <= capMinW) continue;
				const cnt = hist[w] - nUsages;
				if (!(cnt > 0) || cnt >= prevEdges * 0.7) continue;   // weight無しデータ等＝空/効果薄はスキップ
				plan.push(w); prevEdges = cnt;
			}
			// 構築順：現在ビューの rank で即適格になる最細の段を最優先、残りは粗い側から。
			// 旧＝一律粗い側からだと、fit直後のズーム（z6級=rank45→w42）が4段目＝巨大データ
			//（国立公園451万辺）では「梯子が揃うまで基準メタ全辺VS」の窓が体感を支配していた。
			const rank = s.lastDrawData?.lodRank ?? 0;
			const usable = plan.filter(w => w <= rank);
			const first = usable.length ? Math.max(...usable) : null;
			return [...(first != null ? [first] : []), ...plan.filter(w => w !== first).reverse()];
		};
		let plan = null;
		s.tiersDone = false;   // 構築中＝pickLineTier の代用フォールバック（過渡期限定）を許可
		const buildNext = () => {
			if (gen !== s.tierGen || !s.gl || s.gintData?.arcBuffer !== ab) return;   // データ差し替え/破棄＝中止
			if (s._isDrawing) { setTimeout(buildNext, 120); return; }   // 移動中は組まない（terrainGate と同じ思想＝停止時に構築）
			plan ??= buildPlan();
			const w = plan.shift();
			if (w == null) {
				s.tiersDone = true;
				if (s.lodTiers.length) console.debug('[gint] LOD tiers: %s tcks=%s',
					s.lodTiers.map(t => `w${t.minW}=${t.edgeCount}辺(ck${t.chunks?.length ?? 0})`).join(' / '),
					JSON.stringify(s.lodTiers[0]?.chunks?.map(c => c.bbox) ?? null));   // tier チャンク bbox の健全性検査用
				postMessage({ action: 'tiers', tiers: s.lodTiers.map(t => ({ minW: t.minW, edgeCount: t.edgeCount })) });
				return;
			}
			const r = buildEdgeMeta(am, ps, ls, ab, w, tierOpts);
			if (r.edgeCount) {
				const tH   = Math.ceil(r.edgeCount / s.TEX_META_W);
				const tPad = new Uint32Array(s.TEX_META_W * tH * 4);
				tPad.set(r.metaU32);
				s.lodTiers.push({ minW: w, edgeCount: r.edgeCount, chunks: r.chunks,
					tex: uploadTex2D(gl, tPad, s.TEX_META_W, tH, gl.RGBA32UI, gl.RGBA_INTEGER) });
			}
			setTimeout(buildNext, 0);
		};
		setTimeout(buildNext, 0);
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
	if (s.metaTexB)  gl.deleteTexture(s.metaTexB);
	if (s.ptTex)     gl.deleteTexture(s.ptTex);
	if (s.ptMetaTex) gl.deleteTexture(s.ptMetaTex);
	if (s.pivotTex)  gl.deleteTexture(s.pivotTex);
	if (s.lodTiers?.length) s.lodTiers.forEach(t => gl.deleteTexture(t.tex));
	s.lodTiers = [];
	s.metaChunks = null;
	s.arcTex = s.metaTex = s.metaTexB = s.ptTex = s.ptMetaTex = s.pivotTex = null;
	s.totalEdgesB = s.polyEdgesB = 0;
	s.pivotW = 0;
}
