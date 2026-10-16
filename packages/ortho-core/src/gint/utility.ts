// gint の共通の部品（GL2 と WebGPU の両方が使う・純データ構造と計算）。GL の uniform を詰める部分は gl/gint/utility.js（2026-10-15 に分けた）。

/** 頂点のバッファ（Morton 符号化・u32 2 本で 1 頂点＝Uint8Array などの view） */
export type ArcBuffer = ArrayBufferView & { length: number };
/** 辺メタのチャンク台帳の 1 件（可視カリング単位） */
export interface EdgeChunk { start: number; end: number; bbox: number[]; sx: number; sy: number; sub?: number[] | null }
export interface EdgeMetaOptions { orderBbox?: Map<number, number[]> | null; chunkEdges?: number }
/** buildEdgeMeta の戻り */
export interface EdgeMeta { metaU32: Uint32Array; edgeCount: number; polyEdgeCount: number; polyEdgeByFid: Map<number, [number, number]>; chunks: EdgeChunk[] | null; seamSkipped?: number; subCount?: number; sub?: number[] | null; spanX?: number; spanY?: number }
/** buildBoundaryEdgeMeta の戻り */
export interface BoundaryEdgeMeta { metaU32: Uint32Array; edgeCount: number; polyEdgeCount: number; subCount?: number; sub?: number[] | null; spanX?: number; spanY?: number }
export interface WeightHist { hist: Float64Array; nUsages: number }
/** 遠方の要の uniform 一式 */
export interface FarPivotParams { axes: number[]; q: number[]; big: number[] }
/** 遠方の要が読む drawData（farAxes／farScale は drawdata.js・atlas は窓座標モード） */
export interface FarPivotInput { atlas?: { inv: ArrayLike<number> } | null; farAxes?: ArrayLike<number> | null; farScale?: number[] | null }
interface SpanTracker { sx: number; sy: number; ax: number; ay: number; add(a: number, b: number): number; close(): [number, number] }
interface SubRows { metaU32: Uint32Array; subCount: number; sub: number[] | null }

// ── 塗り扇の画面カリング＝遠方の要（2026-10-13）──
// 塗り（stencil／idfill）は feature ごとの要から各辺へ三角形を張り、巻き数で内側を決める。要が bbox 中心だと、視野より
// ずっと大きい feature（国立公園＝1 feature 28 万辺・4°×1.5°）に寄った時、画面外の辺の三角形も要から画面を横切る＝
// 画面外の辺を捨てられず、視野内の feature の全辺がラスタへ流れた（nps_all z13 の平面近似の見積り：42 万三角形）。
// 巻き数は閉じた環なら要の位置に依らない（画面上のどこでも・画面外でも）。視野の FAR_BIG 倍を超える feature だけ、
// 要を「張り出しが最小の側の反対」の遠方（NDC で FAR_K）へ置く＝画面外の辺の三角形は画面外に収まり GPU が捨てる。
// 残るのは視野から張り出し最小の側へ伸びる帯の辺だけ（同見積り 0.4〜4.7 万）。小さい feature は従来の bbox 中心
//（TBDR のパラメータバッファ対策＝細い長三角形を作らない）。FAR_PIVOT.on＝false で旧挙動（比較用）。
export const FAR_PIVOT = { on: true };
export const FAR_K = 64, FAR_BIG = 2;
// uniform 一式（GL bindPivot・WebGPU packGF 共通・d.farAxes は drawdata.js computeDrawData が作る）。vbb＝視野（窓座標モードは窓）の bbox e7。null＝無効
// axes＝NDC での東・北の向き（窓座標モードは経緯度そのもの）・q＝(経度差の重み, 緯度差の重み)・big＝要を遠方へ置く feature の幅/高さ下限（e7）
export function farPivotParams(d: FarPivotInput, vbb: ArrayLike<number> | null | undefined): FarPivotParams | null {
	if (!FAR_PIVOT.on || !vbb) return null;
	let axes: number[], q: number[];
	if (d.atlas) { axes = [1, 0, 0, 1]; q = [d.atlas.inv[0], d.atlas.inv[1]]; }   // 窓座標＝x が経度・y が緯度に線形（重みは窓の縦横比）
	else if (d.farAxes) { axes = Array.from(d.farAxes); q = d.farScale!; }
	else return null;   // 画面中心が地球を外れる（空を向く）＝向きが決まらない
	const big = [Math.min(0xFFFFFFFF, (vbb[2] - vbb[0]) * FAR_BIG), Math.min(0xFFFFFFFF, (vbb[3] - vbb[1]) * FAR_BIG)];
	return { axes, q, big };
}
// 境界メタ（単一要）の遠方の要：境界メタの環は fid を跨いで閉じる＝要は 1 点ならどこでも巻き数は同じ（旧＝画面中心＝全三角形が画面を横切る）。
// 層全体の bbox が視野の FAR_BIG 倍を超える時だけ、per-fid と同じ「張り出し最小の側の反対」の遠方の 1 点（NDC）を返す。null＝従来の画面中心
const _layerBbox = new WeakMap<Map<number, number[]>, number[] | null>();   // polyBboxByFid（Map）→ 層 bbox（e7）。縫い目跨ぎ（x>360e7）を含む層は null
export function layerBboxOf(polyBboxByFid: Map<number, number[]> | null | undefined): number[] | null {
	if (!polyBboxByFid?.size) return null;
	if (_layerBbox.has(polyBboxByFid)) return _layerBbox.get(polyBboxByFid)!;
	let b: number[] | null = [0xFFFFFFFF, 0xFFFFFFFF, 0, 0];
	for (const bb of polyBboxByFid.values()) {
		if (bb[2] > 3600000000) { b = null; break; }
		if (bb[0] < b[0]) b[0] = bb[0]; if (bb[1] < b[1]) b[1] = bb[1]; if (bb[2] > b[2]) b[2] = bb[2]; if (bb[3] > b[3]) b[3] = bb[3];
	}
	_layerBbox.set(polyBboxByFid, b);
	return b;
}
export function farPivotGlobal(d: FarPivotInput, vbb: ArrayLike<number> | null | undefined, lb: ArrayLike<number> | null | undefined): number[] | null {
	const fp = lb ? farPivotParams(d, vbb) : null;
	if (!fp || !(lb![2] - lb![0] > fp.big[0] || lb![3] - lb![1] > fp.big[1])) return null;
	const oL = (vbb![0] - lb![0]) * fp.q[0], oR = (lb![2] - vbb![2]) * fp.q[0], oB = (vbb![1] - lb![1]) * fp.q[1], oT = (lb![3] - vbb![3]) * fp.q[1];
	let dx = fp.axes[0], dy = fp.axes[1], m = oL;   // pivotClip（GLSL/WGSL）と同じ選び方
	if (oR < m) { m = oR; dx = -fp.axes[0]; dy = -fp.axes[1]; }
	if (oB < m) { m = oB; dx = fp.axes[2]; dy = fp.axes[3]; }
	if (oT < m) { dx = -fp.axes[2]; dy = -fp.axes[3]; }
	return [dx * FAR_K, dy * FAR_K];
}

// polygon/polyline flat stream から edge meta の flat Uint32Array を組む。
// 1 edge = [vert_A, vert_B, style_id, feat_id]。逆順 arc(arcIdx<0) は A/B を入れ替え stencil winding を保つ。
// polyStream: Int32Array — comp毎 [fid][numRings][arcCount][arcIdx...]（同fid連続＝multi-polygon）
// lineStream: Int32Array — feature毎 [fid][numSets][arcCount][arcIdx...]
// 返り値 polyEdgeByFid: Map<fid, [edgeStart, edgeCount]>（O(1) highlight レンジ）。
// opts.orderBbox: Map<fid,bbox> — fid グループを bbox 中心 Morton 順に並べ替え（fid内の辺連続は維持＝
//   polyEdgeByFid 無傷）。feature は空間的に小さい＝連続グループがそのまま空間タイルになる。
// opts.chunkEdges: N — feature 境界に揃えた約N辺のチャンク台帳 [{start,end,bbox}] を返す＝可視カリング単位。
// 返り値 polyEdgeCount: ポリゴン辺は先頭に連続配置＝stencil 塗りはこの範囲だけ（折れ線をファンさせない）。
// ── 辺スパンと細分バケット（地形適応細分・2026-09-21）──
// 辺 A→B の経緯度スパン max(|Δx|,|Δy|)（e7 整数・経度は 360e7 周期の最短側）を 1 頂点 1 decode で取り、
// 2 の冪バケット b（スパン ∈ [SUB_S0·2^b, SUB_S0·2^(b+1))・SUB_S0=1e-4°≈11m）へ分類する。b<0＝短辺（細分不要）。
// 描画側は「地形メッシュ 1 セル ≥ バケット上限」のバケットをメイン描画に任せ、それ以上のバケットだけ
// メタ末尾の複製行（bucket-major・chunk-minor）をインスタンス描画で細分する＝費用≈Σ辺ごとの細分数。
export const SUB_S0 = 1000;   // バケット 0 の下限スパン（e7）＝1e-4°
export const SUB_NB = 16;     // バケット数（2^15·SUB_S0 = 3.3° > 度アンカー上限 1°）
export const SUB_DUP = 0x80;  // 複製行の印（meta.b の style バイト bit7）。b>>8 = 元の辺 id
function makeSpanTracker(arcBuffer: ArcBuffer | null | undefined): SpanTracker | null {
	if (!arcBuffer?.length) return null;
	const u32 = new Uint32Array(arcBuffer.buffer, arcBuffer.byteOffset, arcBuffer.byteLength / 4);
	let lastIdx = -1, lx = 0, ly = 0, px = 0, py = 0;
	const dec = (idx: number): void => {   // shader decodeDLL と同一の Morton 展開（L2 は下位6bit=rank をマスク）
		const lo = u32[idx * 2], hi = u32[idx * 2 + 1];
		const loC = (hi & 0x80000000) ? lo : (lo & 0xFFFFFFC0), hiC = hi & 0x7FFFFFFF;
		px = ((_compact16(hiC) << 16) | _compact16(loC)) >>> 0;
		py = ((_compact16(hiC >>> 1) << 16) | _compact16(loC >>> 1)) >>> 0;
	};
	const t: SpanTracker = { sx: 0, sy: 0, ax: 0, ay: 0,   // sx/sy＝現チャンクの最大・ax/ay＝全体の最大
		add(a, b) {   // 返り値＝バケット（-1＝短辺）
			if (a !== lastIdx) { dec(a); lx = px; ly = py; }
			dec(b);
			let dx = px > lx ? px - lx : lx - px; if (dx > 1800000000) dx = 3600000000 - dx;
			const dy = py > ly ? py - ly : ly - py;
			if (dx > t.sx) t.sx = dx; if (dy > t.sy) t.sy = dy;
			lastIdx = b; lx = px; ly = py;
			const sp = dx > dy ? dx : dy;
			if (sp < SUB_S0) return -1;
			const bk = 31 - Math.clz32(Math.floor(sp / SUB_S0));   // floor(log2(sp/S0))
			return bk >= SUB_NB ? SUB_NB - 1 : bk;
		},
		close() { if (t.sx > t.ax) t.ax = t.sx; if (t.sy > t.ay) t.ay = t.sy; const r: [number, number] = [t.sx, t.sy]; t.sx = 0; t.sy = 0; return r; },
	};
	return t;
}
// 複製行の組み立て：bucketOf[e]（-1=短辺）と chunk 台帳から、メタ末尾へ bucket-major・chunk-minor で長辺の複製行を並べ、
// chunk.sub=[b,start,count,…]（start＝メタ行番号・複製区間）を付ける。chunks 無し＝全体を 1 チャンク扱い（result.sub）。
// 複製行＝[A, B, (style|SUB_DUP)|(元の辺id<<8), fid]。VS は SUB_DUP を見て元の行を引き直す（lodSnap の歩行・破線位相は元の辺）。
export function appendSubRows(metaU32: Uint32Array, edgeCount: number, bucketOf: Int8Array, chunks: EdgeChunk[] | null | undefined): SubRows {
	const ranges = chunks?.length ? chunks.map(c => [c.start, c.end]) : [[0, edgeCount]];
	const nc = ranges.length;
	const count = new Uint32Array(SUB_NB * nc);
	for (let c = 0; c < nc; c++) for (let e = ranges[c][0]; e < ranges[c][1]; e++) { const b = bucketOf[e]; if (b >= 0) count[b * nc + c]++; }
	let total = 0; for (let i = 0; i < count.length; i++) total += count[i];
	if (!total) return { metaU32, subCount: 0, sub: null };
	const off = new Uint32Array(SUB_NB * nc); let acc = 0;
	for (let i = 0; i < off.length; i++) { off[i] = acc; acc += count[i]; }
	const out = new Uint32Array((edgeCount + total) * 4);
	out.set(metaU32.subarray(0, edgeCount * 4));
	const cur = off.slice();
	for (let c = 0; c < nc; c++) for (let e = ranges[c][0]; e < ranges[c][1]; e++) {
		const b = bucketOf[e]; if (b < 0) continue;
		const row = (edgeCount + cur[b * nc + c]++) * 4, src = e * 4;
		out[row] = metaU32[src]; out[row + 1] = metaU32[src + 1];
		out[row + 2] = ((metaU32[src + 2] & 0xFF) | SUB_DUP | (e << 8)) >>> 0; out[row + 3] = metaU32[src + 3];
	}
	const subOf = (c: number): number[] | null => { const arr: number[] = []; for (let b = 0; b < SUB_NB; b++) { const n = count[b * nc + c]; if (n) arr.push(b, edgeCount + off[b * nc + c], n); } return arr.length ? arr : null; };
	if (chunks?.length) { for (let c = 0; c < nc; c++) chunks[c].sub = subOf(c); return { metaU32: out, subCount: total, sub: null }; }
	return { metaU32: out, subCount: total, sub: subOf(0) };
}

export function buildEdgeMeta(arcMeta: Uint32Array | null | undefined, polyStream: Int32Array | null | undefined, lineStream: Int32Array | null | undefined, arcBuffer: ArcBuffer | null = null, minWeight = 0, opts: EdgeMetaOptions | null = null): EdgeMeta {
	if (!arcMeta) return { metaU32: new Uint32Array(0), edgeCount: 0, polyEdgeCount: 0, polyEdgeByFid: new Map(), chunks: null };

	const arcU32 = (arcBuffer?.length && minWeight > 0)
		? new Uint32Array(arcBuffer.buffer, arcBuffer.byteOffset, arcBuffer.byteLength / 4)
		: null;
	const getW = arcU32
		? (idx: number): number => (arcU32[idx * 2 + 1] & 0x80000000) ? 63 : (arcU32[idx * 2] & 0x3F)
		: null;
	// ── 縫い目辺（antimeridian 切断の痕）の除去 ──
	// エンコーダ（antimeridianFeature）が ±180 で切った MultiPolygon は、同一 fid の2片が縫い目上の辺を逆向きに
	// 共有する。球面上は境界でない人工スリット＝線パスに出ると「図形を縦に貫く経線180の線」（geoedit 2026-09-12）。
	// v1（ortho-map gintPrograms isAntimeridianEdge）はシェーダで両端 ix=±180 の辺を落としていた。v2 は辺メタ構築
	// 時（純JS・両バックエンド共通・描画コストゼロ）で落とす。落とすのは**同一 fid 内で対になる**縫い目辺だけ
	//（(iy0,iy1) が同じ縫い目辺が2回＝逆向きの対）＝-180 に沿う正規の辺（-180〜-170 の矩形等）は無傷。
	// 塗りへの影響：対は winding 寄与が相殺（境界メタは元々 net 0 で除外）＝idfill の全密度扇でも数学的に同一。
	// 費用：arc bbox が縫い目に触れる層だけ per-vertex decode（roads/筆/census 等は bbox 走査 O(arcs) で門前払い）。
	const IXMAX = 3600000000;
	const seamU32 = (arcBuffer?.length && hasSeamArc(arcMeta))
		? (arcU32 ?? new Uint32Array(arcBuffer.buffer, arcBuffer.byteOffset, arcBuffer.byteLength / 4))
		: null;
	const v2 = [0, 0];
	const decodeXY = (idx: number): number[] => {   // shader decode と同一の Morton 展開（ringArea2 の decode と同式）
		const lo = seamU32![idx * 2], hi = seamU32![idx * 2 + 1];
		const loC = (hi & 0x80000000) ? lo : (lo & 0xFFFFFFC0), hiC = hi & 0x7FFFFFFF;
		v2[0] = ((_compact16(hiC) << 16) | _compact16(loC)) >>> 0;
		v2[1] = ((_compact16(hiC >>> 1) << 16) | _compact16(loC >>> 1)) >>> 0;
		return v2;
	};
	const onSeam = (ix: number): boolean => ix <= 2 || ix >= IXMAX - 2;
	const seamKeyOf = (a: number, b: number): number | null => {   // 両端が縫い目上なら (iy小,iy大) のキー・でなければ null
		const pa = decodeXY(a); const ixa = pa[0], iya = pa[1];
		if (!onSeam(ixa)) return null;
		const pb = decodeXY(b); const ixb = pb[0], iyb = pb[1];
		if (!onSeam(ixb) || iya === iyb) return null;
		return iya < iyb ? iya * 4294967296 + iyb : iyb * 4294967296 + iya;
	};
	// fid グループ（polyStream の [start,end)）の縫い目対＝2回以上現れるキー集合（無ければ null＝通常経路）
	const seamPairsOf = (start: number, end: number): Set<number> | null => {
		const ps = polyStream!;
		let touch = false;
		for (let p = start; p < end && !touch;) {
			p++; const nr = ps[p++];
			for (let r = 0; r < nr && !touch; r++) { const ac = ps[p++];
				for (let a = 0; a < ac; a++) { const ai = ps[p++], aid = ai < 0 ? ~ai : ai, m = aid * 8; if (arcMeta[m + 4] <= 2 || arcMeta[m + 6] >= IXMAX - 2) { touch = true; } }
			}
		}
		if (!touch) return null;
		const count = new Map<number, number>();
		for (let p = start; p < end;) {
			p++; const nr = ps[p++];
			for (let r = 0; r < nr; r++) { const ac = ps[p++];
				for (let a = 0; a < ac; a++) {
					const ai = ps[p++], aid = ai < 0 ? ~ai : ai, off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
					let prev = -1;
					for (let i = 0; i < len; i++) {   // 向きは対称キーなので正方向だけ走査すれば足りる
						const idx = off + i;
						if (getW && getW(idx) < minWeight) continue;
						if (prev !== -1) { const k = seamKeyOf(prev, idx); if (k !== null) count.set(k, (count.get(k) || 0) + 1); }
						prev = idx;
					}
				}
			}
		}
		let pairs: Set<number> | null = null;
		for (const [k, n] of count) if (n >= 2) (pairs ??= new Set()).add(k);
		return pairs;
	};
	let seamSkip: Set<number> | null = null;   // 現在の fid グループの縫い目対（null＝判定コストゼロ）
	let skipped = 0;

	const arcEdges = (aid: number): number => {
		const len = arcMeta[aid * 8 + 1];
		if (!getW) return len - 1;
		const off = arcMeta[aid * 8];
		let kept = 0;
		for (let i = 0; i < len; i++) if (getW(off + i) >= minWeight) kept++;
		return Math.max(0, kept - 1);
	};

	let total = 0;
	const scanStream = (s: Int32Array | null | undefined): void => { if (!s) return; let p = 0;
		while (p < s.length) { p++; const ng = s[p++];
			for (let g = 0; g < ng; g++) { const ac = s[p++];
				for (let a = 0; a < ac; a++) { const ai = s[p++]; total += arcEdges(ai < 0 ? ~ai : ai); }
			}
		}
	};
	scanStream(polyStream); scanStream(lineStream);

	const buf = new Uint32Array(total * 4);
	let j = 0;

	// チャンク台帳（可視カリング単位）
	const chunkEdges = opts?.chunkEdges ?? 0;
	const chunks: EdgeChunk[] | null = chunkEdges ? [] : null;
	let ckStart = 0;
	let ckBox: number[] | null = null;
	const mergeBox = (aid: number): void => { if (!chunks) return;
		const m = aid * 8;
		if (!ckBox) ckBox = [arcMeta[m + 4], arcMeta[m + 5], arcMeta[m + 6], arcMeta[m + 7]];
		else {
			if (arcMeta[m + 4] < ckBox[0]) ckBox[0] = arcMeta[m + 4];
			if (arcMeta[m + 5] < ckBox[1]) ckBox[1] = arcMeta[m + 5];
			if (arcMeta[m + 6] > ckBox[2]) ckBox[2] = arcMeta[m + 6];
			if (arcMeta[m + 7] > ckBox[3]) ckBox[3] = arcMeta[m + 7];
		}
	};
	const span = makeSpanTracker(arcBuffer);   // 辺スパン→細分バケット（複製行）＋チャンク毎の最長辺（arcBuffer 無し＝未知＝-1）
	const bucketOf = span ? new Int8Array(total).fill(-1) : null;   // 辺 id → バケット（-1＝短辺＝細分不要）
	const closeChunk = (force = false): void => { if (!chunks) return;
		const end = j >> 2;
		if (end - ckStart >= chunkEdges || (force && end > ckStart)) {
			const sp = span ? span.close() : [-1, -1];
			chunks.push({ start: ckStart, end, bbox: ckBox ?? [0, 0, 0, 0], sx: sp[0], sy: sp[1] });
			ckStart = end; ckBox = null;
		}
	};

	const addArc = (arcIdx: number, styleId: number, featId: number): void => {
		const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
		mergeBox(aid);
		const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1], fid = featId >>> 0;
		if (!getW) {
			for (let i = 0; i < len - 1; i++) {
				const a = arcIdx >= 0 ? off + i : off + len - 1 - i, b = arcIdx >= 0 ? off + i + 1 : off + len - 2 - i;
				if (seamSkip) { const k = seamKeyOf(a, b); if (k !== null && seamSkip.has(k)) { skipped++; continue; } }
				if (span) bucketOf![j >> 2] = span.add(a, b);
				buf[j++] = a; buf[j++] = b;
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
					if (prev !== -1) {
						if (seamSkip) { const k = seamKeyOf(prev, idx); if (k !== null && seamSkip.has(k)) { skipped++; ei++; prev = idx; continue; } }
						if (span) bucketOf![j >> 2] = span.add(prev, idx);
						buf[j++] = prev; buf[j++] = idx; buf[j++] = (styleId & 0xFF) | (ei++ << 8); buf[j++] = fid;
					}
					prev = idx;
				}
			}
		}
	};

	// Morton 順キー（bbox 中心の上位16bit をインターリーブ）
	const m16 = (v: number): number => { v &= 0xFFFF; v = (v | (v << 8)) & 0xFF00FF; v = (v | (v << 4)) & 0xF0F0F0F; v = (v | (v << 2)) & 0x33333333; v = (v | (v << 1)) & 0x55555555; return v; };
	const mkey = (bb: ArrayLike<number>): number => ((m16((((bb[0] >>> 1) + (bb[2] >>> 1)) >>> 16)) | (m16((((bb[1] >>> 1) + (bb[3] >>> 1)) >>> 16)) << 1)) >>> 0);

	const polyEdgeByFid = new Map<number, [number, number]>();
	if (polyStream) {
		const groups: [number, number, number][] = [];   // [fid, pStart, pEnd]
		let p = 0;
		while (p < polyStream.length) {
			const fid = polyStream[p], start = p;
			while (p < polyStream.length && polyStream[p] === fid) {
				p++; const numRings = polyStream[p++];
				for (let r = 0; r < numRings; r++) { const ac = polyStream[p++]; p += ac; }
			}
			groups.push([fid, start, p]);
		}
		if (opts?.orderBbox && groups.length > 1) {
			const ob = opts.orderBbox;
			const keyOf = (fid: number): number => { const bb = ob.get(fid); return bb ? mkey(bb) : 0; };
			groups.sort((a, b) => keyOf(a[0]) - keyOf(b[0]));
		}
		for (const [fid, start, end] of groups) {
			const eStart = j >> 2;
			seamSkip = seamU32 ? seamPairsOf(start, end) : null;   // 縫い目対（切断の痕）はこの fid の辺から落とす
			let p = start;
			while (p < end) {
				p++; const numRings = polyStream[p++];
				for (let r = 0; r < numRings; r++) {
					const ac = polyStream[p++];
					for (let a = 0; a < ac; a++) addArc(polyStream[p++], 0, fid);
				}
			}
			polyEdgeByFid.set(fid, [eStart, (j >> 2) - eStart]);
			closeChunk();
		}
		seamSkip = null;   // 折れ線は切断で縫い目辺を持たない（分割されるだけ）＝判定しない
		closeChunk(true);   // ポリゴン区画の残りを閉じる（stencil の先頭連続規約と揃える）
	}
	const polyEdgeCount = j >> 2;
	if (lineStream) {
		const groups: [number, number, number][] = [];
		let p = 0;
		while (p < lineStream.length) {
			const fid = lineStream[p], start = p;
			p++; const ns = lineStream[p++];
			for (let g = 0; g < ns; g++) { const ac = lineStream[p++]; p += ac; }
			groups.push([fid, start, p]);
		}
		if (opts?.orderBbox && groups.length > 1) {
			// ライングループは先頭 arc の bbox 中心で代用（[fid][ns][ac][arc0…]＝start+3 が先頭 arc）
			const keyOf = (g: [number, number, number]): number => { const ai = lineStream[g[1] + 3], aid = ai < 0 ? ~ai : ai, m = aid * 8;
				return mkey([arcMeta[m + 4], arcMeta[m + 5], arcMeta[m + 6], arcMeta[m + 7]]); };
			groups.sort((a, b) => keyOf(a) - keyOf(b));
		}
		for (const [fid, start] of groups) {
			let p = start + 1;
			const ns = lineStream[p++];
			for (let g = 0; g < ns; g++) { const ac = lineStream[p++];
				for (let a = 0; a < ac; a++) addArc(lineStream[p++], 1, fid); }
			closeChunk();
		}
		closeChunk(true);
	}
	if (span && !chunks) span.close();   // チャンク台帳無し＝全体最大だけ確定
	const edgeCount = j >> 2;
	const meta0 = skipped ? buf.subarray(0, j) : buf;
	const sub: SubRows = span ? appendSubRows(meta0, edgeCount, bucketOf!, chunks) : { metaU32: meta0, subCount: 0, sub: null };
	return { metaU32: sub.metaU32, edgeCount, polyEdgeCount, polyEdgeByFid, chunks, seamSkipped: skipped,
		subCount: sub.subCount, sub: sub.sub,   // 複製行（長辺の細分用）の行数と、台帳無し時の [b,start,count,…]（台帳有りは chunk.sub）
		spanX: span ? span.ax : -1, spanY: span ? span.ay : -1 };   // 最長辺の経緯度スパン（e7・全体）。-1＝未知
}

// arc bbox が ±180（ix=0 または 360e7）に載る arc が1つでもあるか＝縫い目辺の有無の門（v1 hasAntimeridianSeam の写し）。
// roads/筆/大陸データは ±180 に頂点を持たず false＝per-vertex decode を一切走らせない。
export function hasSeamArc(arcMeta: Uint32Array | null | undefined): boolean {
	if (!arcMeta) return false;
	const IXMAX = 3600000000;
	for (let i = 0, n = (arcMeta.length / 8) | 0; i < n; i++) {
		const b = i * 8;
		if (arcMeta[b + 4] <= 2 || arcMeta[b + 6] >= IXMAX - 2) return true;
	}
	return false;
}

// weight レベル別の累積頂点ヒストグラム（静的キャップと段階別メタの minWeight 選定で共用）。
// hist[w] = weight >= w の頂点総数（arc 使用回数ぶん重複計上）、nUsages = arc 使用回数。
// totalEdges(w) = hist[w] - nUsages（1使用 = kept-1 辺）。
export function buildWeightHist(arcMeta: Uint32Array, polyStream: Int32Array | null | undefined, lineStream: Int32Array | null | undefined, arcU32: Uint32Array): WeightHist {
	const getW = (idx: number): number => (arcU32[idx * 2 + 1] & 0x80000000) ? 63 : (arcU32[idx * 2] & 0x3F);
	const hist = new Float64Array(64);
	let nUsages = 0;
	const countStream = (str: Int32Array | null | undefined): void => {
		if (!str) return; let p = 0;
		while (p < str.length) { p++; const ng = str[p++];
			for (let g = 0; g < ng; g++) { const ac = str[p++];
				for (let a = 0; a < ac; a++) {
					const aid = (str[p] < 0 ? ~str[p] : str[p]); p++; nUsages++;
					const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
					for (let i = 0; i < len; i++) hist[getW(off + i)]++;
				}
			}
		}
	};
	countStream(polyStream); countStream(lineStream);
	for (let w = 62; w >= 0; w--) hist[w] += hist[w + 1];
	return { hist, nUsages };
}

// ── 境界エッジメタ（v1 ortho-map gintUtility から移植・純データ構造）─────────────────
// 「正味参照（forward:+1 / reversed:−1 の符号付き合計）が 0 でない arc」だけの辺集合。
// 隣接筆が共有する arc は必ず逆向きに 2 回参照される＝正味 0 ＝ winding 寄与ゼロなので落として同一。
// - stencil(NOTEQUAL 0 塗り)は全ズームでこれに置換しても数学的に等価（重複筆=同向き2回も正味±2≠0で保持）。
// - 線パスは低ズーム(z<outlineZoom)でこれに切替＝筆内部の線は視認不能(ベタ)なのでアウトラインのみ。
//   筆37万辺級→街区外郭の数万辺＝桁減（anchor支配で tier が組めない筆系の中ズーム＝ズーム中描画の生命線）。
// ※fid重み付き ID バッファ塗りには使えない（相殺は fid 非依存 winding のみ＝idfill.js は基準メタ固定）。
// 前提＝リング向きの一貫性（normalizeRingOrientation を先に一度実行）。

// 1 arc 分の辺を書き出す共通実装。返り値=新しい j。
function emitArcEdges(buf: Uint32Array, j: number, arcIdx: number, styleId: number, featId: number, arcMeta: Uint32Array, getW: ((idx: number) => number) | null, minWeight: number, span: SpanTracker | null = null, bucketOf: Int8Array | null = null): number {
	const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
	const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1], fid = featId >>> 0;
	if (!getW) {
		for (let i = 0; i < len - 1; i++) {
			const a = arcIdx >= 0 ? off + i : off + len - 1 - i, b = arcIdx >= 0 ? off + i + 1 : off + len - 2 - i;
			if (span) bucketOf![j >> 2] = span.add(a, b);
			buf[j++] = a; buf[j++] = b;
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
				if (prev !== -1) { if (span) bucketOf![j >> 2] = span.add(prev, idx); buf[j++] = prev; buf[j++] = idx; buf[j++] = (styleId & 0xFF) | (ei++ << 8); buf[j++] = fid; }
				prev = idx;
			}
		}
	}
	return j;
}

export function buildBoundaryEdgeMeta(arcMeta: Uint32Array | null | undefined, polyStream: Int32Array | null | undefined, lineStream: Int32Array | null | undefined, arcBuffer: ArcBuffer | null = null, minWeight = 0): BoundaryEdgeMeta {
	if (!arcMeta) return { metaU32: new Uint32Array(0), edgeCount: 0, polyEdgeCount: 0 };
	const nArcs = (arcMeta.length / 8) | 0;
	const net   = new Int32Array(nArcs);
	const fidOf = new Int32Array(nArcs).fill(-1);
	if (polyStream) { let p = 0;
		while (p < polyStream.length) { const fid = polyStream[p++], nr = polyStream[p++];
			for (let r = 0; r < nr; r++) { const ac = polyStream[p++];
				for (let a = 0; a < ac; a++) { const ai = polyStream[p++], aid = ai < 0 ? ~ai : ai;
					net[aid] += ai < 0 ? -1 : 1;
					if (fidOf[aid] === -1) fidOf[aid] = fid;
				}
			}
		}
	}

	const arcU32 = (arcBuffer?.length && minWeight > 0)
		? new Uint32Array(arcBuffer.buffer, arcBuffer.byteOffset, arcBuffer.byteLength / 4)
		: null;
	const getW = arcU32
		? (idx: number): number => (arcU32[idx * 2 + 1] & 0x80000000) ? 63 : (arcU32[idx * 2] & 0x3F)
		: null;
	const arcEdges = (aid: number): number => {
		const len = arcMeta[aid * 8 + 1];
		if (!getW) return len - 1;
		const off = arcMeta[aid * 8];
		let kept = 0;
		for (let i = 0; i < len; i++) if (getW(off + i) >= minWeight) kept++;
		return Math.max(0, kept - 1);
	};

	let total = 0;
	for (let aid = 0; aid < nArcs; aid++) if (net[aid] !== 0) total += arcEdges(aid) * Math.abs(net[aid]);
	if (lineStream) { let p = 0;
		while (p < lineStream.length) { p++; const ns = lineStream[p++];
			for (let g = 0; g < ns; g++) { const ac = lineStream[p++];
				for (let a = 0; a < ac; a++) { const ai = lineStream[p++]; total += arcEdges(ai < 0 ? ~ai : ai); } }
		}
	}

	const buf = new Uint32Array(total * 4);
	let j = 0;
	const span = makeSpanTracker(arcBuffer);   // 辺スパン→細分バケット（複製行）。境界メタは台帳無し＝全体 1 チャンク
	const bucketOf = span ? new Int8Array(total).fill(-1) : null;
	// winding の符号を保つため、描画向きは正味符号に従い、|net| 回の多重描画で多重度も保つ
	//（重複筆＝同一リング2回登記で net=±2 の arc を1回に落とすと fan 楔の±1不均衡が漏れる＝v1実測の轍）。
	for (let aid = 0; aid < nArcs; aid++) {
		if (net[aid] !== 0) {
			const mult = Math.abs(net[aid]);
			for (let k = 0; k < mult; k++)
				j = emitArcEdges(buf, j, net[aid] > 0 ? aid : ~aid, 0, fidOf[aid] < 0 ? 0 : fidOf[aid], arcMeta, getW, minWeight, span, bucketOf);
		}
	}
	const polyEdgeCount = j >> 2;   // ポリゴン境界辺は先頭に連続配置（buildEdgeMeta と同じ規約）
	if (lineStream) { let p = 0;
		while (p < lineStream.length) { const fid = lineStream[p++], ns = lineStream[p++];
			for (let g = 0; g < ns; g++) { const ac = lineStream[p++];
				for (let a = 0; a < ac; a++) j = emitArcEdges(buf, j, lineStream[p++], 1, fid, arcMeta, getW, minWeight, span, bucketOf); }
		}
	}
	if (span) span.close();
	const sub: SubRows = span ? appendSubRows(buf, total, bucketOf!, null) : { metaU32: buf, subCount: 0, sub: null };
	return { metaU32: sub.metaU32, edgeCount: total, polyEdgeCount, subCount: sub.subCount, sub: sub.sub, spanX: span ? span.ax : -1, spanY: span ? span.ay : -1 };
}

// ── リング向き正規化（v1 から移植）──────────────────────────────
// 境界メタの「正味参照で相殺」はリング巻き向きの一貫性が前提。実データには逆巻きリングが混入し
//（NOTEQUAL 0 塗りは −1 も塗るため従来は無症状）、netting すると相殺すべきでない arc が消え
// winding 0 の穴 / 負の斑点になる。ロード時に一回、符号付き面積で全リングの向きを検査し、
// polyStream の参照符号を反転して正規化する。基準は外環の多数決。冪等。
// 副次効果＝ID バッファ塗り（idfill.js）の G 符号も揃う。
function _compact16(m: number): number {
	m &= 0x55555555;
	m = (m | (m >>> 1)) & 0x33333333;
	m = (m | (m >>> 2)) & 0x0F0F0F0F;
	m = (m | (m >>> 4)) & 0x00FF00FF;
	m = (m | (m >>> 8)) & 0x0000FFFF;
	return m;
}

export function normalizeRingOrientation(arcBuffer: ArcBuffer | null | undefined, arcMeta: Uint32Array | null | undefined, polyStream: Int32Array | null | undefined): number {
	if (!arcBuffer?.length || !arcMeta || !polyStream?.length) return 0;
	const arcU32 = new Uint32Array(arcBuffer.buffer, arcBuffer.byteOffset, arcBuffer.byteLength / 4);

	// idx → [ix, iy]（shader decode と同一の Morton 展開。L2 は下位6bit=rank をマスク）
	const decode = (idx: number, out: number[]): void => {
		const lo = arcU32[idx * 2], hi = arcU32[idx * 2 + 1];
		const loC = (hi & 0x80000000) ? lo : (lo & 0xFFFFFFC0);
		const hiC = hi & 0x7FFFFFFF;
		out[0] = ((_compact16(hiC) << 16) | _compact16(loC)) >>> 0;
		out[1] = ((_compact16(hiC >>> 1) << 16) | _compact16(loC >>> 1)) >>> 0;
	};

	// リングの符号付き面積×2（e7²単位）。座標はリング先頭からの相対（double 53bit に収める）、
	// 経度差は 360e7 周期でラップ（antimeridian 跨ぎ対策）。
	const v = [0, 0];
	const ringArea2 = (refStart: number, arcCount: number): number => {
		let area2 = 0, x0 = 0, y0 = 0, px = 0, py = 0, first = true;
		for (let a = 0; a < arcCount; a++) {
			const ai = polyStream[refStart + a], aid = ai < 0 ? ~ai : ai;
			const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
			for (let i = 0; i < len; i++) {
				decode(ai < 0 ? off + len - 1 - i : off + i, v);
				if (first) { x0 = v[0]; y0 = v[1]; first = false; px = 0; py = 0; continue; }
				let dx = v[0] - x0;
				if (dx > 1.8e9) dx -= 3.6e9; else if (dx < -1.8e9) dx += 3.6e9;
				const dy = v[1] - y0;
				area2 += px * dy - dx * py;
				px = dx; py = dy;
			}
		}
		return area2;   // 閉路の締め項は先頭が原点(0,0)なので0＝不要
	};

	// 1st pass: 全リングの面積を収集、外環の多数派符号を採る
	const starts: number[] = [], counts: number[] = [], outers: boolean[] = [], areas: number[] = [];
	let p = 0, outerPlus = 0, outerMinus = 0;
	while (p < polyStream.length) {
		p++; const nr = polyStream[p++];
		for (let r = 0; r < nr; r++) {
			const ac = polyStream[p++];
			const a2 = ringArea2(p, ac);
			starts.push(p); counts.push(ac); outers.push(r === 0); areas.push(a2);
			if (r === 0) { if (a2 > 0) outerPlus++; else if (a2 < 0) outerMinus++; }
			p += ac;
		}
	}
	const majority = outerPlus >= outerMinus ? 1 : -1;

	// 2nd pass: 外環=多数派・穴=逆、に合わない参照を符号反転（面積0の退化リングは触らない）
	let flipped = 0;
	for (let k = 0; k < starts.length; k++) {
		const want = outers[k] ? majority : -majority;
		if (areas[k] === 0 || Math.sign(areas[k]) === want) continue;
		const st = starts[k], ac = counts[k];
		for (let a = 0; a < ac; a++) polyStream[st + a] = ~polyStream[st + a];
		flipped++;
	}
	if (flipped > 0) console.info('[gint] ring orientation normalized: %d/%d rings flipped (outer majority %s)',
		flipped, starts.length, majority > 0 ? 'CCW' : 'CW');
	return flipped;
}

// feature毎の bbox Map（Morton整数空間）。JS polygon identify fallback 用。
// 縫い目（±180）を跨いで切断された feature（片が両側）は素朴な min/max だと経度全幅 [0,360e7] に潰れ、中心（扇の要）が
// 反対側・キャップ判定が不能・fit の重心が 0° に化ける（2026-09-15 の一連）。ここで**周期対応の合流**＝arc bbox の中心が現在の
// bbox 中心から 180° 以上離れていれば片方を +360e7 して合流（x は 360e7 を超え得る＝消費側 pivotClip/capVisible/bboxVisible/
// findPolygon は周期で読む）。u32 に収まらない（西片が縫い目から 69° 超）時だけ従来の全幅（消費側の全幅フォールバックが効く）。
const PERIOD_E7 = 3600000000, HALF_E7 = 1800000000, U32_MAX = 0xFFFFFFFF;
export function buildPolyBboxByFid(polyStream: Int32Array | null | undefined, arcMeta: Uint32Array | null | undefined): Map<number, number[]> | null {
	if (!polyStream || !arcMeta || !polyStream.length) return null;
	const byFid = new Map<number, number[]>(); let p = 0;
	while (p < polyStream.length) {
		const fid = polyStream[p++], numRings = polyStream[p++];
		let bb = byFid.get(fid); if (!bb) { bb = [0xFFFFFFFF, 0xFFFFFFFF, 0, 0]; byFid.set(fid, bb); }
		for (let r = 0; r < numRings; r++) { const ac = polyStream[p++];
			for (let a = 0; a < ac; a++) {
				const ai = polyStream[p++], aid = ai < 0 ? ~ai : ai, m = aid * 8;
				let x0 = arcMeta[m+4], x1 = arcMeta[m+6];
				if (bb[2] >= bb[0]) {   // 既に何か入っている＝周期で近い側へ寄せる
					const d = (x0 + x1) / 2 - (bb[0] + bb[2]) / 2;
					if (d < -HALF_E7 && x1 + PERIOD_E7 <= U32_MAX) { x0 += PERIOD_E7; x1 += PERIOD_E7; }             // arc が西端側＝+360 で東へ
					else if (d > HALF_E7 && bb[2] + PERIOD_E7 <= U32_MAX) { bb[0] += PERIOD_E7; bb[2] += PERIOD_E7; }   // 既存が東端側＝bbox を +360 で
				}
				if (x0 < bb[0]) bb[0] = x0; if (arcMeta[m+5] < bb[1]) bb[1] = arcMeta[m+5];
				if (x1 > bb[2]) bb[2] = x1; if (arcMeta[m+7] > bb[3]) bb[3] = arcMeta[m+7];
			}
		}
	}
	return byFid;
}

// アウトライン⇄ベタ塗りの切替ズームをデータ粒度から導出（ortho-map から移植）。中央値ポリゴンが
// 画面 targetPx になるズーム＝これ未満は内部の線がベタ潰れ→面（ベタ塗り）で見せる。筆→z≈16 / 市区町村→z≈7。
// targetPx=8＝v2 の実測調律（256px世界統一 2026-07-26 で 4→8 に+1段。4 のままだと切替が1段広域側へ降り、
// 移動中の境界メタ→フル表現の引き継ぎ（oz+1.5）が可視辺27万＞移動予算25万の縮尺に落ちて
// 「ズーム中に描画なし帯」が生まれる＝札幌37万辺で実証。8 で引き継ぎ点の可視辺18万＝予算内＝連続）。
// bbox は e7 単位（1e-7 度）。中央値＝antimeridian 跨ぎ等の外れ bbox に頑健。ポリゴン無しは null（=既定へ）。
export function deriveOutlineZoom(polyBboxByFid: Map<number, number[]> | null | undefined, targetPx = 8): number | null {
	if (!polyBboxByFid?.size) return null;
	const diags: number[] = [];
	for (const bb of polyBboxByFid.values()) {
		const dx = bb[2] - bb[0], dy = bb[3] - bb[1];
		if (dx > 0 || dy > 0) diags.push(Math.hypot(dx, dy));
	}
	if (!diags.length) return null;
	diags.sort((a, b) => a - b);
	const med = diags[diags.length >> 1];
	const z = Math.log2(targetPx / (med * 40.74 * (Math.PI / 180) * 1e-7));
	return Math.min(17, Math.max(3, z));
}

// arcMeta bbox から minZoom/maxZoom を導き検証。maxZoom は precision の分解能上限で hard-clamp。
// filter（fid 表の visible ビット）で隠した地物を識別から外す述語＝findPolygon / identifyAt の accept（2026-09-26・gint draw spec §4.5）。
// 線と点は GPU の pick が既に visible を見ている＝ホバーで効くのは面（JS の findPolygon）。s＝_fidStyleData を持つ層の状態（GL/WebGPU 共通）。
// 表が無い層（paint 未設定）は null＝全部通す。表の外の fid（setData 直後の旧い表）も通す
export function fidVisible(s: { _fidStyleData?: { u32?: Uint32Array | null; count: number } | null } | null | undefined): ((fid: number) => boolean) | null {
	const d = s?._fidStyleData;
	if (!d?.u32) return null;
	const u = d.u32, n = d.count;
	return fid => fid >= n || (u[fid * 4 + 2] & 1) !== 0;
}

export function checkZoomRange({ arcMeta, minZoom, maxZoom, precision = 6 }: { arcMeta?: Uint32Array | null; minZoom?: number | null; maxZoom?: number | null; precision?: number }): { minZoom: number | null; maxZoom: number } {
	const precisionMax = Math.floor(0.491 + precision * 3.322);
	const requestedMax = maxZoom ?? precisionMax;
	if (requestedMax > precisionMax) {
		console.warn(`[gint] maxZoom(${requestedMax}) exceeds precision(${precision}) limit → clamped to ${precisionMax}`);
	}
	const effectiveMax = Math.min(requestedMax, precisionMax);

	let effectiveMin: number | null = minZoom ?? null;
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
			const suggested = Math.max(0, Math.floor(Math.log2(360 / maxDim)));   // 256px世界のz（旧512世界では -1 していた）
			if (suggested > 0) {
				// minZoom 未指定＝bbox から導いた値を自動採用（小域データを全球で豆粒描画しない）。
				// 明示的に minZoom を渡せばこの自動値は上書きされる（呼び出し側の意図が優先）。
				effectiveMin = suggested;
				console.info(`[gint] minZoom auto-set to ${suggested} (data spans ~${maxDim.toFixed(1)}°)`);
			}
		}
	}

	return { minZoom: effectiveMin, maxZoom: effectiveMax };
}
