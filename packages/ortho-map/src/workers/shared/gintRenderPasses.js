// renderCleanScene:    full scene without highlights (canvas or baseFBO)
// drawOverlay:         blit baseFBO → apply active-feature highlight + mask
// renderPickingBuffer: encode feature IDs as RGB24 into the pick FBO

import { s, DEF_STYLE, DEF_DASH, DEF_FILL, DEF_MASK } from './gintState.js';
import { bindSharedUniforms } from './gintUtility.js';

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

// 線パスを境界メタ（アウトラインのみ）へ切り替えるズーム閾値。
// これ未満では筆内部の線は視認不能（ベタ潰れ）なので描かない＝低ズームの主コストを桁で削減。
const OUTLINE_ZOOM = 12;

export function renderCleanScene(data, targetFBO = null) {
	const { gl, programs, arcTex, metaTex, metaTexB, ptTex, ptMetaTex,
			totalEdges, totalEdgesB, totalPoints, TEX_ARC_W, TEX_META_W, width, height } = s;
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

	// ── Stencil + Fill ──
	const fc = data.fillColor ?? DEF_FILL;
	const stTex = hasB ? metaTexB : metaTex, stCount = hasB ? totalEdgesB : totalEdges;
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
		gl.drawArrays(gl.TRIANGLES, 0, stCount * 3);
		gl.colorMask(true, true, true, true);
		gl.stencilMask(0x00);
		gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF);
		gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
		gl.useProgram(fillProgram);
		gl.uniform4fv(uFill.u_fill_color, fc);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.disable(gl.STENCIL_TEST);
	}

	// ── Fat-line edges ──（低ズームは境界メタ＝アウトライン表示）
	const lnB = hasB && zoom < OUTLINE_ZOOM;
	const lnTex = lnB ? metaTexB : metaTex, lnCount = lnB ? totalEdgesB : totalEdges;
	if (lnCount > 0) {
		gl.useProgram(renderProgram);
		bindSharedUniforms(gl, uRender, data, arcTex, lnTex, TEX_ARC_W, TEX_META_W, width, height);
		gl.uniform1f(uRender.u_line_width,   data.lineWidth ?? 1.0);
		gl.uniform1f(uRender.u_dpr,          s.dpr);
		gl.uniform1i(uRender.u_active_id,    -1);
		gl.uniform4fv(uRender.u_style_table, data.styleTable ?? DEF_STYLE);
		gl.uniform2fv(uRender.u_dash_table,  data.dashTable  ?? DEF_DASH);
		gl.uniform1i(uRender.u_pass, 0);
		gl.drawArrays(gl.TRIANGLES, 0, lnCount * 6);
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
			gl.useProgram(pickLineProgram);
			bindSharedUniforms(gl, uPickLine, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
			gl.uniform1f(uPickLine.u_line_width, (data.lineWidth ?? 1.0) + pickMargin);
			gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 6);
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
