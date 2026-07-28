// gint ベイク（純CPU・GL非依存）── GintBUF → テクスチャ搭載直前の派生物一式。
// uploadGintTextures（render worker 同期経路）と bakeworker.js（別スレッド bake-ahead）の単一真実源。
// ここに GL や s（singleton 状態）を持ち込まない＝Node ハーネス（gint-bake.mjs）でそのまま検証できる。
//
// 出力（artifacts）:
//   base:     { metaU32, edgeCount, polyEdgeCount, polyEdgeByFid, chunks }（Morton整列＋約16k辺チャンク台帳）
//   boundary: { metaU32, edgeCount, polyEdgeCount } | null（正味参照≠0 の arc のみ＝stencil/低ズーム線用）
//   polyBboxByFid / outlineZoom / fillOff / capMinW / weightHist
//   pivot:    { px, w, h } | null（fid→bbox テクスチャの中身＝stencil 扇要＋GPU bbox カリング）
// tier は bakeTier() で1段ずつ（遅延構築・progressive 送信の単位に合わせる）。

import { buildEdgeMeta, buildBoundaryEdgeMeta, normalizeRingOrientation,
         buildPolyBboxByFid, deriveOutlineZoom, buildWeightHist } from './utility.js';

// 2M→10M: いわき市(登記所備付地図・約6.9M辺)級でも静的間引きを発火させない＝筆界の正確さ優先
//（ortho-map と同判断）。描画コストは段階別tier＋可視チャンクカリングが回収する。
export const MAX_SAFE_EDGES = 10_000_000;
// 巨大ポリゴンデータは自動ベタ塗りを止める（塗り stencil は tier/カリング非対応の全密度＝斑点根治の設計判断）。
export const FILL_MAX_EDGES = 2_000_000;
// 段階別 LOD メタの固定 rank 梯子（r ↔ z=(63-r)/3）。細い側 26/30/34 は「視界が巨大データそのもの＝
// 可視チャンクカリングが効かない」帯の穴埋め（国立公園451万辺の実測）。
export const TIER_RANKS = [26, 30, 34, 38, 42, 46, 50, 54, 58];
// 空間カリング用チャンク粒度（旧65536は筆層でカリングがほぼ効かなかった＝16384で可視1-3チャンクへ）。
export const CHUNK_EDGES = 16384;

// 基準メタ＋境界メタ＋台帳一式。gintData は {arcBuffer, arcMeta, polyStream, lineStream} を読む
//（polyStream は正規化で符号がその場で書き換わる＝呼び出し側のバッファがそのまま真実になる）。
export function bakeBase(gintData) {
	const { arcBuffer: ab, arcMeta: am, polyStream: ps, lineStream: ls } = gintData;

	// 逆巻きリングの参照符号を正規化（境界メタ netting の前提＋IDバッファ塗りの符号一貫）。データごとに一回。
	if (!gintData._ringsNormalized) {
		normalizeRingOrientation(ab, am, ps);
		gintData._ringsNormalized = true;
	}

	const polyBboxByFid = buildPolyBboxByFid(ps, am);   // 並べ替えキーに使うため先に計算
	const metaOpts = { orderBbox: polyBboxByFid, chunkEdges: CHUNK_EDGES };
	let capMinW = 0;
	let weightHist = null;
	let base = buildEdgeMeta(am, ps, ls, null, 0, metaOpts);
	if (base.edgeCount > MAX_SAFE_EDGES && ab?.length) {
		const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
		weightHist = buildWeightHist(am, ps, ls, arcU32);
		const { hist, nUsages } = weightHist;
		let minW = 63;
		for (let w = 0; w < 64; w++) {
			if (hist[w] - nUsages <= MAX_SAFE_EDGES) { minW = w; break; }
		}
		const capped = buildEdgeMeta(am, ps, ls, ab, minW, metaOpts);
		console.info('[gint] LOD cap: %d→%d edges (minWeight=%d)', base.edgeCount, capped.edgeCount, minW);
		base = capped;
		capMinW = minW;
	}
	gintData._capMinW = capMinW;   // tier 再開（scheduleTierBuild）でも同じキャップを使う

	const outlineZoom = deriveOutlineZoom(polyBboxByFid);   // 低ズームのベタ塗り切替閾値（ポリゴン無し=null=既定へ）
	const fillOff = base.polyEdgeCount > FILL_MAX_EDGES;
	if (fillOff) console.info('[gint] polyEdges=%d > %d＝自動ベタ塗りOFF（アウトラインのみ）', base.polyEdgeCount, FILL_MAX_EDGES);

	// 境界メタ（正味参照≠0 の arc のみ＋折れ線全量）。ライン専用（polyStream 無し）はスキップ。
	let boundary = null;
	if (base.edgeCount > 0 && ps?.length) {
		const b = buildBoundaryEdgeMeta(am, ps, ls, ab, capMinW);
		if (b.edgeCount > 0) boundary = b;
	}

	// fid→bbox テクスチャの中身（①stencil 扇要=bbox中心＝TBDR パラメータバッファ爆発の根治
	// ②feature 単位 GPU bbox カリング）。異常に疎な fid はテクスチャが無駄に巨大化＝null（従来要へ）。
	let pivot = null;
	if (polyBboxByFid?.size) {
		let maxFid = 0;
		for (const fid of polyBboxByFid.keys()) if (fid > maxFid) maxFid = fid;
		if (maxFid < (1 << 22)) {
			const W = 4096, H = Math.ceil((maxFid + 1) / W);
			const px = new Uint32Array(W * H * 4);
			for (const [fid, bb] of polyBboxByFid) {
				px[fid * 4] = bb[0]; px[fid * 4 + 1] = bb[1]; px[fid * 4 + 2] = bb[2]; px[fid * 4 + 3] = bb[3];
			}
			pivot = { px, w: W, h: H };
		}
	}

	return { base, boundary, polyBboxByFid, outlineZoom, fillOff, capMinW, weightHist, pivot };
}

// tier 採否（0.7 ガード）＝構築せずに hist の先読み件数で判定（edgeCount(w)=hist[w]-nUsages、ハーネスで一致証明済）。
// have＝既に構築済みの段（スロット swap-in の途中再開で除外）。返り値は「粗い側から」の素の昇順ではなく
// 呼び出し側で並べ替える（scheduleTierBuild は関連度優先、bakeworker は粗い側から）。
export function tierPlan(gintData, totalEdges, weightHist = null, have = null) {
	const { arcBuffer: ab, arcMeta: am, polyStream: ps, lineStream: ls } = gintData;
	if (!ab?.length || totalEdges <= 200_000) return [];
	const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
	const { hist, nUsages } = weightHist ?? buildWeightHist(am, ps, ls, arcU32);
	const cap = gintData._capMinW ?? 0;
	const plan = [];
	let prevEdges = totalEdges;
	for (const w of TIER_RANKS) {
		if (w <= cap) continue;
		const cnt = hist[w] - nUsages;
		if (!(cnt > 0) || cnt >= prevEdges * 0.7) continue;   // weight無しデータ等＝空/効果薄はスキップ
		if (!have?.has(w)) plan.push(w);
		prevEdges = cnt;   // ガードの基準は既存段も含めた梯子全体で判定（採否は構築有無と独立）
	}
	return plan;
}

// tier 1段のベイク（metaU32/chunks 付き）。orderBbox は bakeBase の polyBboxByFid を渡す。
export function bakeTier(gintData, w, orderBbox) {
	const { arcBuffer: ab, arcMeta: am, polyStream: ps, lineStream: ls } = gintData;
	const r = buildEdgeMeta(am, ps, ls, ab, w, { orderBbox, chunkEdges: CHUNK_EDGES });
	return { minW: w, edgeCount: r.edgeCount, chunks: r.chunks, metaU32: r.metaU32 };
}
