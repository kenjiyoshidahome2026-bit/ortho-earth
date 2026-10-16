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
// 後処理（bloom・vignette・PR-8・2026-10-12、fxaa・tonemap・lut＝第 3 波 W1）も同じ FBO に乗る＝setPost(p) があれば ②の写しが合成パスになる（深度の申し出が無くても renderworker が begin〜end を挟む）。
import { loadLUT } from "../lut.ts";
const TM_MODE = { linear: 0, reinhard: 1, aces: 2, agx: 3, filmic: 4 };
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

// 後処理（bloom・vignette・PR-8）：FBO の色を画面へ写す段に挟む。①明部の抜き出し（半解像度・閾値の軟らかい膝）②ぼかし横③ぼかし縦（9 点ガウス・半径倍率）④合成＝色＋bloom×strength、四隅の減光
const BRIGHT_FS = `#version 300 es
precision highp float;
uniform highp sampler2D u_tex;
uniform float u_th;
out vec4 o;
void main() {
	ivec2 p = ivec2(gl_FragCoord.xy) * 2;
	vec3 c = (texelFetch(u_tex, p, 0).rgb + texelFetch(u_tex, p + ivec2(1, 0), 0).rgb + texelFetch(u_tex, p + ivec2(0, 1), 0).rgb + texelFetch(u_tex, p + ivec2(1, 1), 0).rgb) * 0.25;
	float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
	float k = max(l - u_th, 0.0) / max(l, 1e-4);
	o = vec4(c * k, 1.0);
}`;
const BLUR_FS = `#version 300 es
precision highp float;
uniform highp sampler2D u_tex;
uniform vec2 u_dir;   // (1,0)·radius か (0,1)·radius（texel）
out vec4 o;
const float W[5] = float[5](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
void main() {
	vec2 ts = 1.0 / vec2(textureSize(u_tex, 0)), uv = gl_FragCoord.xy * ts;
	vec3 s = texture(u_tex, uv).rgb * W[0];
	for (int i = 1; i < 5; i++) { vec2 d = u_dir * float(i) * ts; s += texture(u_tex, uv + d).rgb * W[i]; s += texture(u_tex, uv - d).rgb * W[i]; }
	o = vec4(s, 1.0);
}`;
// 合成（第 3 波 W1 で fxaa・tonemap・lut を足す・2026-10-12）：掛ける順は固定＝fxaa → bloom → tonemap → lut → vignette（../postfx.js の頭書き）。式は WebGPU（gpu/postfx.js COMP）と同じ
const POST_FS = `#version 300 es
precision highp float;
uniform highp sampler2D u_tex;     // 本体の色（フル解像度・texelFetch・FXAA は LINEAR で読む）
uniform highp sampler2D u_bloom;   // ぼかした明部（半解像度・LINEAR）
uniform highp sampler2D u_lut;     // 3D LUT の帯（size²×size・LINEAR）
uniform vec2 u_size;
uniform float u_strength;   // bloom の量（0＝無し）
uniform vec4 u_vig;         // (strength, radius, softness, on)
uniform vec4 u_tm;          // (mode 0..4, exposure, on, fxaaOn)
uniform vec4 u_lutP;        // (size, intensity, on, 0)
out vec4 o;
vec3 tmReinhard(vec3 x) { return x / (1.0 + x); }
vec3 tmAces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 tmFilmic(vec3 x) {   // Hable（Uncharted 2）・白点 11.2
	const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30, W = 11.2;
	vec3 c = ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
	float w = ((W * (A * W + C * B) + D * E) / (W * (A * W + B) + D * F)) - E / F;
	return clamp(c / w, 0.0, 1.0);
}
vec3 tmAgx(vec3 c) {   // AgX（Troy Sobotka・Blender 4 の既定）の最小版＝入出力の行列と 6 次の S 字
	const mat3 IN = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
	const mat3 OUT = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
	c = IN * c;
	c = clamp((log2(max(c, vec3(1e-10))) + 12.47393) / 16.5, 0.0, 1.0);
	vec3 x2 = c * c, x4 = x2 * x2;
	c = 15.5 * x4 * x2 - 40.14 * x4 * c + 31.96 * x4 - 6.868 * x2 * c + 0.4298 * x2 + 0.1191 * c - 0.00232;
	return clamp(OUT * c, 0.0, 1.0);
}
vec3 tonemap(vec3 c) {
	c *= u_tm.y;
	int m = int(u_tm.x + 0.5);
	if (m == 1) return tmReinhard(c);
	if (m == 2) return tmAces(c);
	if (m == 3) return tmAgx(c);
	if (m == 4) return tmFilmic(c);
	return clamp(c, 0.0, 1.0);
}
vec3 fxaa(vec2 fc, vec2 inv) {   // FXAA 3.11 の簡約版（5 点の輝度から縁の向きを取り、沿って 2〜4 点を混ぜる）
	const float SPAN = 8.0, RMIN = 1.0 / 128.0, RMUL = 1.0 / 8.0;
	const vec3 L = vec3(0.299, 0.587, 0.114);
	vec3 rgbM = texture(u_tex, fc * inv).rgb;
	float lNW = dot(texture(u_tex, (fc + vec2(-1.0, -1.0)) * inv).rgb, L), lNE = dot(texture(u_tex, (fc + vec2(1.0, -1.0)) * inv).rgb, L);
	float lSW = dot(texture(u_tex, (fc + vec2(-1.0, 1.0)) * inv).rgb, L), lSE = dot(texture(u_tex, (fc + vec2(1.0, 1.0)) * inv).rgb, L), lM = dot(rgbM, L);
	float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
	vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
	float red = max((lNW + lNE + lSW + lSE) * (0.25 * RMUL), RMIN), rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
	dir = min(vec2(SPAN), max(vec2(-SPAN), dir * rcp)) * inv;
	vec2 uv = fc * inv;
	vec3 a = 0.5 * (texture(u_tex, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(u_tex, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
	vec3 b = a * 0.5 + 0.25 * (texture(u_tex, uv - dir * 0.5).rgb + texture(u_tex, uv + dir * 0.5).rgb);
	float lB = dot(b, L);
	return (lB < lMin || lB > lMax) ? a : b;
}
vec3 lut3(vec3 c) {   // 帯＝x に B の板×size＋R・y に G。R・G は線形補間・B は隣の板との補間
	float n = u_lutP.x; c = clamp(c, 0.0, 1.0);
	float bb = c.b * (n - 1.0), b0 = floor(bb), b1 = min(b0 + 1.0, n - 1.0), f = bb - b0;
	float x = (c.r * (n - 1.0) + 0.5) / (n * n), y = (c.g * (n - 1.0) + 0.5) / n;
	return mix(texture(u_lut, vec2(b0 / n + x, y)).rgb, texture(u_lut, vec2(b1 / n + x, y)).rgb, f);
}
void main() {
	vec2 uv = gl_FragCoord.xy / u_size;
	vec4 c = texelFetch(u_tex, ivec2(gl_FragCoord.xy), 0);
	if (u_tm.w > 0.5) c.rgb = fxaa(gl_FragCoord.xy, 1.0 / u_size);
	if (u_strength > 0.0) c.rgb += texture(u_bloom, uv).rgb * u_strength;
	if (u_tm.z > 0.5) c.rgb = tonemap(c.rgb);
	if (u_lutP.z > 0.5) c.rgb = mix(c.rgb, lut3(c.rgb), u_lutP.y);
	if (u_vig.w > 0.5) { float d = length(uv - 0.5) * 1.41421356; c.rgb *= 1.0 - u_vig.x * smoothstep(u_vig.y - u_vig.z, u_vig.y, d); }
	o = c;
}`;

function prog(gl, fs) {
	const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("depthout shader: " + gl.getShaderInfoLog(s)); return s; };
	const p = gl.createProgram(), v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, fs);
	gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("depthout link: " + gl.getProgramInfoLog(p));
	gl.deleteShader(v); gl.deleteShader(f);
	return p;
}
function tex2d(gl, ifmt, w, h, fmt, type, linear = false) {
	const t = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, t);
	gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
	const f = linear ? gl.LINEAR : gl.NEAREST;
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return t;
}

export function createDepthOutGL(gl, canvas, requestDraw) {
	const samples = gl.getContextAttributes()?.antialias ? Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0) : 0;
	const copyProg = prog(gl, COPY_FS), encProg = prog(gl, ENC_FS);
	const copyTexLoc = gl.getUniformLocation(copyProg, "u_tex"), encDepthLoc = gl.getUniformLocation(encProg, "u_depth");
	const vao = gl.createVertexArray();
	const realBind = gl.bindFramebuffer;
	let T = null, active = false;   // T＝寸法ごとの資産一式
	let post = null, P = null;      // 後処理の設定（postfx.js normPost の形）と、その program・半解像度の的（頼まれた時だけ作る）
	const u = (pr, n) => gl.getUniformLocation(pr, n);
	function ensureP(W, H) {
		if (!P) {
			const bright = prog(gl, BRIGHT_FS), blur = prog(gl, BLUR_FS), comp = prog(gl, POST_FS);
			P = { bright, blur, comp, bTex: u(bright, "u_tex"), bTh: u(bright, "u_th"), lTex: u(blur, "u_tex"), lDir: u(blur, "u_dir"), cTex: u(comp, "u_tex"), cBloom: u(comp, "u_bloom"), cSize: u(comp, "u_size"), cStr: u(comp, "u_strength"), cVig: u(comp, "u_vig"), cTm: u(comp, "u_tm"), cLut: u(comp, "u_lut"), cLutP: u(comp, "u_lutP"), w: 0, h: 0, tex: [], fb: [] };
		}
		const hw = Math.max(1, Math.ceil(W / 2)), hh = Math.max(1, Math.ceil(H / 2));
		if (P.w === hw && P.h === hh) return;
		for (const f of P.fb) gl.deleteFramebuffer(f); for (const t of P.tex) gl.deleteTexture(t);
		P.tex = []; P.fb = [];
		const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
		for (let i = 0; i < 3; i++) {   // 0＝明部・1＝ぼかし横・2＝ぼかし縦（合成が読む）
			const t = tex2d(gl, gl.RGBA8, hw, hh, gl.RGBA, gl.UNSIGNED_BYTE, true), f = gl.createFramebuffer();
			realBind.call(gl, gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
			P.tex.push(t); P.fb.push(f);
		}
		realBind.call(gl, gl.FRAMEBUFFER, null); gl.bindTexture(gl.TEXTURE_2D, prevTex);
		P.w = hw; P.h = hh;
	}
	function freeP() { if (!P) return; for (const f of P.fb) gl.deleteFramebuffer(f); for (const t of P.tex) gl.deleteTexture(t); gl.deleteProgram(P.bright); gl.deleteProgram(P.blur); gl.deleteProgram(P.comp); P = null; }
	// 後処理の設定（null＝素の写し）。資産は次の end で作る・外したら返す
	function setPost(p) { post = p || null; if (!post) freeP(); syncLut(); }
	// 3D LUT（W1）：url が変わったら読み直す（worker 内の fetch・../lut.js）。着くまでは LUT 無しで描き、着いたら一枚要求する。外したら返す
	let L = null;   // { url, size, tex, n（板の一辺）, ready }
	function freeLut() { if (!L) return; if (L.tex) gl.deleteTexture(L.tex); L = null; }
	function syncLut() {
		const l = post?.lut;
		if (!l) { freeLut(); return; }
		if (L && L.url === l.url && L.size === l.size) return;
		freeLut();
		const me = L = { url: l.url, size: l.size, tex: null, n: 0, ready: false };
		loadLUT(l.url, l.size).then(r => {
			if (L !== me) return;
			const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
			me.tex = tex2d(gl, gl.RGBA8, r.size * r.size, r.size, gl.RGBA, gl.UNSIGNED_BYTE, true);
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, r.size * r.size, r.size, gl.RGBA, gl.UNSIGNED_BYTE, r.data);
			gl.bindTexture(gl.TEXTURE_2D, prevTex);
			me.n = r.size; me.ready = true; requestDraw?.();
		}).catch(e => { if (L === me) { me.ready = false; me.failed = true; } console.warn("[post] lut load failed:", e?.message || e); });
	}
	// FBO の色（T.colorTex）→ 画面。bloom が要れば半解像度の 3 パスを挟む。呼ぶ側が program・VAO・texture の束縛を控えて戻す
	function runPost(W, H) {
		const b = post.bloom, v = post.vignette, t = post.tonemap, lutOn = !!(post.lut && L && L.ready && L.url === post.lut.url);
		ensureP(W, H);
		gl.activeTexture(gl.TEXTURE1); const prevTex1 = gl.getParameter(gl.TEXTURE_BINDING_2D);
		gl.activeTexture(gl.TEXTURE2); const prevTex2 = gl.getParameter(gl.TEXTURE_BINDING_2D); gl.activeTexture(gl.TEXTURE0);
		try {
			if (b) {
				gl.viewport(0, 0, P.w, P.h);
				realBind.call(gl, gl.FRAMEBUFFER, P.fb[0]); gl.useProgram(P.bright); gl.uniform1i(P.bTex, 0); gl.uniform1f(P.bTh, b.threshold); gl.bindTexture(gl.TEXTURE_2D, T.colorTex); gl.drawArrays(gl.TRIANGLES, 0, 3);
				gl.useProgram(P.blur); gl.uniform1i(P.lTex, 0);
				realBind.call(gl, gl.FRAMEBUFFER, P.fb[1]); gl.uniform2f(P.lDir, b.radius, 0); gl.bindTexture(gl.TEXTURE_2D, P.tex[0]); gl.drawArrays(gl.TRIANGLES, 0, 3);
				realBind.call(gl, gl.FRAMEBUFFER, P.fb[2]); gl.uniform2f(P.lDir, 0, b.radius); gl.bindTexture(gl.TEXTURE_2D, P.tex[1]); gl.drawArrays(gl.TRIANGLES, 0, 3);
				gl.viewport(0, 0, W, H);
			}
			realBind.call(gl, gl.FRAMEBUFFER, null);
			gl.useProgram(P.comp);
			gl.uniform1i(P.cTex, 0); gl.uniform1i(P.cBloom, 1); gl.uniform2f(P.cSize, W, H);
			gl.uniform1f(P.cStr, b ? b.strength : 0);
			gl.uniform4f(P.cVig, v ? v.strength : 0, v ? v.radius : 1, v ? v.softness : 0.5, v ? 1 : 0);
			gl.uniform4f(P.cTm, t ? TM_MODE[t.mode] ?? 2 : 0, t ? t.exposure : 1, t ? 1 : 0, post.fxaa ? 1 : 0);
			gl.uniform1i(P.cLut, 2); gl.uniform4f(P.cLutP, lutOn ? L.n : 1, lutOn ? post.lut.intensity : 0, lutOn ? 1 : 0, 0);
			gl.bindTexture(gl.TEXTURE_2D, T.colorTex);
			gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b ? P.tex[2] : T.colorTex);
			gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, lutOn ? L.tex : T.colorTex); gl.activeTexture(gl.TEXTURE0);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		} finally { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, prevTex1); gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, prevTex2); gl.activeTexture(gl.TEXTURE0); }
	}

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
		t.colorTex = tex2d(gl, gl.RGBA8, W, H, gl.RGBA, gl.UNSIGNED_BYTE, true);   // LINEAR＝FXAA（W1）が texture() で読む。texelFetch の経路には効かない
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
	// opts.depth＝false なら深度の詰めと読みは飛ばす（後処理だけの時＝pixels は null）
	function end(opts) {
		if (!active) return null;
		active = false;
		delete gl.bindFramebuffer;   // 自前のプロパティを外す＝プロトタイプの素の口へ戻る
		try { return endBody(opts?.depth !== false); }
		finally { realBind.call(gl, gl.FRAMEBUFFER, null); }   // 途中で投げても画面の束縛は素へ（状態の戻しは endBody の finally）
	}
	function endBody(wantDepth) {
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
		// ②色を画面へ（MSAA の既定フレームバッファへは blit できない＝全画面の三角形で写す）。後処理（PR-8）があればここで bloom・vignette を掛ける
		if (post) runPost(W, H);
		else {
			realBind.call(gl, gl.FRAMEBUFFER, null);
			gl.useProgram(copyProg);
			gl.uniform1i(copyTexLoc, 0);
			gl.bindTexture(gl.TEXTURE_2D, T.colorTex);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		}
		if (!wantDepth) return { pixels: null, w: W, h: H };
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
	function dispose() { abort(); freeT(); freeP(); freeLut(); gl.deleteProgram(copyProg); gl.deleteProgram(encProg); gl.deleteVertexArray(vao); }
	const bytes = () => (T ? T.w * T.h * (4 + 4 + 4 + 4 + (samples > 0 ? samples * 8 : 0)) : 0) + (P ? P.w * P.h * 4 * 3 : 0) + (L?.ready ? L.n * L.n * L.n * 4 : 0);   // 色tex＋深度tex＋詰めRB＋CPU 画素＋MSAA（＋後処理の半解像度 3 面）
	return { begin, end, abort, dispose, bytes, samples, setPost };
}
