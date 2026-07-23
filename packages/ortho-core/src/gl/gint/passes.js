// renderCleanScene:    ハイライト無しの全景（canvas か baseFBO へ）
// drawOverlay:         baseFBO を blit → アクティブ地物のハイライト＋mask
// renderPickingBuffer: feature ID を RGB24 で pick FBO へ
// v1(ortho-map) の gintRenderPasses を移植。site 2 の点bind を mvp/eye/origin へ。
// 単位は device px 一本（u_dpr=1、線幅/半径は worker が ×dpr 済み、blit は width 直）。

import { s, DEF_STYLE, DEF_DASH, DEF_FILL, DEF_MASK } from './state.js';
import { bindSharedUniforms } from './utility.js';

// 低ズームでアウトライン→ベタ塗りへ切替えるズーム閾値の既定（データ粒度から導出した s.outlineZoom を優先）。
const OUTLINE_ZOOM = 12;

// 段階別 LOD メタの選択（ortho-map から移植）：
//   名目＝「rank 適格（minW ≤ rank）で最も軽い tier」。kept 集合（weight≥minW ⊇ weight≥rank）は動的LODの
//   描画結果と同一＝見た目不変。適格 tier が無ければ基準メタ（正確・全密度）＋可視チャンクカリング。
//   安全弁＝名目の可視辺数が「最細 tier の 1.5倍」を超えるなら最細 tier で代用。これ一本で
//   ①梯子の遅延構築中 ②rank < 最細tier の帯 ③チルトで地平線が入り viewBbox=null＝カリング不能、
//   の全てを受ける（名目よりわずかに粗い絵になるだけ。旧・個別ゲートは海岸線41万辺のフル密度描画が
//   地図フレームを塞ぎ GPU 数百ms/フレーム＝実機で激重＋GPUプロセス膨張を起こした）。
// 対象は線・ピッキングのみ（stencil 塗りは全密度＝自己交差斑点の根治を維持、overlay は
// polyEdgeByFid の辺レンジが基準メタ前提のため基準メタ固定）。runs＝可視チャンクだけを描く。
function pickLineTier(rank, baseTex, baseCount) {
	let nominal = null, finest = null;
	for (const t of s.lodTiers ?? []) {
		if (t.minW <= rank && (!nominal || t.edgeCount < nominal.edgeCount)) nominal = t;
		if (!finest || t.minW < finest.minW) finest = t;
	}
	const sel = nominal
		? { tex: nominal.tex, count: nominal.edgeCount, runs: visibleRuns(nominal.edgeCount, nominal.chunks), minW: nominal.minW }
		: { tex: baseTex, count: baseCount, runs: visibleRuns(baseCount, s.metaChunks), minW: 0 };
	s._pfRuns = sel.runs.length; s._pfChunks = (nominal ? nominal.chunks : s.metaChunks)?.length ?? 0;   // perf 計測用
	if (!nominal && finest) {   // 安全弁（適格 tier 無し＝基準メタに落ちた時だけ）
		let visible = 0;
		for (const r of sel.runs) visible += r[1];
		if (visible > finest.edgeCount * 1.5)
			return { tex: finest.tex, count: finest.edgeCount, runs: visibleRuns(finest.edgeCount, finest.chunks), minW: finest.minW };
	}
	return sel;
}

// 可視チャンク run（[startEdge, edgeCount] の列）。チャンク台帳や view bbox が無ければ全量1本。
// マージン: 線幅ぶん bbox を少し広げる（SE=1e7 単位・約 0.001°）。
function visibleRuns(totalCount, chunks) {
	const vb = s.lastViewBbox;
	if (!chunks?.length || !vb) return [[0, totalCount]];
	const mg = 10000;
	const vx0 = vb[0] - mg, vy0 = vb[1] - mg, vx1 = vb[2] + mg, vy1 = vb[3] + mg;
	const runs = [];
	let curStart = -1, curEnd = 0;
	for (const c of chunks) {
		const b = c.bbox;
		const vis = !(b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1);
		if (vis) { if (curStart < 0) curStart = c.start; curEnd = c.end; }
		else if (curStart >= 0) { runs.push([curStart, curEnd - curStart]); curStart = -1; }
	}
	if (curStart >= 0) runs.push([curStart, curEnd - curStart]);
	return runs;
}

// 深度統合（1canvas 段階B）uniform：data.depth（renderer の frame コンテキスト＝terrainDepth 時のみ非null）
// を renderProgram へ。無ければ全0＝従来動作（worker モード含む）。u_elevTex の unit 割当(7)だけは常に行う
//（sampler2D の既定 unit0 は u_arc_tex(usampler2D) と同 unit になり draw が INVALID_OPERATION になるため）。
function bindDepthUniforms(gl, u, data) {
	const dep = data.depth;
	gl.uniform1i(u.u_elevTex, 7);
	gl.uniform1f(u.u_logCoef, dep?.logCoef ?? 0);
	gl.uniform1f(u.u_fogFar,  dep?.fogFar ?? 1e9);
	const op = data.originPt;
	gl.uniform3f(u.u_origin_pt, op?.[0] ?? 0, op?.[1] ?? 0, op?.[2] ?? 0);
	gl.uniform1f(u.u_elevScale, dep?.elevScale ?? 0);
	gl.uniform1f(u.u_hasElev,   dep?.hasElev ?? 0);
	gl.uniform1f(u.u_elevEdgeFade, dep?.edgeFade ?? 0);
	const b = dep?.elevBounds;
	gl.uniform4f(u.u_elevBounds, b?.[0] ?? 0, b?.[1] ?? 0, b?.[2] ?? 1, b?.[3] ?? 1);
	gl.uniform1f(u.u_hidden, 0);
	if (dep?.elevTex) { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, dep.elevTex); gl.activeTexture(gl.TEXTURE0); }
	return dep;
}

// feature bbox テクスチャ（扇要＋GPU bbox カリング）を unit2 へ。無いデータ（線のみ/疎fid）は
// 従来のクリップ原点＆カリング無効。視野bbox は visibleRuns と同じ線幅マージン（e7 で 10000≈0.001°）。
function bindPivot(gl, u) {
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

// site 2（点）：cam 由来の mvp/eye/origin を点プログラムへ。v1 の rotate/scale/rsincos/jac を建て替え。
function bindPointUniforms(u, data) {
	const { gl, ptTex, ptMetaTex, TEX_ARC_W, width, height } = s;
	gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ptTex);
	gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ptMetaTex);
	gl.uniform1i(u.u_pt_tex,      0);
	gl.uniform1i(u.u_pt_meta_tex, 1);
	gl.uniform1i(u.u_pt_w,        TEX_ARC_W);
	gl.uniformMatrix4fv(u.u_mvp, false, data.mvp);
	gl.uniform3f(u.u_eye,    data.eye[0], data.eye[1], data.eye[2]);
	const lon = ((data.origin[0] % 360) + 540) % 360 - 180;
	gl.uniform2f(u.u_origin,   lon, data.origin[1]);
	gl.uniform2f(u.u_viewport, width, height);
	gl.uniform1f(u.u_pt_radius, data.ptRadius ?? 1.5);
	gl.uniform1ui(u.u_ix_center, (Math.round((lon            + 180) * 1e7)) >>> 0);
	gl.uniform1ui(u.u_iy_center, (Math.round((data.origin[1] +  90) * 1e7)) >>> 0);
	// RTE の錨＝原点の三角比＋MVP相殺回避の錨（arc 側 bindSharedUniforms と同一）。
	const lr = lon * Math.PI / 180, br = data.origin[1] * Math.PI / 180;
	gl.uniform4f(u.u_origin_trig, Math.cos(lr), Math.sin(lr), Math.cos(br), Math.sin(br));
	if (data.clipT) gl.uniform4f(u.u_clipT, data.clipT[0], data.clipT[1], data.clipT[2], data.clipT[3]);
	gl.uniform1f(u.u_origin_zr, data.originZr ?? 0.0);
}

export function renderCleanScene(data, targetFBO = null) {
	const { gl, programs, arcTex, metaTex, ptTex, ptMetaTex,
			totalEdges, totalPoints, TEX_ARC_W, TEX_META_W, width, height } = s;
	const { renderProgram, stencilProgram, fillProgram,
			pointProgram, uRender, uStencil, uFill, uPoint, emptyVAO } = programs;

	gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
	if (s.embedded && !targetFBO) {
		// embedded＝地図が既に描かれた default framebuffer の上に blend で重ねる＝色は消さない。
		// stencil だけ消す（塗りの winding 判定用。renderer 側の stencil 利用は都度 clear する規約＝衝突しない）。
		gl.stencilMask(0xFF);
		gl.clear(gl.STENCIL_BUFFER_BIT);
	} else {
		gl.clearColor(0, 0, 0, 0);
		gl.stencilMask(0xFF);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
	}
	gl.bindVertexArray(emptyVAO);

	// ── Stencil + Fill（stencil-then-cover）──
	// 低ズームの既定は面＝ベタ塗り（ortho-map から移植）。style0 の色 × α0.8＝下のタイル(地形/注記)がうっすら
	// 生きる。zoom < outlineZoom（データ粒度から導出＝筆z≈15/市区町村z≈6）かつポリゴンが在る時だけ。
	// 明示 fillColor は全ズームで尊重（透明を渡せば従来のアウトラインのみ）。polyBboxByFid が空＝線/点のみ
	// （海岸線等）＝塗らない（線を winding にファンさせる誤塗り防止）。
	const st = data.styleTable ?? DEF_STYLE;
	const lowZoom = (data.zoom ?? 99) < (s.outlineZoom ?? OUTLINE_ZOOM);
	const hasPoly = (s.polyBboxByFid?.size ?? 0) > 0 && !s.fillOff;   // fillOff＝巨大ポリゴンの自動塗り停止（uploadGintTextures 判定）
	const fc = data.fillColor ?? (lowZoom && hasPoly ? [st[0], st[1], st[2], st[3] * 0.8] : DEF_FILL);
	if (fc[3] > 0 && s.polyEdges > 0) {
		gl.enable(gl.STENCIL_TEST);
		gl.stencilMask(0xFF);
		gl.clear(gl.STENCIL_BUFFER_BIT);
		gl.colorMask(false, false, false, false);
		gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
		gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
		gl.stencilOpSeparate(gl.BACK,  gl.KEEP, gl.KEEP, gl.DECR_WRAP);
		gl.useProgram(stencilProgram);
		bindSharedUniforms(gl, uStencil, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
		bindPivot(gl, uStencil);
		gl.uniform1f(uStencil.u_lod_rank, 0);   // 塗りstencilは全密度＝LOD簡略化の自己交差による斑点(winding反転)を防ぐ
		// ポリゴン辺（メタ先頭連続）のみ winding にファン＝折れ線辺を混ぜない（ortho-map と同規約）
		gl.drawArrays(gl.TRIANGLES, 0, s.polyEdges * 3);
		gl.colorMask(true, true, true, true);
		gl.stencilMask(0x00);
		gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF);
		gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
		gl.useProgram(fillProgram);
		gl.uniform4fv(uFill.u_fill_color, fc);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.disable(gl.STENCIL_TEST);
	}

	// ── Fat-line edges ──（低〜中ズーム＝tier / 高ズーム＝可視チャンク run）
	if (totalEdges > 0) {
		const lnSel = pickLineTier(data.lodRank ?? 0, metaTex, totalEdges);
		gl.useProgram(renderProgram);
		bindSharedUniforms(gl, uRender, data, arcTex, lnSel.tex, TEX_ARC_W, TEX_META_W, width, height);
		gl.uniform1f(uRender.u_line_width,   data.lineWidth ?? 1.0);   // device px（worker 済み）
		gl.uniform1f(uRender.u_dpr,          1.0);                     // device px 一本化
		gl.uniform1i(uRender.u_active_id,    -1);
		gl.uniform4fv(uRender.u_style_table, data.styleTable ?? DEF_STYLE);
		gl.uniform2fv(uRender.u_dash_table,  data.dashTable  ?? DEF_DASH);
		gl.uniform1i(uRender.u_pass, 0);
		bindPivot(gl, uRender);   // feature bbox カリング（ポリゴン辺のみ VS が判定）
		// 深度統合（段階B・山岳ビュー z<13 のみ dep 非null）：線を地形深度でテスト（書かない）＝
		// 尾根の向こうは実線が消え、直後の GREATER パスが「淡い固定破線」で拾う（CAD の隠線表現）。
		const dep = bindDepthUniforms(gl, uRender, data);
		if (dep) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); }
		let pfEdges = 0;   // perf 計測用（実際に発行した辺数＝tier/カリングの効き確認。?perf=1 の行へ）
		for (const [est, cnt] of (lnSel.runs ?? [[0, lnSel.count]])) {
			pfEdges += cnt;
			gl.drawArrays(gl.TRIANGLES, est * 6, cnt * 6);
		}
		s._pfLineEdges = pfEdges; s._pfTierW = lnSel.minW ?? -1;
		if (dep) {
			// 隠線パスは静止時のみ（移動中は省略＝tilt山岳ビューの線頂点コストを半減）。淡破線は装飾＝
			// パン/ズーム中に一瞬消えても違和感がなく、settle の再描画で必ず戻る（terrainGate と同じ思想）。
			// 可視辺数が大きい時も省略（fillOff と同じ自動品質ノブ）：anchor支配で tier が組めない筆系37万辺で
			// 2パス目がフレームを倍にする（実機 gpuGint 90ms級）＝装飾のために本業を落とさない。
			if (!s._isDrawing && pfEdges < 100_000) {
				gl.depthFunc(gl.GREATER);
				gl.uniform1f(uRender.u_hidden, 1);
				for (const [est, cnt] of (lnSel.runs ?? [[0, lnSel.count]]))
					gl.drawArrays(gl.TRIANGLES, est * 6, cnt * 6);
				gl.uniform1f(uRender.u_hidden, 0);
				gl.depthFunc(gl.LEQUAL);
			}
			gl.disable(gl.DEPTH_TEST);
			gl.depthMask(true);
		}
	}

	// ── Points ──
	if (totalPoints > 0 && ptTex && ptMetaTex) {
		gl.useProgram(pointProgram);
		bindPointUniforms(uPoint, data);
		gl.uniform1i(uPoint.u_active_id, -1);
		gl.drawArrays(gl.TRIANGLES, 0, totalPoints * 6);
	}

	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

export function drawOverlay() {
	const { gl, baseFBO, lastDrawData, width, height } = s;
	if (!baseFBO || !lastDrawData) return;

	// baseFBO → canvas を blit して前フレームの overlay を消す。
	gl.bindFramebuffer(gl.READ_FRAMEBUFFER, baseFBO);
	gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
	gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.stencilMask(0xFF);
	gl.clear(gl.STENCIL_BUFFER_BIT);

	drawHighlight(lastDrawData);
}

// アクティブ地物のハイライト（太線＋黄・点拡大・外側マスク）。blit を含まない純描画＝
// worker モードは drawOverlay（blit 後）から、embedded モードは毎フレームの gint パス末尾から呼ぶ。
export function drawHighlight(data) {
	const { gl, programs, arcTex, metaTex, ptTex, ptMetaTex,
			totalEdges, totalPoints, TEX_ARC_W, TEX_META_W, width, height,
			activeId, polyEdgeByFid } = s;
	if (activeId === -1) return;
	if (!arcTex && !ptTex) return;

	const { renderProgram, stencilProgram, fillProgram,
			pointProgram, uRender, uStencil, uFill, uPoint, emptyVAO } = programs;
	gl.bindVertexArray(emptyVAO);

	const range    = polyEdgeByFid?.get(activeId);
	const eStart   = range?.[0] ?? null;
	const eCount   = range?.[1] ?? null;
	const hasRange = eStart != null && eCount > 0;

	// Edge highlight：太く＋黄。深度統合時もハイライトは深度免除＝選択地物は尾根の向こうでも実線で示す
	//（識別の主目的は「どれが当たっているか」＝隠さない）。ドレープだけ掛けて基図と同じ高さに乗せる。
	gl.useProgram(renderProgram);
	bindSharedUniforms(gl, uRender, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
	bindDepthUniforms(gl, uRender, data);
	gl.uniform1f(uRender.u_line_width,   (data.lineWidth ?? 1.0) + 2.0);
	gl.uniform1f(uRender.u_dpr,          1.0);
	gl.uniform1i(uRender.u_active_id,    activeId);
	gl.uniform4fv(uRender.u_style_table, data.styleTable ?? DEF_STYLE);
	gl.uniform2fv(uRender.u_dash_table,  data.dashTable  ?? DEF_DASH);
	gl.uniform1i(uRender.u_pass, 1);
	if (hasRange) {
		gl.drawArrays(gl.TRIANGLES, eStart * 6, eCount * 6);
	} else if (totalEdges > 0) {
		gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 6);
	}

	// Point highlight：大きく＋黄。
	if (totalPoints > 0 && ptTex && ptMetaTex) {
		gl.useProgram(pointProgram);
		bindPointUniforms(uPoint, data);
		gl.uniform1i(uPoint.u_active_id, activeId);
		gl.drawArrays(gl.TRIANGLES, 0, totalPoints * 6);
	}

	// Polygon mask：アクティブ地物の外を暗く。
	const mc = data.maskColor ?? DEF_MASK;
	if (mc[3] > 0 && hasRange) {
		gl.enable(gl.STENCIL_TEST);
		gl.stencilMask(0xFF);
		gl.clear(gl.STENCIL_BUFFER_BIT);
		gl.colorMask(false, false, false, false);
		gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
		gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
		gl.stencilOpSeparate(gl.BACK,  gl.KEEP, gl.KEEP, gl.DECR_WRAP);
		gl.useProgram(stencilProgram);
		bindSharedUniforms(gl, uStencil, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
		bindPivot(gl, uStencil);
		gl.drawArrays(gl.TRIANGLES, eStart * 3, eCount * 3);
		gl.colorMask(true, true, true, true);
		gl.stencilMask(0x00);
		gl.stencilFunc(gl.EQUAL, 0, 0xFF);
		gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
		gl.useProgram(fillProgram);
		gl.uniform4fv(uFill.u_fill_color, mc);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.disable(gl.STENCIL_TEST);
	}
}

export function renderPickingBuffer(data) {
	const { gl, programs, arcTex, metaTex, ptTex, ptMetaTex,
			totalEdges, totalPoints, TEX_ARC_W, TEX_META_W, width, height, pickFBO } = s;
	if (!pickFBO) return;
	if (!arcTex && !ptTex) return;

	const { pickLineProgram, pickPointProgram, uPickLine, uPickPoint } = programs;
	try {
		gl.bindFramebuffer(gl.FRAMEBUFFER, pickFBO);
		gl.clearColor(0, 0, 0, 0);
		gl.stencilMask(0xFF);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.disable(gl.BLEND);

		// 見た目の線より太く描いて pick 感度を上げる（~12 device px マージン）。
		const pickMargin = 12 * (s.dpr ?? 1);
		if (totalEdges > 0 && metaTex) {
			const pkSel = pickLineTier(data.lodRank ?? 0, metaTex, totalEdges);
			gl.useProgram(pickLineProgram);
			bindSharedUniforms(gl, uPickLine, data, arcTex, pkSel.tex, TEX_ARC_W, TEX_META_W, width, height);
			gl.uniform1f(uPickLine.u_line_width, (data.lineWidth ?? 1.0) + pickMargin);
			for (const [est, cnt] of (pkSel.runs ?? [[0, pkSel.count]]))
				gl.drawArrays(gl.TRIANGLES, est * 6, cnt * 6);
		}

		if (totalPoints > 0 && ptTex && ptMetaTex) {
			gl.useProgram(pickPointProgram);
			bindPointUniforms(uPickPoint, data);
			gl.uniform1f(uPickPoint.u_pt_radius, Math.max(data.ptRadius ?? 1.5, pickMargin * 0.5));
			gl.drawArrays(gl.TRIANGLES, 0, totalPoints * 6);
		}

		gl.enable(gl.BLEND);
	} finally {
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.colorMask(true, true, true, true);
		gl.stencilMask(0xFF);
		gl.disable(gl.STENCIL_TEST);
	}
}
