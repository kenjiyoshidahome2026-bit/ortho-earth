// 画面の段（GL2・2026-10-28）＝Cesium の postProcessStages 相当。固定の後処理の鎖（depthout.js runPost＝fxaa→bloom→tonemap→lut→vignette）の後に、
// 並び順どおり 1 段ずつ全画面で掛ける（2 枚のフル解像度の的を行き来し、最後の段だけ画面へ）。段の形は ../postfx.js PostStage。
//   silhouette＝深度の縁取り（Cesium の EdgeDetection＋Silhouette と同式：Sobel 3×3 の重み 3/10/3・閾値 length・縁の色 color）
//   grey＝白黒（gradations 段）／brightness＝明るさ（mix(黒, 色, value)）／nightVision＝暗視（緑＋画面座標の雑音）
//   glsl＝利用者の GLSL ES 3.00 の fragment（Cesium の PostProcessStage の書き方）＝colorTexture・depthTexture・v_textureCoordinates・out_FragColor と czm_* の一部（下の PRELUDE）。
//     uniforms は宣言の型（float/int/bool/vec2〜4）を本文から読んで流す。壊れた物は 1 度だけ警告して飛ばす（他の段は描く）
// 深度＝Cesium の深度の尺（log2(w−near+1)／log2(far−near+1)・w＝目からの奥行き m・near 1・far 5e8＝Cesium の frustum の既定）に写した深度テクスチャを、段が要る時だけ 1 フレームに 1 度作る
// （本体の深度＝対数 0.5·logCoef·log2(1+w)（単位球）を級数で戻す）。深度だけの FBO に gl_FragDepth で書く＝拡張要らず・24bit。
import type { PostStage } from "../postfx.ts";

const R_M = 6378137, CZM_NEAR = 1, CZM_FAR = 5e8;
const VS = `#version 300 es
out vec2 v_textureCoordinates;
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); v_textureCoordinates = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
// 深度の写し（本体の対数深度 → Cesium の尺）。u_p＝(2·ln2／logCoef, 1／log2(far−near+1), near, 0)
const DEPTH_FS = `#version 300 es
precision highp float;
uniform highp sampler2D u_depth;
uniform vec4 u_p;
float expm1s(float x) { if (x < 0.1) return x * (1.0 + x * (0.5 + x * (0.16666667 + x * (0.041666668 + x * (0.0083333335 + x * (0.0013888889 + x * 0.00019841270)))))); return exp(x) - 1.0; }
void main() {
	float d = texelFetch(u_depth, ivec2(gl_FragCoord.xy), 0).r;
	if (d >= 1.0) { gl_FragDepth = 1.0; return; }
	float w = expm1s(d * u_p.x) * ${R_M.toFixed(1)};   // 目からの奥行き（m）
	gl_FragDepth = clamp(log2(max(w - u_p.z, 0.0) + 1.0) * u_p.y, 0.0, 1.0);
}`;
// Cesium の書き方の fragment の前置き。利用者の本文が colorTexture／depthTexture／v_textureCoordinates を自分で宣言する（Cesium の流儀）＝ここでは宣言しない。
// ortho_eyeP＝(tan(fovx/2), tan(fovy/2), log2(far−near+1), near)＝czm_windowToEyeCoordinates が深度を目の座標へ戻す尺
const PRELUDE = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform vec4 czm_viewport;
uniform float czm_pixelRatio;
uniform float czm_frameNumber;
uniform vec4 ortho_eyeP;
const float czm_pi = 3.141592653589793;
const float czm_twoPi = 6.283185307179586;
const float czm_piOverTwo = 1.5707963267948966;
const float czm_infinity = 5906376272000.0;
const float czm_epsilon7 = 0.0000001;
float czm_luminance(vec3 rgb) { return dot(rgb, vec3(0.2125, 0.7154, 0.0721)); }
float czm_unpackDepth(vec4 p) { return p.x; }
float czm_readDepth(sampler2D t, vec2 uv) { return texture(t, uv).x; }
vec4 czm_windowToEyeCoordinates(vec2 fragCoord, float depth) { float w = exp2(depth * ortho_eyeP.z) - 1.0 + ortho_eyeP.w; vec2 ndc = fragCoord / czm_viewport.zw * 2.0 - 1.0; return vec4(ndc.x * ortho_eyeP.x * w, ndc.y * ortho_eyeP.y * w, -w, 1.0); }
bool czm_selected() { return false; }
bool czm_selected(vec2 o) { return false; }
vec3 czm_RGBToHSB(vec3 rgb) { const vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0); vec4 p = mix(vec4(rgb.bg, K.wz), vec4(rgb.gb, K.xy), step(rgb.b, rgb.g)); vec4 q = mix(vec4(p.xyw, rgb.r), vec4(rgb.r, p.yzx), step(p.x, rgb.r)); float d = q.x - min(q.w, q.y); return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + czm_epsilon7)), d / (q.x + czm_epsilon7), q.x); }
vec3 czm_HSBToRGB(vec3 hsb) { const vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0); vec3 p = abs(fract(hsb.xxx + K.xyz) * 6.0 - K.www); return hsb.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), hsb.y); }
vec3 czm_saturation(vec3 rgb, float adjustment) { const vec3 W = vec3(0.2125, 0.7154, 0.0721); vec3 intensity = vec3(dot(rgb, W)); return mix(intensity, rgb, adjustment); }
`;
const SIL_FS = PRELUDE + `uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform float u_length;
uniform vec4 u_color;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
void main() {
	float dirs[3]; dirs[0] = -1.0; dirs[1] = 0.0; dirs[2] = 1.0;
	float sc[3]; sc[0] = 3.0; sc[1] = 10.0; sc[2] = 3.0;
	float padx = czm_pixelRatio / czm_viewport.z, pady = czm_pixelRatio / czm_viewport.w;
	float h = 0.0, v = 0.0;
	for (int i = 0; i < 3; ++i) {
		float dir = dirs[i], s = sc[i];
		h -= texture(depthTexture, v_textureCoordinates + vec2(-padx, dir * pady)).x * s;
		h += texture(depthTexture, v_textureCoordinates + vec2(padx, dir * pady)).x * s;
		v -= texture(depthTexture, v_textureCoordinates + vec2(dir * padx, -pady)).x * s;
		v += texture(depthTexture, v_textureCoordinates + vec2(dir * padx, pady)).x * s;
	}
	float len = sqrt(h * h + v * v);
	vec4 edge = vec4(u_color.rgb, len > u_length ? u_color.a : 0.0);
	vec4 c = texture(colorTexture, v_textureCoordinates);
	out_FragColor = mix(c, edge, edge.a);
}`;
const GREY_FS = PRELUDE + `uniform sampler2D colorTexture;
uniform float u_gradations;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
void main() {
	vec3 rgb = texture(colorTexture, v_textureCoordinates).rgb;
	float darkness = czm_luminance(rgb) * u_gradations;
	darkness = (darkness - fract(darkness)) / u_gradations;
	out_FragColor = vec4(vec3(darkness), 1.0);
}`;
const BRIGHT_FS = PRELUDE + `uniform sampler2D colorTexture;
uniform float u_value;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
void main() { vec3 rgb = texture(colorTexture, v_textureCoordinates).rgb; out_FragColor = vec4(mix(vec3(0.0), rgb, u_value), 1.0); }`;
const NV_FS = PRELUDE + `uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
out vec4 out_FragColor;
float rand(vec2 co) { return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
	float noise = rand(v_textureCoordinates + sin(czm_frameNumber)) * 0.1;
	vec3 rgb = texture(colorTexture, v_textureCoordinates).rgb;
	out_FragColor = vec4((noise + rgb) * vec3(0.0, 1.0, 0.0), 1.0);
}`;

/** 段の program（型と、glsl の本文ごと）と uniform の場所 */
interface StageProg { p: WebGLProgram; color: WebGLUniformLocation | null; depth: WebGLUniformLocation | null; vp: WebGLUniformLocation | null; pr: WebGLUniformLocation | null; fn: WebGLUniformLocation | null; eye: WebGLUniformLocation | null; u: Map<string, { loc: WebGLUniformLocation | null; type: string }>; needsDepth: boolean }
/** フレームの尺：logCoef＝対数深度の係数・dpr＝czm_pixelRatio・fovy＝縦の画角（rad）・frame＝フレーム番号 */
export interface StageFrame { logCoef: number; dpr: number; fovy: number; frame: number }
export type PostStagesGL = ReturnType<typeof createPostStagesGL>;

function compile(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
	const sh = (type: number, src: string): WebGLShader => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error("post stage shader: " + log); } return s; };
	const p = gl.createProgram()!, v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, fs);
	gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
	gl.deleteShader(v); gl.deleteShader(f);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { const log = gl.getProgramInfoLog(p); gl.deleteProgram(p); throw new Error("post stage link: " + log); }
	return p;
}
// 利用者の本文を Cesium の流儀から GL2 の 1 本の fragment へ：#version は 1 つに・out_FragColor の宣言が無ければ足す・前置きを付ける
export function glslStageSource(src: string): string {
	let body = src.replace(/^\s*#version[^\n]*\n/, "");
	if (!/\bout\s+(?:highp\s+|mediump\s+|lowp\s+)?vec4\s+out_FragColor\b/.test(body)) body = "out vec4 out_FragColor;\n" + body;
	return PRELUDE + body;
}
/** 本文の uniform 宣言（名前 → 型）＝値の流し方を決める */
export function glslUniformTypes(src: string): Map<string, string> {
	const m = new Map<string, string>();
	for (const [, type, names] of src.matchAll(/\buniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(float|int|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|sampler2D)\s+([^;]+);/g)) for (const n of names.split(",")) { const name = n.trim().replace(/\[.*$/, ""); if (name) m.set(name, type); }
	return m;
}

export function createPostStagesGL(gl: WebGL2RenderingContext, realBind: (target: number, fb: WebGLFramebuffer | null) => void, vao: WebGLVertexArrayObject) {
	const progs = new Map<string, StageProg | null>();   // 鍵＝型（glsl は "glsl:" + 本文）。null＝壊れていて飛ばす
	const depthProg = compile(gl, DEPTH_FS), dpTex = gl.getUniformLocation(depthProg, "u_depth"), dpP = gl.getUniformLocation(depthProg, "u_p");
	let T: { w: number; h: number; tex: WebGLTexture[]; fb: WebGLFramebuffer[]; dTex: WebGLTexture; dFb: WebGLFramebuffer } | null = null;
	const tex2d = (ifmt: number, w: number, h: number, fmt: number, type: number, nearest = false): WebGLTexture => {   // nearest＝深度（深度の形式は LINEAR で読めない＝不完全なテクスチャ＝0 が返る）
		const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
		const f = nearest ? gl.NEAREST : gl.LINEAR;
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		return t;
	};
	function free(): void { if (!T) return; for (const f of T.fb) gl.deleteFramebuffer(f); for (const t of T.tex) gl.deleteTexture(t); gl.deleteFramebuffer(T.dFb); gl.deleteTexture(T.dTex); T = null; }
	function ensure(W: number, H: number): void {
		if (T && T.w === W && T.h === H) return;
		free();
		const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
		const tex: WebGLTexture[] = [], fb: WebGLFramebuffer[] = [];
		for (let i = 0; i < 2; i++) { const t = tex2d(gl.RGBA8, W, H, gl.RGBA, gl.UNSIGNED_BYTE), f = gl.createFramebuffer()!; realBind.call(gl, gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); tex.push(t); fb.push(f); }
		const dTex = tex2d(gl.DEPTH_COMPONENT24, W, H, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, true), dFb = gl.createFramebuffer()!;
		realBind.call(gl, gl.FRAMEBUFFER, dFb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, dTex, 0);
		const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
		realBind.call(gl, gl.FRAMEBUFFER, null); gl.bindTexture(gl.TEXTURE_2D, prevTex);
		T = { w: W, h: H, tex, fb, dTex, dFb };
		if (!ok) { free(); throw new Error("post stage: depth framebuffer incomplete"); }
	}
	function progOf(s: PostStage): StageProg | null {
		const key = s.type === "glsl" ? "glsl:" + s.src : s.type;
		if (progs.has(key)) return progs.get(key)!;
		let sp: StageProg | null = null;
		try {
			const src = s.type === "silhouette" ? SIL_FS : s.type === "grey" ? GREY_FS : s.type === "brightness" ? BRIGHT_FS : s.type === "nightVision" ? NV_FS : glslStageSource(s.src);
			const p = compile(gl, src), u = new Map<string, { loc: WebGLUniformLocation | null; type: string }>();
			if (s.type === "glsl") for (const [name, type] of glslUniformTypes(s.src)) if (type !== "sampler2D") u.set(name, { loc: gl.getUniformLocation(p, name), type });
			sp = { p, color: gl.getUniformLocation(p, "colorTexture"), depth: gl.getUniformLocation(p, "depthTexture"), vp: gl.getUniformLocation(p, "czm_viewport"), pr: gl.getUniformLocation(p, "czm_pixelRatio"), fn: gl.getUniformLocation(p, "czm_frameNumber"), eye: gl.getUniformLocation(p, "ortho_eyeP"), u, needsDepth: !!gl.getUniformLocation(p, "depthTexture") };
		} catch (e) { console.warn(`[post] stage "${s.type}" skipped:`, (e as Error)?.message || e); }
		progs.set(key, sp);
		return sp;
	}
	// 入口の色（src＝固定の鎖の出力）→ 段を順に → 画面（FRAMEBUFFER null）。呼ぶ側が program・VAO・texture の束縛を控えて戻す。sceneDepth＝本体の深度テクスチャ
	function run(stages: PostStage[], src: WebGLTexture, sceneDepth: WebGLTexture, W: number, H: number, f: StageFrame): void {
		ensure(W, H);
		const list = stages.map(s => [s, progOf(s)] as const).filter(x => x[1]) as Array<readonly [PostStage, StageProg]>;
		gl.bindVertexArray(vao);
		gl.viewport(0, 0, W, H);
		if (list.some(x => x[1].needsDepth)) {   // Cesium の尺の深度を 1 度だけ
			realBind.call(gl, gl.FRAMEBUFFER, T!.dFb);
			gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(true);
			gl.useProgram(depthProg); gl.uniform1i(dpTex, 0); gl.uniform4f(dpP, 2 * Math.LN2 / Math.max(f.logCoef, 1e-9), 1 / Math.log2(CZM_FAR - CZM_NEAR + 1), CZM_NEAR, 0);
			gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneDepth);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
			gl.disable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
		}
		const aspect = W / Math.max(1, H), tanY = Math.tan(f.fovy / 2), eyeP = [tanY * aspect, tanY, Math.log2(CZM_FAR - CZM_NEAR + 1), CZM_NEAR];
		let cur = src;
		for (let i = 0; i < list.length; i++) {
			const [s, sp] = list[i], last = i === list.length - 1;
			realBind.call(gl, gl.FRAMEBUFFER, last ? null : T!.fb[i & 1]);
			gl.useProgram(sp.p);
			gl.uniform1i(sp.color, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, cur);
			if (sp.depth) { gl.uniform1i(sp.depth, 1); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T!.dTex); gl.activeTexture(gl.TEXTURE0); }
			gl.uniform4f(sp.vp, 0, 0, W, H); gl.uniform1f(sp.pr, f.dpr); gl.uniform1f(sp.fn, f.frame); gl.uniform4f(sp.eye, eyeP[0], eyeP[1], eyeP[2], eyeP[3]);
			if (s.type === "silhouette") { gl.uniform1f(gl.getUniformLocation(sp.p, "u_length"), s.length); gl.uniform4f(gl.getUniformLocation(sp.p, "u_color"), s.color[0], s.color[1], s.color[2], s.color[3]); }
			else if (s.type === "grey") gl.uniform1f(gl.getUniformLocation(sp.p, "u_gradations"), s.gradations);
			else if (s.type === "brightness") gl.uniform1f(gl.getUniformLocation(sp.p, "u_value"), s.value);
			else if (s.type === "glsl") for (const [name, v] of Object.entries(s.uniforms)) {
				const d = sp.u.get(name); if (!d || !d.loc) continue;
				const a = typeof v === "boolean" ? [v ? 1 : 0] : typeof v === "number" ? [v] : v;
				if (d.type === "float") gl.uniform1f(d.loc, a[0]); else if (d.type === "int" || d.type === "bool") gl.uniform1i(d.loc, a[0] | 0);
				else if (d.type === "vec2") gl.uniform2f(d.loc, a[0], a[1] ?? 0); else if (d.type === "vec3") gl.uniform3f(d.loc, a[0], a[1] ?? 0, a[2] ?? 0); else if (d.type === "vec4") gl.uniform4f(d.loc, a[0], a[1] ?? 0, a[2] ?? 0, a[3] ?? 1);
				else if (d.type === "ivec2") gl.uniform2i(d.loc, a[0] | 0, (a[1] ?? 0) | 0); else if (d.type === "ivec3") gl.uniform3i(d.loc, a[0] | 0, (a[1] ?? 0) | 0, (a[2] ?? 0) | 0); else if (d.type === "ivec4") gl.uniform4i(d.loc, a[0] | 0, (a[1] ?? 0) | 0, (a[2] ?? 0) | 0, (a[3] ?? 0) | 0);
			}
			gl.drawArrays(gl.TRIANGLES, 0, 3);
			cur = T!.tex[i & 1];
		}
		if (!list.length) { realBind.call(gl, gl.FRAMEBUFFER, null); }   // 全部壊れていた＝呼ぶ側の copy が画面へ写す
	}
	/** 固定の鎖の出力の的（最初の段が読む＝行き来の 2 枚目：段 0 は 1 枚目へ書く） */
	function target(W: number, H: number): { tex: WebGLTexture; fb: WebGLFramebuffer } { ensure(W, H); return { tex: T!.tex[1], fb: T!.fb[1] }; }
	/** 描ける段が 1 つでもあるか（全部壊れていれば false＝呼ぶ側は画面へ素に写す） */
	const drawable = (stages: PostStage[]): boolean => stages.some(s => !!progOf(s));
	function dispose(): void { free(); for (const sp of progs.values()) if (sp) gl.deleteProgram(sp.p); progs.clear(); gl.deleteProgram(depthProg); }
	const bytes = (): number => (T ? T.w * T.h * (4 + 4 + 4) : 0);
	return { run, target, drawable, dispose, bytes };
}
