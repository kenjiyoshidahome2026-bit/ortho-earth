// テクスチャ管理 — set() と context-restore の両方から呼ばれ、gintData から全テクスチャを再構築。
// v1(ortho-map) の gintTextures を移植。CPU ベイク（メタ構築）は bake.js が単一真実源＝
//   uploadGintTextures = bakeBase を同期呼び（従来経路・worker モード/フォールバック）
//   uploadBaked        = bake worker が別スレッドで焼いた artifacts を受けてアップロードのみ（bake-ahead）
// どちらも s への台帳反映とテクスチャ搭載はここで一元化（applyArtifacts）。

import { s } from './state.js';
import { uploadTex2D } from './utility.js';
import { bakeBase, bakeTier, tierPlan } from './bake.js';

// RGBA32UI メタ（基準/境界/tier 共通）を TEX_META_W 幅にパディングして搭載。
function uploadMetaTex(gl, metaU32, edgeCount) {
	const h   = Math.ceil(edgeCount / s.TEX_META_W);
	const pad = new Uint32Array(s.TEX_META_W * h * 4);
	pad.set(metaU32);
	return uploadTex2D(gl, pad, s.TEX_META_W, h, gl.RGBA32UI, gl.RGBA_INTEGER);
}

// artifacts（bake.js の出力）を s に反映しテクスチャを搭載する共通部。
// 事前条件: s.gintData がベイク元（正規化済み polyStream/arcBuffer）を指していること。
function applyArtifacts(art) {
	const { gl, gintData } = s;
	const { arcBuffer: ab, pointBuffer: pb } = gintData;

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

	// metaTex: RGBA32UI — edge metadata (vert_A, vert_B, style_id, feat_id)。
	// per-zoom の Dynamic LOD は GPU 側（VS の rank discard）＝ここは（キャップ後の）全密度アップロードのみ。
	if (s.metaTex) gl.deleteTexture(s.metaTex);
	s.metaTex = null;
	s.totalEdges    = art.base.edgeCount;
	s.polyEdges     = art.base.polyEdgeCount;
	s.polyEdgeByFid = art.base.polyEdgeByFid;
	s.metaChunks    = art.base.chunks;
	s.polyBboxByFid = art.polyBboxByFid;
	s.outlineZoom   = art.outlineZoom;   // 低ズームのベタ塗り切替閾値（ポリゴン無し=null=既定へ）
	s.fillOff       = art.fillOff;       // 巨大ポリゴンの自動ベタ塗り停止（明示 fillColor は従来どおり尊重）
	s.lowFill       = !!art.lowFill;     // fillOff でも低ズーム帯の単色塗りだけ生かす層別フラグ（geoedit 大規模モード）
	console.debug('[gint] edges=%d chunks=%d ck0=%s', s.totalEdges, s.metaChunks?.length ?? 0,
		JSON.stringify(s.metaChunks?.[0]?.bbox ?? null));   // ck0＝bbox欠落データ（全ゼロ）の検出用
	if (s.totalEdges > 0) s.metaTex = uploadMetaTex(gl, art.base.metaU32, s.totalEdges);

	// pivotTex: per-feature bbox（RGBA32UI）。①stencil 塗りの扇要（bbox中心）＝TBDR パラメータバッファ
	// 爆発の根治 ②feature 単位 GPU bbox カリング。疎 fid データは bake が null＝従来のクリップ原点要へ。
	if (s.pivotTex) { gl.deleteTexture(s.pivotTex); s.pivotTex = null; }
	s.pivotW = 0;
	if (art.pivot && art.pivot.w <= s.TEX_ARC_W) {   // 古い GPU（MAX_TEXTURE_SIZE<4096）は載らない＝フォールバック
		s.pivotTex = uploadTex2D(gl, art.pivot.px, art.pivot.w, art.pivot.h, gl.RGBA32UI, gl.RGBA_INTEGER);
		s.pivotW = art.pivot.w;
	}

	// metaTexB: 境界エッジメタ（正味参照≠0 の arc のみ＋折れ線全量）。stencil 単色塗りは常時こちら
	//（winding 等価で桁違いに軽い）、線パスは低ズーム(z<outlineZoom)で切替＝アウトライン表示。
	if (s.metaTexB) gl.deleteTexture(s.metaTexB);
	s.metaTexB = null;
	s.totalEdgesB = 0;
	s.polyEdgesB  = 0;
	if (art.boundary) {
		s.totalEdgesB = art.boundary.edgeCount;
		s.polyEdgesB  = art.boundary.polyEdgeCount;
		s.metaTexB    = uploadMetaTex(gl, art.boundary.metaU32, art.boundary.edgeCount);
		console.debug('[gint] boundary edges=%d (%.1f%%)', s.totalEdgesB, s.totalEdges ? 100 * s.totalEdgesB / s.totalEdges : 0);
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
		const ptMetaPad = new Uint32Array(s.TEX_ARC_W * ptH);
		ptMetaPad.set(gintData.point.subarray(0, s.totalPoints));
		s.ptMetaTex = uploadTex2D(gl, ptMetaPad, s.TEX_ARC_W, ptH, gl.R32UI, gl.RED_INTEGER);
	} else {
		s.totalPoints = 0;
	}

	// tier 台帳のリセット（搭載は呼び出し側＝同期経路なら scheduleTierBuild、bake-ahead なら addBakedTier）
	if (s.lodTiers?.length) s.lodTiers.forEach(t => gl.deleteTexture(t.tex));
	s.lodTiers = [];
	s.tiersDone = false;
}

// 従来経路（同期ベイク）：worker モード（gishub 検証/t-gintlod）と、bake worker 不在時のフォールバック。
export function uploadGintTextures() {
	const { gl, gintData } = s;
	if (!gl || !gintData) return;
	const art = bakeBase(gintData);
	applyArtifacts(art);
	// tier は 1 段ずつ macrotask に刻んで遅延構築（set() 内同期構築は数百k〜数M辺で worker を秒級ブロック）
	scheduleTierBuild({ weightHist: art.weightHist });
}

// bake-ahead 経路：bake worker が焼いた artifacts（base/boundary/pivot 等）を受けてアップロードのみ。
// tier は addBakedTier で1段ずつ届き、finishBakedTiers で梯子完成（過渡期は pickLineTier の代用/キャップが受ける）。
export function uploadBaked(art) {
	const { gl, gintData } = s;
	if (!gl || !gintData) return;
	applyArtifacts(art);
}

// bake worker から届いた tier 1段を搭載（bundle 指定時は「眠っているスロット」へ＝s を経由しない）。
export function addBakedTier(tier, bundle = null) {
	const { gl } = s;
	if (!gl || !tier?.edgeCount) return;
	const tex = uploadMetaTex(gl, tier.metaU32, tier.edgeCount);
	const list = bundle ? bundle.lodTiers : s.lodTiers;
	list.push({ minW: tier.minW, edgeCount: tier.edgeCount, chunks: tier.chunks, tex });
	list.sort((a, b) => a.minW - b.minW);   // minW 昇順の台帳規約
}

export function finishBakedTiers(bundle = null) {
	if (bundle) { bundle.tiersDone = true; return; }
	s.tiersDone = true;
	const tiers = s.lodTiers ?? [];
	if (tiers.length) console.debug('[gint] LOD tiers(baked): %s',
		tiers.map(t => `w${t.minW}=${t.edgeCount}辺(ck${t.chunks?.length ?? 0})`).join(' / '));
	postMessage({ action: 'tiers', tiers: tiers.map(t => ({ minW: t.minW, edgeCount: t.edgeCount })) });
	s.requestDraw?.();   // ハードキャップ(-3)や代用 tier で描いていたフレームを完全な絵へ
}

// tier 梯子の遅延構築（1段ずつ macrotask・移動中は組まない・世代/データ一致で中止）＝同期ベイク経路用。
// uploadGintTextures（新規データ）と embed.js の swap-in（スロット復帰で梯子が未完のまま眠っていた層）
// の両方から呼ばれる＝s.lodTiers に既にある段は plan から除外して途中再開する。
// 採否（0.7 ガード）は bake.js tierPlan（hist 先読み）＝作らない tier は走査もしない。
export function scheduleTierBuild({ weightHist = null } = {}) {
	const { gl, gintData } = s;
	const ab = gintData?.arcBuffer;
	const gen = s.tierGen = (s.tierGen ?? 0) + 1;   // 差し替え/クリア/context復元/再スケジュールで旧スケジュールを無効化
	if (!ab?.length || s.totalEdges <= 200_000) { s.tiersDone = true; return; }
	let plan = null;
	const buildPlan = () => {
		const have = new Set((s.lodTiers ?? []).map(t => t.minW));   // 途中再開＝既存の段は作らない
		const p = tierPlan(gintData, s.totalEdges, weightHist, have);
		// 構築順：現在ビューの rank で即適格になる最細の段を最優先、残りは粗い側から。
		// 旧＝一律粗い側からだと、fit直後のズーム（z6級=rank45→w42）が4段目＝巨大データ
		//（国立公園451万辺）では「梯子が揃うまで基準メタ全辺VS」の窓が体感を支配していた。
		const rank = s.lastDrawData?.lodRank ?? 0;
		const usable = p.filter(w => w <= rank);
		const first = usable.length ? Math.max(...usable) : null;
		return [...(first != null ? [first] : []), ...p.filter(w => w !== first).reverse()];
	};
	s.tiersDone = false;   // 構築中＝pickLineTier の代用フォールバック（過渡期限定）を許可
	const buildNext = () => {
		if (gen !== s.tierGen || !s.gl || s.gintData?.arcBuffer !== ab) return;   // データ差し替え/スロット交替/破棄＝中止（swap-in が再スケジュール）
		if (s._isDrawing) { setTimeout(buildNext, 120); return; }   // 移動中は組まない（terrainGate と同じ思想＝停止時に構築）
		plan ??= buildPlan();
		const w = plan.shift();
		if (w == null) {
			s.tiersDone = true;
			if (s.lodTiers.length) console.debug('[gint] LOD tiers: %s tcks=%s',
				s.lodTiers.map(t => `w${t.minW}=${t.edgeCount}辺(ck${t.chunks?.length ?? 0})`).join(' / '),
				JSON.stringify(s.lodTiers[0]?.chunks?.map(c => c.bbox) ?? null));   // tier チャンク bbox の健全性検査用
			postMessage({ action: 'tiers', tiers: s.lodTiers.map(t => ({ minW: t.minW, edgeCount: t.edgeCount })) });
			s.requestDraw?.();   // 梯子完成＝ハードキャップ(-3)で部分描画していたフレームを完全な絵へ描き直す（embedded のみ非null）
			return;
		}
		const r = bakeTier(gintData, w, s.polyBboxByFid);
		if (r.edgeCount) {
			s.lodTiers.push({ minW: r.minW, edgeCount: r.edgeCount, chunks: r.chunks,
				tex: uploadMetaTex(gl, r.metaU32, r.edgeCount) });
			s.lodTiers.sort((a, b) => a.minW - b.minW);   // minW 昇順の台帳規約を再開挿入でも維持
		}
		setTimeout(buildNext, 0);
	};
	setTimeout(buildNext, 0);
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
