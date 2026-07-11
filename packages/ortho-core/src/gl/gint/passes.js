// renderCleanScene:    ハイライト無しの全景（canvas か baseFBO へ）
// drawOverlay:         baseFBO を blit → アクティブ地物のハイライト＋mask
// renderPickingBuffer: feature ID を RGB24 で pick FBO へ
// v1(ortho-map) の gintRenderPasses を移植。site 2 の点bind を mvp/eye/origin へ。
// 単位は device px 一本（u_dpr=1、線幅/半径は worker が ×dpr 済み、blit は width 直）。

import { s, DEF_STYLE, DEF_DASH, DEF_FILL, DEF_MASK } from './state.js';
import { bindSharedUniforms } from './utility.js';

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
}

export function renderCleanScene(data, targetFBO = null) {
	const { gl, programs, arcTex, metaTex, ptTex, ptMetaTex,
			totalEdges, totalPoints, TEX_ARC_W, TEX_META_W, width, height } = s;
	const { renderProgram, stencilProgram, fillProgram,
			pointProgram, uRender, uStencil, uFill, uPoint, emptyVAO } = programs;

	gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
	gl.clearColor(0, 0, 0, 0);
	gl.stencilMask(0xFF);
	gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
	gl.bindVertexArray(emptyVAO);

	// ── Stencil + Fill（stencil-then-cover）──
	const fc = data.fillColor ?? DEF_FILL;
	if (fc[3] > 0 && totalEdges > 0) {
		gl.enable(gl.STENCIL_TEST);
		gl.stencilMask(0xFF);
		gl.clear(gl.STENCIL_BUFFER_BIT);
		gl.colorMask(false, false, false, false);
		gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
		gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
		gl.stencilOpSeparate(gl.BACK,  gl.KEEP, gl.KEEP, gl.DECR_WRAP);
		gl.useProgram(stencilProgram);
		bindSharedUniforms(gl, uStencil, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
		gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 3);
		gl.colorMask(true, true, true, true);
		gl.stencilMask(0x00);
		gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF);
		gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
		gl.useProgram(fillProgram);
		gl.uniform4fv(uFill.u_fill_color, fc);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.disable(gl.STENCIL_TEST);
	}

	// ── Fat-line edges ──
	if (totalEdges > 0) {
		gl.useProgram(renderProgram);
		bindSharedUniforms(gl, uRender, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
		gl.uniform1f(uRender.u_line_width,   data.lineWidth ?? 1.0);   // device px（worker 済み）
		gl.uniform1f(uRender.u_dpr,          1.0);                     // device px 一本化
		gl.uniform1i(uRender.u_active_id,    -1);
		gl.uniform4fv(uRender.u_style_table, data.styleTable ?? DEF_STYLE);
		gl.uniform2fv(uRender.u_dash_table,  data.dashTable  ?? DEF_DASH);
		gl.uniform1i(uRender.u_pass, 0);
		gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 6);
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
	const { gl, programs, arcTex, metaTex, ptTex, ptMetaTex,
			totalEdges, totalPoints, TEX_ARC_W, TEX_META_W, width, height,
			baseFBO, lastDrawData, activeId, polyEdgeByFid } = s;
	if (!baseFBO || !lastDrawData) return;

	// baseFBO → canvas を blit して前フレームの overlay を消す。
	gl.bindFramebuffer(gl.READ_FRAMEBUFFER, baseFBO);
	gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
	gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
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

	// Edge highlight：太く＋黄。
	gl.useProgram(renderProgram);
	bindSharedUniforms(gl, uRender, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
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
			gl.useProgram(pickLineProgram);
			bindSharedUniforms(gl, uPickLine, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
			gl.uniform1f(uPickLine.u_line_width, (data.lineWidth ?? 1.0) + pickMargin);
			gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 6);
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
