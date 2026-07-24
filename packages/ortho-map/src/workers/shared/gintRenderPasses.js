// renderCleanScene:    full scene without highlights (canvas or baseFBO)
// drawOverlay:         blit baseFBO → apply active-feature highlight + mask
// renderPickingBuffer: encode feature IDs as RGB24 into the pick FBO

import { s, DEF_STYLE, DEF_DASH, DEF_FILL, DEF_MASK } from './gintState.js';
import { bindSharedUniforms, dynamicLodRank } from './gintUtility.js';

// 段階別 LOD メタの選択：現在の動的 rank 以下の minWeight を持つ最粗 tier を返す。
// tier の kept 集合（weight >= minW ⊇ weight >= rank）は動的LODの描画結果と同一＝見た目不変。
// 対象は線・ピッキングのみ（stencil 塗りは全密度＝自己交差斑点の根治を維持、overlay は
// polyEdgeByFid の辺レンジが基準メタ前提のため基準メタ固定）。
// tier が無い（rank が低い＝高ズーム）時は runs=可視チャンクだけを描く（空間カリング）。
function pickLineTier(scale, baseTex, baseCount) {
	if (s.lodTiers?.length) {
		const rank = dynamicLodRank(scale);
		let tex = null, count = 0;
		for (const t of s.lodTiers) if (t.minW <= rank && (tex === null || t.edgeCount < count)) { tex = t.tex; count = t.edgeCount; }
		if (tex) return { tex, count, runs: null };
	}
	return { tex: baseTex, count: baseCount, runs: visibleRuns(baseCount, scale) };
}

// 可視チャンク run（[startEdge, edgeCount] の列）。チャンク台帳や view bbox が無ければ全量1本。
// マージン: 線幅ぶん bbox を少し広げる（8px 相当・SE 単位）。
function visibleRuns(totalCount, scale) {
	const chunks = s.metaChunks, vb = s.lastViewBbox;
	if (!chunks?.length || !vb) return [[0, totalCount]];
	const mg = Math.round(8 / (scale || 1) * (180 / Math.PI) * 1e7) || 0;
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

function bindPointUniforms(u, data, r1, r2) {
	const { gl, ptTex, ptMetaTex, TEX_ARC_W, width, height } = s;
	gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ptTex);
	gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ptMetaTex);
	gl.uniform1i(u.u_pt_tex,      0);
	gl.uniform1i(u.u_pt_meta_tex, 1);
	gl.uniform1i(u.u_pt_w,        TEX_ARC_W);
	gl.uniform3f(u.u_rotate,    data.rotate[0], data.rotate[1], data.rotate[2] ?? 0);
	gl.uniform1f(u.u_scale,     data.scale);
	gl.uniform2f(u.u_viewport,  width, height);
	const cf = Math.cos(r1), sf = Math.sin(r1), cg = Math.cos(r2), sg = Math.sin(r2);
	gl.uniform4f(u.u_rsincos,   cf, sf, cg, sg);
	gl.uniform1f(u.u_pt_radius, data.ptRadius ?? 1.5);
	gl.uniform1ui(u.u_ix_center, (Math.round((-data.rotate[0] + 180) * 1e7)) >>> 0);
	gl.uniform1ui(u.u_iy_center, (Math.round((-data.rotate[1] +  90) * 1e7)) >>> 0);
	if (data.scale > 2e5) {
		const k = data.scale * (Math.PI / 180) * 1e-7;
		gl.uniform4f(u.u_jac, cf*cg*k, -cf*sg*k, -sg*k, -cg*k);
	} else {
		gl.uniform4f(u.u_jac, 0, 0, 0, 0);
	}
}

// ステンシル可視化デバッグ（プローブ）：塗りの代わりに winding カウントを色分け表示。
// 緑=1(正常単被覆) 赤=2 マゼンタ=3+ 青=-1(255) シアン=-2(254) 無色=0。
// 赤/マゼンタ=データ重複、青/シアン=向き/正味符号の異常、無色の穴=隙間スライバー or 輪郭破れ。
const STENCIL_DEBUG = false;

// 線パスを境界メタ（アウトラインのみ）へ切り替えるズーム閾値の既定値。
// 実際はデータ粒度から導出した s.outlineZoom（中央値ポリゴン≈4px のズーム）を優先し、
// 導出不能（ポリゴン無し等）の時だけこの値へフォールバック。
// これ未満では筆内部の線は視認不能（ベタ潰れ）なので描かない＝低ズームの主コストを桁で削減。
const OUTLINE_ZOOM = 12;

export function renderCleanScene(data, targetFBO = null) {
	const { gl, programs, arcTex, metaTex, metaTexB, ptTex, ptMetaTex,
			totalEdges, totalEdgesB, totalPoints, polyEdges, polyEdgesB,
			TEX_ARC_W, TEX_META_W, width, height } = s;
	const { renderProgram, stencilProgram, fillProgram,
			pointProgram, uRender, uStencil, uFill, uPoint, emptyVAO } = programs;

	gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
	gl.clearColor(0, 0, 0, 0);
	gl.stencilMask(0xFF);
	gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
	gl.bindVertexArray(emptyVAO);

	// 塗りは常時境界メタ（共有 arc は winding 寄与が正味 0 ＝落としても数学的に同一で桁違いに軽い）。
	const hasB = !!(metaTexB && totalEdgesB > 0);
	const zoom = Math.log2(data.scale / 40.74);
	const outlineZoom = s.outlineZoom ?? OUTLINE_ZOOM;
	const lowZoom = zoom < outlineZoom;

	// ── Stencil + Fill ──
	// 低ズームの既定は面＝ベタ塗り（style 0 の色 × α0.8＝下のタイルの地形・注記がうっすら生きる）。
	// サブピクセルの線は破れて読めないが、stencil 塗りはピクセルカバレッジ加算なので
	// どんなに小さい筆も1px を確実に染める＝面が連続。
	// 明示 fillColor は全ズームでそれを尊重（透明を渡せば従来のアウトラインのみに戻せる）。
	const st = data.styleTable ?? DEF_STYLE;
	const fc = data.fillColor ?? (lowZoom && !s.fillOff ? [st[0], st[1], st[2], st[3] * 0.8] : DEF_FILL);   // fillOff＝巨大ポリゴンの自動塗り停止（uploadGintTextures 判定）
	// ステンシルはメタ先頭のポリゴン辺のみ＝折れ線辺を winding にファンさせない（海岸線等の誤塗り防止）。
	const stTex = hasB ? metaTexB : metaTex, stCount = hasB ? polyEdgesB : polyEdges;
	if (fc[3] > 0 && stCount > 0) {
		gl.enable(gl.STENCIL_TEST);
		gl.stencilMask(0xFF);
		gl.clear(gl.STENCIL_BUFFER_BIT);
		gl.colorMask(false, false, false, false);
		gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
		gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
		gl.stencilOpSeparate(gl.BACK,  gl.KEEP, gl.KEEP, gl.DECR_WRAP);
		gl.useProgram(stencilProgram);
		bindSharedUniforms(gl, uStencil, data, arcTex, stTex, TEX_ARC_W, TEX_META_W, width, height);
		// 塗りは全密度で巻く（LOD無効）：ロングジャンプ辺は輪郭を自己交差させ得る＝winding パリティ
		// 反転の斑点（ズームで移動する塗り抜け）が出る。簡略化しない輪郭は自己交差しない＝構造的に根治。
		// 増えるのは VS 呼び出しのみ（境界メタは辺数が桁で少なく、ラスタライズ面積は LOD 非依存）。
		gl.uniform1f(uStencil.u_lod_rank, 0);
		gl.drawArrays(gl.TRIANGLES, 0, stCount * 3);
		gl.colorMask(true, true, true, true);
		gl.stencilMask(0x00);
		gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
		gl.useProgram(fillProgram);
		if (STENCIL_DEBUG) {
			// winding カウント別に色分け（EQUAL で1値ずつ塗る＝プローブ）
			const probes = [
				[1,   [0.0, 0.8, 0.0, 0.9]],   // 緑    = +1 正常
				[2,   [1.0, 0.0, 0.0, 0.9]],   // 赤    = +2 重複
				[3,   [1.0, 0.0, 1.0, 0.9]],   // マゼンタ= +3
				[255, [0.0, 0.2, 1.0, 0.9]],   // 青    = -1 向き異常
				[254, [0.0, 0.9, 1.0, 0.9]],   // シアン = -2
			];
			for (const [ref, col] of probes) {
				gl.stencilFunc(gl.EQUAL, ref, 0xFF);
				gl.uniform4fv(uFill.u_fill_color, col);
				gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			}
		} else {
			gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF);
			gl.uniform4fv(uFill.u_fill_color, fc);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		}
		gl.disable(gl.STENCIL_TEST);
	}

	// ── Fat-line edges ──（低ズームは境界メタ＝アウトライン表示。折れ線は全量含まれるので消えない）
	// lowZoom は境界tier（rank ≥ tierB.minW が保証される帯）→ 無ければ境界メタ全量。
	// 高ズームは tier（全国視界）→ tier が届かない rank 帯は可視チャンク run（空間カリング）。
	// 純ポリライン（polyEdgesB=0）は境界メタ＝全辺100%に退化し、しかも outlineZoom が導出できず
	// tierB も焼かれない＝lowZoom 全帯で数百万辺フル描画（US roads 350万辺で凍結）。境界パスは
	// ポリゴンのアウトラインが目的なので、ポリゴン境界辺を持つデータに限定し、それ以外は
	// tier 梯子＋可視チャンク run の通常経路へ流す。
	const lnB = lowZoom && hasB && s.polyEdgesB > 0;
	const lnSel = lnB
		? (s.tierB && dynamicLodRank(data.scale) >= s.tierB.minW
			? { tex: s.tierB.tex, count: s.tierB.edgeCount, runs: null }
			: { tex: metaTexB, count: totalEdgesB, runs: null })
		: pickLineTier(data.scale, metaTex, totalEdges);
	if (lnSel.count > 0) {
		gl.useProgram(renderProgram);
		bindSharedUniforms(gl, uRender, data, arcTex, lnSel.tex, TEX_ARC_W, TEX_META_W, width, height);
		gl.uniform1f(uRender.u_line_width,   data.lineWidth ?? 1.0);
		gl.uniform1f(uRender.u_dpr,          s.dpr);
		gl.uniform1i(uRender.u_active_id,    -1);
		gl.uniform4fv(uRender.u_style_table, data.styleTable ?? DEF_STYLE);
		gl.uniform2fv(uRender.u_dash_table,  data.dashTable  ?? DEF_DASH);
		gl.uniform1i(uRender.u_pass, 0);
		for (const [st, cnt] of (lnSel.runs ?? [[0, lnSel.count]]))
			gl.drawArrays(gl.TRIANGLES, st * 6, cnt * 6);
	}

	// ── Points ──
	if (totalPoints > 0 && ptTex && ptMetaTex) {
		const r1 = data.rotate[1] * Math.PI / 180, r2 = (data.rotate[2] ?? 0) * Math.PI / 180;
		gl.useProgram(pointProgram);
		bindPointUniforms(uPoint, data, r1, r2);
		gl.uniform1i(uPoint.u_active_id, -1);
		gl.drawArrays(gl.TRIANGLES, 0, totalPoints * 6);
	}

	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

export function drawOverlay() {
	const { gl, programs, arcTex, metaTex, ptTex, ptMetaTex,
			totalEdges, totalPoints, TEX_ARC_W, TEX_META_W, width, height, dpr,
			baseFBO, lastDrawData, activeId, polyEdgeByFid } = s;
	if (!baseFBO || !lastDrawData) return;

	// Blit baseFBO → canvas to erase the previous overlay.
	const w = width * dpr, h = height * dpr;
	gl.bindFramebuffer(gl.READ_FRAMEBUFFER, baseFBO);
	gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
	gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.stencilMask(0xFF);
	gl.clear(gl.STENCIL_BUFFER_BIT);

	if (activeId === -1) return;
	if (!arcTex && !ptTex) return;

	const data = lastDrawData;
	const { renderProgram, stencilProgram, fillProgram,
			pointProgram, uRender, uStencil, uFill, uPoint, emptyVAO } = programs;
	gl.bindVertexArray(emptyVAO);

	const range    = polyEdgeByFid?.get(activeId);
	const eStart   = range?.[0] ?? null;
	const eCount   = range?.[1] ?? null;
	const hasRange = eStart != null && eCount > 0;

	// Edge highlight: wider + yellow.
	gl.useProgram(renderProgram);
	bindSharedUniforms(gl, uRender, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
	gl.uniform1f(uRender.u_line_width,   (data.lineWidth ?? 1.0) + 2.0);
	gl.uniform1f(uRender.u_dpr,          dpr);
	gl.uniform1i(uRender.u_active_id,    activeId);
	gl.uniform4fv(uRender.u_style_table, data.styleTable ?? DEF_STYLE);
	gl.uniform2fv(uRender.u_dash_table,  data.dashTable  ?? DEF_DASH);
	gl.uniform1i(uRender.u_pass, 1);
	if (hasRange) {
		gl.drawArrays(gl.TRIANGLES, eStart * 6, eCount * 6);
	} else if (totalEdges > 0) {
		gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 6);
	}

	// Point highlight: larger + yellow.
	if (totalPoints > 0 && ptTex && ptMetaTex) {
		const r1 = data.rotate[1] * Math.PI / 180, r2 = (data.rotate[2] ?? 0) * Math.PI / 180;
		gl.useProgram(pointProgram);
		bindPointUniforms(uPoint, data, r1, r2);
		gl.uniform1i(uPoint.u_active_id, activeId);
		gl.drawArrays(gl.TRIANGLES, 0, totalPoints * 6);
	}

	// Polygon mask: dim everything outside the active feature.
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

		// Draw wider than the visual line to increase pick sensitivity (~6 CSS px margin including DPR).
		const pickMargin = 12 * (s.dpr ?? 1);
		if (totalEdges > 0 && metaTex) {
			const pkSel = pickLineTier(data.scale, metaTex, totalEdges);
			gl.useProgram(pickLineProgram);
			bindSharedUniforms(gl, uPickLine, data, arcTex, pkSel.tex, TEX_ARC_W, TEX_META_W, width, height);
			gl.uniform1f(uPickLine.u_line_width, (data.lineWidth ?? 1.0) + pickMargin);
			for (const [st, cnt] of (pkSel.runs ?? [[0, pkSel.count]]))
				gl.drawArrays(gl.TRIANGLES, st * 6, cnt * 6);
		}

		if (totalPoints > 0 && ptTex && ptMetaTex) {
			const r1 = data.rotate[1] * Math.PI / 180, r2 = (data.rotate[2] ?? 0) * Math.PI / 180;
			gl.useProgram(pickPointProgram);
			bindPointUniforms(uPickPoint, data, r1, r2);
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
