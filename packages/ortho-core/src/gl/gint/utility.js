// gint 共有ユーティリティ（v2）。v1(ortho-map) の gintUtility を移植。
// bindSharedUniforms のみ node-dependent（site 2＝投影 uniform）。他は純データ構造＝逐語で携行。

import { s } from './state.js';

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
	// RTE の錨＝原点の三角比を CPU(double) で算出（shader の float32 で origin+delta を組まない）。
	const lr = lon * Math.PI / 180, br = data.origin[1] * Math.PI / 180;
	gl.uniform4f(u.u_origin_trig, Math.cos(lr), Math.sin(lr), Math.cos(br), Math.sin(br));
	// MVP相殺回避の錨（worker が float64 で算出）。欠落時は 0 でなく等価挙動へ退避不能なので必ず渡す。
	if (data.clipT) gl.uniform4f(u.u_clipT, data.clipT[0], data.clipT[1], data.clipT[2], data.clipT[3]);
	gl.uniform1f(u.u_origin_zr, data.originZr ?? 0.0);
	gl.uniform1f(u.u_lod_rank, data.lodRank ?? 0.0);   // GPU Dynamic LOD 閾値（未設定=0=全描画）
}

// feature bbox テクスチャ（扇要＋GPU bbox カリング）を unit2 へ。無いデータ（線のみ/疎fid）は
// 従来のクリップ原点＆カリング無効。視野bbox は visibleRuns と同じ線幅マージン（e7 で 10000≈0.001°）。
// （passes.js から移設＝idfill.js の ID 塗りパスと共用）
export function bindPivot(gl, u) {
	gl.uniform1i(u.u_pivot_tex, 2);
	gl.uniform1i(u.u_pivot_w, s.pivotW || 1);
	gl.uniform1i(u.u_has_pivot, s.pivotTex ? 1 : 0);
	const vb = s.lastViewBbox;
	gl.uniform1i(u.u_use_vbb, (s.pivotTex && vb) ? 1 : 0);
	if (vb) gl.uniform4ui(u.u_view_bbox,
		Math.max(0, vb[0] - 10000), Math.max(0, vb[1] - 10000),
		Math.min(0xFFFFFFFF, vb[2] + 10000), Math.min(0xFFFFFFFF, vb[3] + 10000));
	if (s.pivotTex) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, s.pivotTex); gl.activeTexture(gl.TEXTURE0); }
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
// opts.orderBbox: Map<fid,bbox> — fid グループを bbox 中心 Morton 順に並べ替え（fid内の辺連続は維持＝
//   polyEdgeByFid 無傷）。feature は空間的に小さい＝連続グループがそのまま空間タイルになる。
// opts.chunkEdges: N — feature 境界に揃えた約N辺のチャンク台帳 [{start,end,bbox}] を返す＝可視カリング単位。
// 返り値 polyEdgeCount: ポリゴン辺は先頭に連続配置＝stencil 塗りはこの範囲だけ（折れ線をファンさせない）。
export function buildEdgeMeta(arcMeta, polyStream, lineStream, arcBuffer = null, minWeight = 0, opts = null) {
	if (!arcMeta) return { metaU32: new Uint32Array(0), edgeCount: 0, polyEdgeCount: 0, polyEdgeByFid: new Map(), chunks: null };

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

	// チャンク台帳（可視カリング単位）
	const chunkEdges = opts?.chunkEdges ?? 0;
	const chunks = chunkEdges ? [] : null;
	let ckStart = 0;
	let ckBox = null;
	const mergeBox = (aid) => { if (!chunks) return;
		const m = aid * 8;
		if (!ckBox) ckBox = [arcMeta[m + 4], arcMeta[m + 5], arcMeta[m + 6], arcMeta[m + 7]];
		else {
			if (arcMeta[m + 4] < ckBox[0]) ckBox[0] = arcMeta[m + 4];
			if (arcMeta[m + 5] < ckBox[1]) ckBox[1] = arcMeta[m + 5];
			if (arcMeta[m + 6] > ckBox[2]) ckBox[2] = arcMeta[m + 6];
			if (arcMeta[m + 7] > ckBox[3]) ckBox[3] = arcMeta[m + 7];
		}
	};
	const closeChunk = (force = false) => { if (!chunks) return;
		const end = j >> 2;
		if (end - ckStart >= chunkEdges || (force && end > ckStart)) {
			chunks.push({ start: ckStart, end, bbox: ckBox ?? [0, 0, 0, 0] });
			ckStart = end; ckBox = null;
		}
	};

	const addArc = (arcIdx, styleId, featId) => {
		const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
		mergeBox(aid);
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

	// Morton 順キー（bbox 中心の上位16bit をインターリーブ）
	const m16 = v => { v &= 0xFFFF; v = (v | (v << 8)) & 0xFF00FF; v = (v | (v << 4)) & 0xF0F0F0F; v = (v | (v << 2)) & 0x33333333; v = (v | (v << 1)) & 0x55555555; return v; };
	const mkey = bb => ((m16((((bb[0] >>> 1) + (bb[2] >>> 1)) >>> 16)) | (m16((((bb[1] >>> 1) + (bb[3] >>> 1)) >>> 16)) << 1)) >>> 0);

	const polyEdgeByFid = new Map();
	if (polyStream) {
		const groups = [];   // [fid, pStart, pEnd]
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
			const keyOf = fid => { const bb = opts.orderBbox.get(fid); return bb ? mkey(bb) : 0; };
			groups.sort((a, b) => keyOf(a[0]) - keyOf(b[0]));
		}
		for (const [fid, start, end] of groups) {
			const eStart = j >> 2;
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
		closeChunk(true);   // ポリゴン区画の残りを閉じる（stencil の先頭連続規約と揃える）
	}
	const polyEdgeCount = j >> 2;
	if (lineStream) {
		const groups = [];
		let p = 0;
		while (p < lineStream.length) {
			const fid = lineStream[p], start = p;
			p++; const ns = lineStream[p++];
			for (let g = 0; g < ns; g++) { const ac = lineStream[p++]; p += ac; }
			groups.push([fid, start, p]);
		}
		if (opts?.orderBbox && groups.length > 1) {
			// ライングループは先頭 arc の bbox 中心で代用（[fid][ns][ac][arc0…]＝start+3 が先頭 arc）
			const keyOf = g => { const ai = lineStream[g[1] + 3], aid = ai < 0 ? ~ai : ai, m = aid * 8;
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
	return { metaU32: buf, edgeCount: total, polyEdgeCount, polyEdgeByFid, chunks };
}

// weight レベル別の累積頂点ヒストグラム（静的キャップと段階別メタの minWeight 選定で共用）。
// hist[w] = weight >= w の頂点総数（arc 使用回数ぶん重複計上）、nUsages = arc 使用回数。
// totalEdges(w) = hist[w] - nUsages（1使用 = kept-1 辺）。
export function buildWeightHist(arcMeta, polyStream, lineStream, arcU32) {
	const getW = (idx) => (arcU32[idx * 2 + 1] & 0x80000000) ? 63 : (arcU32[idx * 2] & 0x3F);
	const hist = new Float64Array(64);
	let nUsages = 0;
	const countStream = (str) => {
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
function emitArcEdges(buf, j, arcIdx, styleId, featId, arcMeta, getW, minWeight) {
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
	return j;
}

export function buildBoundaryEdgeMeta(arcMeta, polyStream, lineStream, arcBuffer = null, minWeight = 0) {
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
	for (let aid = 0; aid < nArcs; aid++) if (net[aid] !== 0) total += arcEdges(aid) * Math.abs(net[aid]);
	if (lineStream) { let p = 0;
		while (p < lineStream.length) { p++; const ns = lineStream[p++];
			for (let g = 0; g < ns; g++) { const ac = lineStream[p++];
				for (let a = 0; a < ac; a++) { const ai = lineStream[p++]; total += arcEdges(ai < 0 ? ~ai : ai); } }
		}
	}

	const buf = new Uint32Array(total * 4);
	let j = 0;
	// winding の符号を保つため、描画向きは正味符号に従い、|net| 回の多重描画で多重度も保つ
	//（重複筆＝同一リング2回登記で net=±2 の arc を1回に落とすと fan 楔の±1不均衡が漏れる＝v1実測の轍）。
	for (let aid = 0; aid < nArcs; aid++) {
		if (net[aid] !== 0) {
			const mult = Math.abs(net[aid]);
			for (let k = 0; k < mult; k++)
				j = emitArcEdges(buf, j, net[aid] > 0 ? aid : ~aid, 0, fidOf[aid] < 0 ? 0 : fidOf[aid], arcMeta, getW, minWeight);
		}
	}
	const polyEdgeCount = j >> 2;   // ポリゴン境界辺は先頭に連続配置（buildEdgeMeta と同じ規約）
	if (lineStream) { let p = 0;
		while (p < lineStream.length) { const fid = lineStream[p++], ns = lineStream[p++];
			for (let g = 0; g < ns; g++) { const ac = lineStream[p++];
				for (let a = 0; a < ac; a++) j = emitArcEdges(buf, j, lineStream[p++], 1, fid, arcMeta, getW, minWeight); }
		}
	}
	return { metaU32: buf, edgeCount: total, polyEdgeCount };
}

// ── リング向き正規化（v1 から移植）──────────────────────────────
// 境界メタの「正味参照で相殺」はリング巻き向きの一貫性が前提。実データには逆巻きリングが混入し
//（NOTEQUAL 0 塗りは −1 も塗るため従来は無症状）、netting すると相殺すべきでない arc が消え
// winding 0 の穴 / 負の斑点になる。ロード時に一回、符号付き面積で全リングの向きを検査し、
// polyStream の参照符号を反転して正規化する。基準は外環の多数決。冪等。
// 副次効果＝ID バッファ塗り（idfill.js）の G 符号も揃う。
function _compact16(m) {
	m &= 0x55555555;
	m = (m | (m >>> 1)) & 0x33333333;
	m = (m | (m >>> 2)) & 0x0F0F0F0F;
	m = (m | (m >>> 4)) & 0x00FF00FF;
	m = (m | (m >>> 8)) & 0x0000FFFF;
	return m;
}

export function normalizeRingOrientation(arcBuffer, arcMeta, polyStream) {
	if (!arcBuffer?.length || !arcMeta || !polyStream?.length) return 0;
	const arcU32 = new Uint32Array(arcBuffer.buffer, arcBuffer.byteOffset, arcBuffer.byteLength / 4);

	// idx → [ix, iy]（shader decode と同一の Morton 展開。L2 は下位6bit=rank をマスク）
	const decode = (idx, out) => {
		const lo = arcU32[idx * 2], hi = arcU32[idx * 2 + 1];
		const loC = (hi & 0x80000000) ? lo : (lo & 0xFFFFFFC0);
		const hiC = hi & 0x7FFFFFFF;
		out[0] = ((_compact16(hiC) << 16) | _compact16(loC)) >>> 0;
		out[1] = ((_compact16(hiC >>> 1) << 16) | _compact16(loC >>> 1)) >>> 0;
	};

	// リングの符号付き面積×2（e7²単位）。座標はリング先頭からの相対（double 53bit に収める）、
	// 経度差は 360e7 周期でラップ（antimeridian 跨ぎ対策）。
	const v = [0, 0];
	const ringArea2 = (refStart, arcCount) => {
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
	const starts = [], counts = [], outers = [], areas = [];
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

// アウトライン⇄ベタ塗りの切替ズームをデータ粒度から導出（ortho-map から移植）。中央値ポリゴンが
// 画面 targetPx になるズーム＝これ未満は内部の線がベタ潰れ→面（ベタ塗り）で見せる。筆→z≈15 / 市区町村→z≈6。
// bbox は e7 単位（1e-7 度）。中央値＝antimeridian 跨ぎ等の外れ bbox に頑健。ポリゴン無しは null（=既定へ）。
export function deriveOutlineZoom(polyBboxByFid, targetPx = 4) {
	if (!polyBboxByFid?.size) return null;
	const diags = [];
	for (const bb of polyBboxByFid.values()) {
		const dx = bb[2] - bb[0], dy = bb[3] - bb[1];
		if (dx > 0 || dy > 0) diags.push(Math.hypot(dx, dy));
	}
	if (!diags.length) return null;
	diags.sort((a, b) => a - b);
	const med = diags[diags.length >> 1];
	const z = Math.log2(targetPx / (med * 40.74 * (Math.PI / 180) * 1e-7));
	return Math.min(16, Math.max(2, z));
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
