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
// 段階別 LOD メタの梯子は固定 rank 表でなく weightHist の分位点から層ごとに適応生成する（tierPlan）。
// 旧固定表 [26,30,…,58] は海岸線/行政界級（重みが高域まで分布）が前提で、筆ポリゴン級＝重みが 9〜25 に
// 集中する層では w26 の1段しか立たず、pickLineTier の過負荷フォールバックが常時 w26 を描いて
// 孤立筆が三角形化した（観音寺市 2026-08-26・v1 ortho-map はフォールバック無し＝基準メタ直描きで無事）。
export const TIER_COUNT = 9;   // 梯子の最大段数（旧固定表と同数＝構築コスト/テクスチャ総量を旧来の枠に保つ）
// tier 1段の辺数上限。これより細い（＝辺数の多い）段は作らない：その帯は視界がデータの一部＝可視チャンク
// カリングが基準メタを十分絞る（国立公園4.5Mで w14=306万辺≈49MBテクスチャの無駄を防ぐ・Air3 jetsam圏）。
// pickLineTier の過負荷フォールバックは finest×1.5 を閾に基準メタへ倒れる＝finest がこの上限近くにあれば
// 近接ズームは自然に基準メタ＋カリングで正しく描かれる。
export const TIER_MAX_EDGES = 600_000;
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
	// 塗り上限は層ごとに上書き可（gintData.fillMaxEdges）。既定 2M は筆/国立公園級の暴走止め＝
	// フル解像度の行政界コロプレス(admin_all 437万辺)は呼び出し側が明示的に budget を上げて全密度塗りを通す。
	const fillCap = gintData.fillMaxEdges ?? FILL_MAX_EDGES;
	const fillOff = base.polyEdgeCount > fillCap;
	if (fillOff) console.info('[gint] polyEdges=%d > %d＝自動ベタ塗りOFF（アウトラインのみ）', base.polyEdgeCount, fillCap);

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

	// lowFill＝fillOff でも低ズーム帯（z<outlineZoom）の単色ベタ塗りだけは生かす層別フラグ（geoedit 大規模モード）。
	// 低ズーム塗りは境界メタ stencil（正味winding≠0のみ＝隣接データなら桁減）＝v1(ortho-map) が全密度で滑らかに
	// 描けていた帯であり、fillOff の本来の標的（per-fid idfill・全ズーム常時の全密度扇）とはコスト構造が別。
	return { base, boundary, polyBboxByFid, outlineZoom, fillOff, lowFill: !!gintData.lowFill, capMinW, weightHist, pivot };
}

// tier の適応梯子＝構築せずに hist の先読み件数で選定（edgeCount(w)=hist[w]-nUsages、ハーネスで一致証明済）。
// 最細段＝基準辺の 0.7 未満になる最小 w（これより細い段は効果薄＝旧 0.7 ガードと同じ基準）。以降は件数比
// ρ=min(0.7, 全レンジ^(1/(K-1))) の等比で粗い端まで＝どの重み分布でも「実在する重み帯」に最大 K 段が立ち、
// 各段は前段から3割以上の削減を保証する（筆層は終端(rank63)床で自然に打ち止め＝段数は K 未満で収束）。
// have＝既に構築済みの段（スロット swap-in の途中再開で除外）。plan は同一データ・同一コードで決定的＝
// 再開時も同じ梯子を再計算して差分だけ積む。返り値は昇順、並べ替えは呼び出し側
//（scheduleTierBuild は関連度優先、bakeworker は粗い側から）。
export function tierPlan(gintData, totalEdges, weightHist = null, have = null) {
	const { arcBuffer: ab, arcMeta: am, polyStream: ps, lineStream: ls } = gintData;
	if (!ab?.length || totalEdges <= 200_000) return [];
	const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
	const { hist, nUsages } = weightHist ?? buildWeightHist(am, ps, ls, arcU32);
	const cap = gintData._capMinW ?? 0;
	const cnt = w => hist[w] - nUsages;
	const fineCap = Math.min(totalEdges * 0.7, TIER_MAX_EDGES);
	let wLo = -1;
	for (let w = cap + 1; w < 63; w++) if (cnt(w) > 0 && cnt(w) <= fineCap) { wLo = w; break; }
	if (wLo < 0) return [];   // weight無しデータ等＝どの段も効果薄
	let wHi = wLo;
	for (let w = 62; w > wLo; w--) if (cnt(w) > 0) { wHi = w; break; }
	const rho = Math.min(0.7, Math.pow(cnt(wHi) / cnt(wLo), 1 / Math.max(1, TIER_COUNT - 1)));
	const plan = [wLo];
	let prev = cnt(wLo);
	for (let w = wLo + 1; w <= wHi && plan.length < TIER_COUNT; w++) {
		const c = cnt(w);
		if (!(c > 0)) break;
		if (c <= prev * rho) { plan.push(w); prev = c; }
	}
	return have ? plan.filter(w => !have.has(w)) : plan;
}

// tier 1段のベイク（metaU32/chunks 付き）。orderBbox は bakeBase の polyBboxByFid を渡す。
export function bakeTier(gintData, w, orderBbox) {
	const { arcBuffer: ab, arcMeta: am, polyStream: ps, lineStream: ls } = gintData;
	const r = buildEdgeMeta(am, ps, ls, ab, w, { orderBbox, chunkEdges: CHUNK_EDGES });
	return { minW: w, edgeCount: r.edgeCount, chunks: r.chunks, metaU32: r.metaU32 };
}
