// baseFBO: clean-scene キャッシュ（hover 時に blit で overlay を消す）
// pickFBO: GPU picking の ID バッファ
// v1(ortho-map) の gintFBO を移植。node-free。唯一の適応＝v2 は width/height を device px で持つ（*dpr 不要）。

import { s } from './state.js';

function makeFBO(gl, w, h) {
	const colorTex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, colorTex);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

	const dsRBO = gl.createRenderbuffer();
	gl.bindRenderbuffer(gl.RENDERBUFFER, dsRBO);
	gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);

	const fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
	gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, dsRBO);

	return { fbo, colorTex, dsRBO };
}

export function createFBOs() {
	const { gl } = s;
	const w = s.width, h = s.height;   // v2：既に device px

	deleteFBOs();

	const base = makeFBO(gl, w, h);
	s.baseFBO = base.fbo; s.baseColorTex = base.colorTex; s.baseDepthStencilRBO = base.dsRBO;

	const pick = makeFBO(gl, w, h);
	s.pickFBO = pick.fbo; s.pickColorTex = pick.colorTex; s.pickDepthStencilRBO = pick.dsRBO;

	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	s.lastDrawData = null;
}

export function deleteFBOs() {
	const { gl } = s;
	if (!gl) return;
	if (s.baseFBO)             gl.deleteFramebuffer(s.baseFBO);
	if (s.baseColorTex)        gl.deleteTexture(s.baseColorTex);
	if (s.baseDepthStencilRBO) gl.deleteRenderbuffer(s.baseDepthStencilRBO);
	if (s.pickFBO)             gl.deleteFramebuffer(s.pickFBO);
	if (s.pickColorTex)        gl.deleteTexture(s.pickColorTex);
	if (s.pickDepthStencilRBO) gl.deleteRenderbuffer(s.pickDepthStencilRBO);
	s.baseFBO = s.baseColorTex = s.baseDepthStencilRBO = null;
	s.pickFBO = s.pickColorTex = s.pickDepthStencilRBO = null;
}
