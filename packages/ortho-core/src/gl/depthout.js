// GL2 の深度の書き出し（#47・2026-09-25）：本体の深度は既定フレームバッファの暗黙の深度＝読めない。
// そこで**深度を申し出たオーバーレイがある時だけ**、本体（renderer.draw＋gint.draw）を自前の FBO（色＋深度ステンシル・
// context の antialias に合わせて MSAA）へ描かせ、終わりに ①解決（blit）②色を既定フレームバッファへ全画面で写す
// ③深度を RGBA8 に詰めて readPixels、の順で 1 フレームを閉じる。申し出が無い間は何も作らず何も変えない（従来の経路そのまま）。
//
// 描き先の切替は gl.bindFramebuffer の「null（＝画面）」を begin〜end の間だけ自前の FBO へ読み替えて行う
// （renderer・gint・地面アトラスの各所は「画面へ戻る」を bindFramebuffer(null) で書いている＝その全部が自動で FBO へ戻る）。
// 読み替えは begin〜end の間だけ＝snapshot・pick などフレームの外の経路は素の既定フレームバッファを見る。
// 既定フレームバッファが MSAA の時は blitFramebuffer で書き込めない（描き先が多重サンプル＝INVALID_OPERATION）＝色は全画面の三角形で写す。
// 詰め方と行の向きは ../depthout.js（24bit・R が上位・下の行から）。
const VS = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const COPY_FS = `#version 300 es
precision highp float;
uniform highp sampler2D u_tex;
out vec4 o;
void main() { o = texelFetch(u_tex, ivec2(gl_FragCoord.xy), 0); }`;
const ENC_FS = `#version 300 es
precision highp float;
uniform highp sampler2D u_depth;
out vec4 o;
void main() {
	// min＝d=1（クリア値）の 16777215.5 は float32 で 16777216 に丸まる＝(255,0,0)＝0.996 に化けて「何かある」になる（検定で踏んだ）
	highp float v = min(floor(texelFetch(u_depth, ivec2(gl_FragCoord.xy), 0).r * 16777215.0 + 0.5), 16777215.0);
	highp float r = floor(v / 65536.0), g = floor((v - r * 65536.0) / 256.0), b = v - r * 65536.0 - g * 256.0;
	o = vec4(r, g, b, 255.0) / 255.0;
}`;

function prog(gl, fs) {
	const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("depthout shader: " + gl.getShaderInfoLog(s)); return s; };
	const p = gl.createProgram(), v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, fs);
	gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("depthout link: " + gl.getProgramInfoLog(p));
	gl.deleteShader(v); gl.deleteShader(f);
	return p;
}
function tex2d(gl, ifmt, w, h, fmt, type) {
	const t = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, t);
	gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return t;
}

export function createDepthOutGL(gl, canvas) {
	const samples = gl.getContextAttributes()?.antialias ? Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0) : 0;
	const copyProg = prog(gl, COPY_FS), encProg = prog(gl, ENC_FS);
	const copyTexLoc = gl.getUniformLocation(copyProg, "u_tex"), encDepthLoc = gl.getUniformLocation(encProg, "u_depth");
	const vao = gl.createVertexArray();
	const realBind = gl.bindFramebuffer;
	let T = null, active = false;   // T＝寸法ごとの資産一式

	function freeT() {
		if (!T) return;
		for (const f of [T.scene, T.res, T.enc]) if (f) gl.deleteFramebuffer(f);
		for (const r of [T.colorRb, T.dsRb, T.encRb]) if (r) gl.deleteRenderbuffer(r);
		gl.deleteTexture(T.colorTex); gl.deleteTexture(T.depthTex);
		T = null;
	}
	function ensure(W, H) {
		if (T && T.w === W && T.h === H) return;
		freeT();
		const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D), prevRb = gl.getParameter(gl.RENDERBUFFER_BINDING);
		const t = { w: W, h: H, pixels: new Uint8Array(W * H * 4) };
		t.colorTex = tex2d(gl, gl.RGBA8, W, H, gl.RGBA, gl.UNSIGNED_BYTE);
		t.depthTex = tex2d(gl, gl.DEPTH24_STENCIL8, W, H, gl.DEPTH_STENCIL, gl.UNSIGNED_INT_24_8);
		t.res = gl.createFramebuffer();
		realBind.call(gl, gl.FRAMEBUFFER, t.res);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.colorTex, 0);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.TEXTURE_2D, t.depthTex, 0);
		const okRes = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;   // 深度ステンシルのテクスチャ添付を拒む GPU＝黙って「隠れ無し」にしない
		if (samples > 0) {   // MSAA＝描くのは多重サンプルの renderbuffer・終わりに res（テクスチャ）へ解決
			t.scene = gl.createFramebuffer();
			realBind.call(gl, gl.FRAMEBUFFER, t.scene);
			t.colorRb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, t.colorRb);
			gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, W, H);
			gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, t.colorRb);
			t.dsRb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, t.dsRb);
			gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, W, H);
			gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, t.dsRb);
		} else t.scene = t.res;   // 1x（LOW_MEM でない ?msaa=0）＝テクスチャへ直に描く
		t.enc = gl.createFramebuffer();
		realBind.call(gl, gl.FRAMEBUFFER, t.enc);
		t.encRb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, t.encRb);
		gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, t.encRb);
		const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
		realBind.call(gl, gl.FRAMEBUFFER, null);
		gl.bindTexture(gl.TEXTURE_2D, prevTex); gl.bindRenderbuffer(gl.RENDERBUFFER, prevRb);
		T = t;
		if (!ok || !okRes) { freeT(); throw new Error("depthout: framebuffer incomplete"); }
		// 1x 直描き時の scene（＝res）も完全か確かめる
		realBind.call(gl, gl.FRAMEBUFFER, t.scene);
		const ok2 = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
		realBind.call(gl, gl.FRAMEBUFFER, null);
		if (!ok2) { freeT(); throw new Error("depthout: scene framebuffer incomplete"); }
	}

	// フレームの頭（renderer.draw の前）：画面＝null を自前の FBO へ読み替える
	function begin() {
		const W = canvas.width, H = canvas.height;
		if (!W || !H) return false;
		ensure(W, H);
		const scene = T.scene;
		gl.bindFramebuffer = function (target, fb) { return realBind.call(this, target, fb === null ? scene : fb); };
		realBind.call(gl, gl.FRAMEBUFFER, scene);
		active = true;
		return true;
	}
	// フレームの終わり（gint.draw の後）：解決→画面へ写す→深度を詰めて読む。戻り＝{ pixels, w, h }（下の行から）
	function end() {
		if (!active) return null;
		active = false;
		delete gl.bindFramebuffer;   // 自前のプロパティを外す＝プロトタイプの素の口へ戻る
		try { return endBody(); }
		finally { realBind.call(gl, gl.FRAMEBUFFER, null); }   // 途中で投げても画面の束縛は素へ（状態の戻しは endBody の finally）
	}
	function endBody() {
		const { w: W, h: H } = T;
		// 触る状態を控えて戻す（次のフレームの renderer/gint は既定を前提にしない書き方だが、念のため全部戻す）
		const en = [gl.BLEND, gl.DEPTH_TEST, gl.STENCIL_TEST, gl.SCISSOR_TEST, gl.CULL_FACE].map(c => [c, gl.isEnabled(c)]);
		const prevProg = gl.getParameter(gl.CURRENT_PROGRAM), prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
		const prevAct = gl.getParameter(gl.ACTIVE_TEXTURE), prevMask = gl.getParameter(gl.COLOR_WRITEMASK);
		const prevPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING), prevVp = gl.getParameter(gl.VIEWPORT);
		gl.activeTexture(gl.TEXTURE0);
		const prevTex0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
		try {
		if (T.scene !== T.res) {
			realBind.call(gl, gl.READ_FRAMEBUFFER, T.scene); realBind.call(gl, gl.DRAW_FRAMEBUFFER, T.res);
			gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT, gl.NEAREST);
		}
		for (const [c] of en) gl.disable(c);
		gl.colorMask(true, true, true, true);
		gl.viewport(0, 0, W, H);
		gl.bindVertexArray(vao);
		// ②色を画面へ（MSAA の既定フレームバッファへは blit できない＝全画面の三角形で写す）
		realBind.call(gl, gl.FRAMEBUFFER, null);
		gl.useProgram(copyProg);
		gl.uniform1i(copyTexLoc, 0);
		gl.bindTexture(gl.TEXTURE_2D, T.colorTex);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		// ③深度を RGBA8 へ詰めて読む（同期の readPixels＝申し出がある時だけの費用）
		realBind.call(gl, gl.FRAMEBUFFER, T.enc);
		gl.useProgram(encProg);
		gl.uniform1i(encDepthLoc, 0);
		gl.bindTexture(gl.TEXTURE_2D, T.depthTex);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
		gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, T.pixels);
		return { pixels: T.pixels, w: W, h: H };
		} finally {   // 途中で投げても（コンテキスト喪失など）GL の状態は素へ
			realBind.call(gl, gl.FRAMEBUFFER, null);
			gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prevPack);
			gl.bindTexture(gl.TEXTURE_2D, prevTex0);
			gl.activeTexture(prevAct);
			gl.useProgram(prevProg); gl.bindVertexArray(prevVao);
			gl.colorMask(prevMask[0], prevMask[1], prevMask[2], prevMask[3]);
			gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
			for (const [c, on] of en) if (on) gl.enable(c);
		}
	}
	// 途中で例外が出たフレーム＝読み替えだけ外して画面を素に戻す（その 1 枚は捨てる）
	function abort() { if (!active) return; active = false; delete gl.bindFramebuffer; realBind.call(gl, gl.FRAMEBUFFER, null); }
	function dispose() { abort(); freeT(); gl.deleteProgram(copyProg); gl.deleteProgram(encProg); gl.deleteVertexArray(vao); }
	const bytes = () => T ? T.w * T.h * (4 + 4 + 4 + 4 + (samples > 0 ? samples * 8 : 0)) : 0;   // 色tex＋深度tex＋詰めRB＋CPU 画素＋MSAA
	return { begin, end, abort, dispose, bytes, samples };
}
