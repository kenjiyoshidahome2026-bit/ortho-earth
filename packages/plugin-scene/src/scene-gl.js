// instanced・billboard・3D 文字の描き手（同一フレームのオーバーレイ＝map.overlay・render worker の中で地球と同じ rAF・同じ cam）。@ortho-earth/plugin-scene。
// ⚠ 依存ゼロ（import 文なし）＝render worker が URL で import() する。深度の GLSL は host.depthGLSL を貼る（建物・地形に隠れる）。
// 一つの map の全部の層（instanced／billboards／labels3d）を一つのオーバーレイ＝一つの WebGL 文脈で描く（render worker の文脈は Chrome で 4 つまで＝層ごとに作ると地球が落ちる）。
// 層は q（＝手綱の id）で分け、当たりの答えに layer: q を入れる（本体の addLayerId と組み、統一 picking が手綱の id で当たる）。
// message { type:"layer", q, kind:"mesh", mesh:{ pos, nrm, idx, col? }（局所 m・x 東 y 北 z 上）, n, ll: Float64Array(n*3)（経度・緯度・高さ m）, scl: Float32Array(n*3)（m）,
//           ori: Float32Array(n*3)（heading・pitch・roll 度）, rgba?: Uint8Array(n*4), color:[r,g,b,a 0..1], alt, depthTest, props? }
//         ／{ type:"layer", q, kind:"quad", n, ll, size: Float32Array(n*2)（units の幅・高さ）, uv: Float32Array(n*4), anchor: Float32Array(n*2)（左上 0,0・右下 1,1）,
//           angle: Float32Array(n)（度・時計回り）, rgba?, atlas:{ w, h, data: Uint8Array(w*h*4) }, facing:"screen"|"flat"|"upright", units:"pixels"|"meters", alt, depthTest, props? }
//         ／{ type:"remove", q }／{ type:"vis", q, on }／{ type:"clear" }／{ type:"probe", id }（検定＝次の frame の後に自分の画素を host.post）
// 位置＝β 単位球（楕円体は api.rAx）。高さ relative＝地形の高さ（api.elevM×api.liftScale＝本体の持ち上げと同じ式）＋高さ m、absolute＝海面から。
// 順＝mesh を深度つきで描いてから quad（深度は読むだけ＝箱の後ろの文字は隠れる）。facing：screen＝画面に向く・flat＝地面に寝る（angle＝北からの向き）・upright＝立つ板。
// 当たり＝番号（層の底＋gl_InstanceID）を RGBA8 に焼く別パス（同じ順・同じ深度）＝見えている物だけ当たる（画像の α<0.3 は当たらない）。
const DEPTH_STUB = `highp float sceneOcclusion(highp vec2 uv, highp float w) { return 0.0; }`;
const MESH_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_nrm;
layout(location = 2) in vec4 a_vcol;
layout(location = 3) in vec3 a_c;
layout(location = 4) in vec3 a_e;
layout(location = 5) in vec3 a_n;
layout(location = 6) in vec3 a_u;
layout(location = 7) in vec4 a_col;
uniform mat4 u_mvp;      // mvp×平行移動(origin)（倍精度で掛けてから f32）
uniform vec3 u_origin;
uniform vec3 u_eyeRel;   // eye − origin
uniform float u_oe;      // dot(origin, eye − origin)
uniform highp uint u_base;
out vec3 v_n; out vec4 v_col; out float v_w; out vec3 v_up; out vec3 v_toEye;
flat out highp uint v_id;
void main() {
	if (u_oe - dot(u_origin, a_c) + dot(a_c, u_eyeRel) - dot(a_c, a_c) < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // 地平線の向こう
	vec3 p = a_c + a_e * a_pos.x + a_n * a_pos.y + a_u * a_pos.z;
	v_n = a_e * (a_nrm.x / max(dot(a_e, a_e), 1e-30)) + a_n * (a_nrm.y / max(dot(a_n, a_n), 1e-30)) + a_u * (a_nrm.z / max(dot(a_u, a_u), 1e-30));   // 逆転置＝A·S⁻²
	v_up = normalize(u_origin + a_c); v_toEye = u_eyeRel - p;
	v_col = a_col * a_vcol; v_id = u_base + uint(gl_InstanceID);
	vec4 c = u_mvp * vec4(p, 1.0); v_w = c.w; gl_Position = c;
}`;
const MESH_FS = (depthGLSL, pick) => `#version 300 es
precision highp float;
uniform vec2 u_vp; uniform float u_occl;
${depthGLSL}
in vec3 v_n; in vec4 v_col; in float v_w; in vec3 v_up; in vec3 v_toEye;
flat in highp uint v_id;
out vec4 o;
void main() {
	if (u_occl > 0.5 && sceneOcclusion(gl_FragCoord.xy / u_vp, v_w) > 0.5) discard;   // depthTest:false の層は隠れない
	${pick ? `if (v_col.a < 0.05) discard; o = vec4(float(v_id & 255u), float((v_id >> 8) & 255u), float((v_id >> 16) & 255u), float((v_id >> 24) & 255u)) / 255.0;` : `
	vec3 n = normalize(v_n); if (dot(n, v_toEye) < 0.0) n = -n;   // 両面＝裏から見ても陰影が立つ
	vec3 up = normalize(v_up), e0 = cross(up, vec3(0.0, 1.0, 0.0)); vec3 east = dot(e0, e0) < 1e-12 ? vec3(1.0, 0.0, 0.0) : normalize(e0); vec3 north = cross(east, up);
	float d = 0.55 + 0.45 * max(dot(n, normalize(up * 0.8 - east * 0.35 + north * 0.45)), 0.0);   // 北西の上からの光（基図の建物と同じ向きの印象）
	o = vec4(v_col.rgb * d * v_col.a, v_col.a);`}
}`;
const QUAD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_q;
layout(location = 1) in vec3 a_c;
layout(location = 2) in vec2 a_size;
layout(location = 3) in vec4 a_uv;
layout(location = 4) in vec2 a_anc;
layout(location = 5) in float a_ang;
layout(location = 6) in vec4 a_col;
uniform mat4 u_mvp; uniform vec3 u_origin; uniform vec3 u_eyeRel; uniform float u_oe;
uniform vec2 u_vp; uniform float u_dpr; uniform float u_focal; uniform float u_k;
uniform int u_mode; uniform int u_units; uniform highp uint u_base;
out vec2 v_uv; out vec4 v_col; out float v_w;
flat out highp uint v_id;
void main() {
	if (u_oe - dot(u_origin, a_c) + dot(a_c, u_eyeRel) - dot(a_c, a_c) < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
	vec2 off = vec2((a_q.x - a_anc.x) * a_size.x, (a_anc.y - a_q.y) * a_size.y);   // 錨からの位置（右＋・上＋）
	float an = -radians(a_ang), ca = cos(an), sa = sin(an);
	vec4 c0 = u_mvp * vec4(a_c, 1.0);
	float s = u_units == 1 ? u_k : c0.w / u_focal * u_dpr;   // 1 単位あたりの世界の長さ（m なら 1/R・px なら中心の奥行きでの 1 px）
	v_uv = vec2(mix(a_uv.x, a_uv.z, a_q.x), mix(a_uv.y, a_uv.w, a_q.y)); v_col = a_col; v_id = u_base + uint(gl_InstanceID);
	if (u_mode == 0) {
		vec2 r = vec2(off.x * ca - off.y * sa, off.x * sa + off.y * ca);
		vec2 px = u_units == 1 ? r * u_k * u_focal / max(c0.w, 1e-12) : r * u_dpr;
		gl_Position = vec4(c0.xy + px * 2.0 / u_vp * c0.w, c0.z, c0.w); v_w = c0.w; return;
	}
	vec3 up = normalize(u_origin + a_c), e0 = cross(up, vec3(0.0, 1.0, 0.0)); vec3 east = dot(e0, e0) < 1e-12 ? vec3(1.0, 0.0, 0.0) : normalize(e0); vec3 north = cross(east, up);
	vec3 p;
	if (u_mode == 1) { vec3 rx = east * ca + north * sa, ry = -east * sa + north * ca; p = a_c + (rx * off.x + ry * off.y) * s; }   // 寝る＝東北の面で回す
	else { vec3 rx = east * ca + north * sa; p = a_c + (rx * off.x + up * off.y) * s; }   // 立つ＝右手を回し・上はそのまま
	vec4 c = u_mvp * vec4(p, 1.0); v_w = c.w; gl_Position = c;
}`;
const QUAD_FS = (depthGLSL, pick) => `#version 300 es
precision highp float;
uniform vec2 u_vp; uniform float u_occl; uniform sampler2D u_tex;
${depthGLSL}
in vec2 v_uv; in vec4 v_col; in float v_w;
flat in highp uint v_id;
out vec4 o;
void main() {
	if (u_occl > 0.5 && sceneOcclusion(gl_FragCoord.xy / u_vp, v_w) > 0.5) discard;   // depthTest:false の層は隠れない
	vec4 t = texture(u_tex, v_uv) * v_col;
	${pick ? `if (t.a < 0.3) discard; o = vec4(float(v_id & 255u), float((v_id >> 8) & 255u), float((v_id >> 16) & 255u), float((v_id >> 24) & 255u)) / 255.0;` : `if (t.a < 0.004) discard; o = vec4(t.rgb * t.a, t.a);`}
}`;
let gl = null, host = null, wantDepth = false, quad = null, dummyTex = null;
let mesh = null, meshPick = null, quadP = null, quadPick = null;   // { p, u }
let pickFbo = null, pickTex = null, pickDepth = null, pickW = 0, pickH = 0;
const layers = new Map(), probes = [];
const R_SPHERE = 6371000, R_ELL = 6378137;
function compile(vs, fs) {
	const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
	const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
	const u = {}; for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm); }
	return { p, u };
}
export function init(canvas, opts = {}, h = null) {
	host = h;
	gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: true, alpha: true, depth: true });
	if (!gl) throw new Error("WebGL2 is not available (plugin-scene overlay)");
	wantDepth = opts.depth !== false && !!h?.depthGLSL;
	const dg = wantDepth ? h.depthGLSL : DEPTH_STUB;
	mesh = compile(MESH_VS, MESH_FS(dg, false)); quadP = compile(QUAD_VS, QUAD_FS(dg, false));
	try { meshPick = compile(MESH_VS, MESH_FS(dg, true)); quadPick = compile(QUAD_VS, QUAD_FS(dg, true)); } catch (e) { meshPick = quadPick = null; console.warn("[plugin-scene] pick pass unavailable", e?.message); }
	quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
	return wantDepth ? { depth: true } : undefined;
}
// 経緯度 → β 単位球（楕円体は tanβ＝rAx·tanφ）
const unit = (lon, lat, rAx) => { const a = lon * Math.PI / 180; let b = lat * Math.PI / 180; if (rAx !== 1) b = Math.atan(rAx * Math.tan(b)); const cb = Math.cos(b); return [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)]; };
// 局所の基底（東・北・上）×向き（heading 北から時計回り・pitch 機首上げ・roll 右翼下げ）×大きさ（m → 単位球）＝列 3 本
export function basisOf(lon, lat, sx, sy, sz, hd, pt, rl, rAx = 1) {
	const u = unit(lon, lat, rAx), cl = Math.hypot(u[0], u[2]);
	const E = cl < 1e-12 ? [1, 0, 0] : [-u[2] / cl, 0, u[0] / cl], N = [E[1] * u[2] - E[2] * u[1], E[2] * u[0] - E[0] * u[2], E[0] * u[1] - E[1] * u[0]];
	const h = -hd * Math.PI / 180, p = pt * Math.PI / 180, r = rl * Math.PI / 180;
	const Rz = [[Math.cos(h), -Math.sin(h), 0], [Math.sin(h), Math.cos(h), 0], [0, 0, 1]], Rx = [[1, 0, 0], [0, Math.cos(p), -Math.sin(p)], [0, Math.sin(p), Math.cos(p)]], Ry = [[Math.cos(r), 0, Math.sin(r)], [0, 1, 0], [-Math.sin(r), 0, Math.cos(r)]];
	const mm = (A, B) => A.map((row, i) => [0, 1, 2].map(j => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
	const M = mm(mm(Rz, Rx), Ry), k = 1 / (rAx === 1 ? R_SPHERE : R_ELL), S = [sx * k, sy * k, sz * k];
	return [0, 1, 2].map(j => [0, 1, 2].map(c => (E[c] * M[0][j] + N[c] * M[1][j] + u[c] * M[2][j]) * S[j]));   // 列 j＝局所軸 j の世界での向き×大きさ
}
const MODES = { screen: 0, flat: 1, upright: 2 };
const drop = L => { if (!L) return; clearTimeout(L.timer); clearTimeout(L.recheck); for (const b of L.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(L.vao); if (L.tex) gl.deleteTexture(L.tex); };
function buildMesh(d) {
	const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
	const bufs = [];
	const attr = (loc, arr, size, type, norm, div = 0, usage = gl.STATIC_DRAW) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, usage); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, norm, 0, 0); gl.vertexAttribDivisor(loc, div); bufs.push(b); return b; };
	attr(0, d.mesh.pos, 3, gl.FLOAT, false); attr(1, d.mesh.nrm, 3, gl.FLOAT, false);
	if (d.mesh.col) attr(2, d.mesh.col, 4, gl.UNSIGNED_BYTE, true); else { gl.disableVertexAttribArray(2); gl.vertexAttrib4f(2, 1, 1, 1, 1); }
	const n = d.n, cbuf = attr(3, new Float32Array(n * 3), 3, gl.FLOAT, false, 1, gl.DYNAMIC_DRAW);
	const ebuf = attr(4, new Float32Array(n * 3), 3, gl.FLOAT, false, 1), nbuf = attr(5, new Float32Array(n * 3), 3, gl.FLOAT, false, 1), ubuf = attr(6, new Float32Array(n * 3), 3, gl.FLOAT, false, 1);
	if (d.rgba) attr(7, d.rgba, 4, gl.UNSIGNED_BYTE, true, 1); else { gl.disableVertexAttribArray(7); const c = d.color || [0.85, 0.85, 0.85, 1]; gl.vertexAttrib4f(7, c[0], c[1], c[2], c[3] ?? 1); }
	const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.mesh.idx, gl.STATIC_DRAW); bufs.push(ib);
	gl.bindVertexArray(null);
	return { kind: "mesh", occl: d.depthTest !== false, vcol: !d.mesh.col, cst: d.rgba ? null : (d.color || [0.85, 0.85, 0.85, 1]), n, ll: d.ll, scl: d.scl, ori: d.ori, alt: d.alt || "relative", props: d.props || null, vao, bufs, cbuf, ebuf, nbuf, ubuf, count: d.mesh.idx.length, on: true, base: 0, rAx: null, origin: null, centers: null, liftKey: null, refreshAt: 0 };
}
function buildQuad(d) {
	const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
	const bufs = [];
	gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	const attr = (loc, arr, size, type, norm, usage = gl.STATIC_DRAW) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, usage); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, norm, 0, 0); gl.vertexAttribDivisor(loc, 1); bufs.push(b); return b; };
	const n = d.n, cbuf = attr(1, new Float32Array(n * 3), 3, gl.FLOAT, false, gl.DYNAMIC_DRAW);
	attr(2, d.size, 2, gl.FLOAT, false); attr(3, d.uv, 4, gl.FLOAT, false); attr(4, d.anchor, 2, gl.FLOAT, false); attr(5, d.angle, 1, gl.FLOAT, false);
	if (d.rgba) attr(6, d.rgba, 4, gl.UNSIGNED_BYTE, true); else { gl.disableVertexAttribArray(6); gl.vertexAttrib4f(6, 1, 1, 1, 1); }
	gl.bindVertexArray(null);
	const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, d.atlas.w, d.atlas.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, d.atlas.data);
	gl.generateMipmap(gl.TEXTURE_2D);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return { kind: "quad", occl: d.depthTest !== false, cst: d.rgba ? null : [1, 1, 1, 1], n, ll: d.ll, alt: d.alt || "relative", mode: MODES[d.facing] ?? 0, units: d.units === "meters" ? 1 : 0, props: d.props || null, vao, bufs, cbuf, tex, on: true, base: 0, rAx: null, origin: null, liftKey: null, refreshAt: 0 };
}
function rebase() { let b = 1; for (const L of layers.values()) { L.base = b; b += L.n; } }
export function message(d) {
	if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
	if (!gl) return;
	if (d.type === "layer") { drop(layers.get(d.q)); layers.set(d.q, d.kind === "quad" ? buildQuad(d) : buildMesh(d)); rebase(); host?.requestDraw?.(); }
	else if (d.type === "remove") { drop(layers.get(d.q)); layers.delete(d.q); rebase(); host?.requestDraw?.(); }
	else if (d.type === "vis") { const L = layers.get(d.q); if (L) L.on = !!d.on; host?.requestDraw?.(); }
	else if (d.type === "clear") { layers.forEach(drop); layers.clear(); rebase(); host?.requestDraw?.(); }
}
// mesh＝基底（rAx が変わった時だけ）と中心（refreshCenters）
function prepareMesh(L, api) {
	const rAx = api?.rAx || 1, n = L.n;
	if (L.rAx !== rAx) {
		const E = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) {
			const B = basisOf(L.ll[i * 3], L.ll[i * 3 + 1], L.scl[i * 3], L.scl[i * 3 + 1], L.scl[i * 3 + 2], L.ori[i * 3], L.ori[i * 3 + 1], L.ori[i * 3 + 2], rAx);
			E.set(B[0], i * 3); N.set(B[1], i * 3); U.set(B[2], i * 3);
		}
		gl.bindBuffer(gl.ARRAY_BUFFER, L.ebuf); gl.bufferData(gl.ARRAY_BUFFER, E, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, L.nbuf); gl.bufferData(gl.ARRAY_BUFFER, N, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, L.ubuf); gl.bufferData(gl.ARRAY_BUFFER, U, gl.STATIC_DRAW);
		L.rAx = rAx; L.liftKey = null;
	}
	refreshCenters(L, api, rAx);
}
function prepareQuad(L, api) {
	const rAx = api?.rAx || 1;
	if (L.rAx !== rAx) { L.rAx = rAx; L.origin = null; L.liftKey = null; }
	refreshCenters(L, api, rAx);
}
// 中心（地形の持ち上げ込み・原点からの差を f32 で）。relative は地形のタイルが後から届く＝引き直す：数が少なければ毎フレーム、多ければ 0.5 秒おき
// （間が空く時は描き直しを頼む）。値が変わったら 0.6 秒後にもう一度描き直しを頼む＝静止した画面でも届いた地形に追いつく（変わらなくなれば止む）
const CHEAP = 2000;
function refreshCenters(L, api, rAx) {
	const rel = L.alt !== "absolute", ls = rel ? (api?.liftScale || 0) : 0, key = `${rAx}|${ls}`, now = performance.now(), live = rel && ls > 0;
	if (L.liftKey === key && !(live && (L.n <= CHEAP || now >= L.refreshAt))) {
		if (live && !L.timer) L.timer = setTimeout(() => { L.timer = 0; host?.requestDraw?.(); }, Math.max(16, L.refreshAt - now));
		return;
	}
	const n = L.n, k = 1 / (rAx === 1 ? R_SPHERE : R_ELL), C = new Float64Array(n * 3);
	for (let i = 0; i < n; i++) {
		const lon = L.ll[i * 3], lat = L.ll[i * 3 + 1], u = unit(lon, lat, rAx), r = 1 + (ls > 0 ? (api.elevM(lon, lat) || 0) * ls : 0) + (L.ll[i * 3 + 2] || 0) * k;
		C[i * 3] = u[0] * r; C[i * 3 + 1] = u[1] * r; C[i * 3 + 2] = u[2] * r;
	}
	L.refreshAt = now + 500;
	if (L.liftKey === key && L.centers && C.every((v, i) => v === L.centers[i])) return;
	if (!L.origin) { let x = 0, y = 0, z = 0; for (let i = 0; i < n; i++) { x += C[i * 3]; y += C[i * 3 + 1]; z += C[i * 3 + 2]; } L.origin = n ? [x / n, y / n, z / n] : [0, 0, 0]; }
	const F = new Float32Array(n * 3), o = L.origin;
	for (let i = 0; i < n; i++) { F[i * 3] = C[i * 3] - o[0]; F[i * 3 + 1] = C[i * 3 + 1] - o[1]; F[i * 3 + 2] = C[i * 3 + 2] - o[2]; }
	gl.bindBuffer(gl.ARRAY_BUFFER, L.cbuf); gl.bufferData(gl.ARRAY_BUFFER, F, gl.DYNAMIC_DRAW);
	L.centers = C; L.liftKey = key;
	if (live) { clearTimeout(L.recheck); L.recheck = setTimeout(() => host?.requestDraw?.(), 600); }
}
function bindDepth(P, U, api) {
	if (!wantDepth) return;
	if (api?.depth) { api.depth.bind(gl, P, 3); return; }
	// 深度の無いフレーム（当たりの別パス・申し出前）＝標本器を空の 1×1 に向ける（既定の unit 0 に当たりの FBO の色が残っていると読み書きの輪で描けない）
	if (U.u_sceneDepthOn) gl.uniform1f(U.u_sceneDepthOn, 0);
	if (U.u_sceneDepth) { if (!dummyTex) { dummyTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, dummyTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); } gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, dummyTex); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(U.u_sceneDepth, 3); }
}
const mvpL = new Float32Array(16);
function placeLayer(U, s, L) {   // 層の原点へ平行移動した mvp（倍精度で掛けてから f32）と地平線の判定の係数
	const M = s.mvp, E = s.eye, o = L.origin;
	for (let i = 0; i < 12; i++) mvpL[i] = M[i];
	for (let r = 0; r < 4; r++) mvpL[12 + r] = M[r] * o[0] + M[4 + r] * o[1] + M[8 + r] * o[2] + M[12 + r];
	gl.uniformMatrix4fv(U.u_mvp, false, mvpL); gl.uniform3f(U.u_origin, o[0], o[1], o[2]);
	const ex = E[0] - o[0], ey = E[1] - o[1], ez = E[2] - o[2];
	gl.uniform3f(U.u_eyeRel, ex, ey, ez); gl.uniform1f(U.u_oe, o[0] * ex + o[1] * ey + o[2] * ez);
	if (U.u_base) gl.uniform1ui(U.u_base, L.base);
	if (U.u_occl) gl.uniform1f(U.u_occl, L.occl ? 1 : 0);
}
function drawAll(pick, s, api, w, h, dpr) {
	const PM = pick ? meshPick : mesh, PQ = pick ? quadPick : quadP;
	gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE);
	if (pick) gl.disable(gl.BLEND); else { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
	let used = false;
	for (const L of layers.values()) {   // ① mesh（深度を書く）
		if (L.kind !== "mesh" || !L.on || !L.n) continue;
		if (!used) { gl.useProgram(PM.p); bindDepth(PM.p, PM.u, api); gl.uniform2f(PM.u.u_vp, w, h); gl.depthMask(true); used = true; }
		prepareMesh(L, api); placeLayer(PM.u, s, L);
		if (L.vcol) gl.vertexAttrib4f(2, 1, 1, 1, 1);   // 切った属性の定数は VAO でなく文脈の状態＝層ごとに描く直前に置く
		if (L.cst) gl.vertexAttrib4f(7, L.cst[0], L.cst[1], L.cst[2], L.cst[3] ?? 1);
		gl.bindVertexArray(L.vao); gl.drawElementsInstanced(gl.TRIANGLES, L.count, gl.UNSIGNED_INT, 0, L.n);
	}
	used = false;
	for (const L of layers.values()) {   // ② quad（深度は読むだけ）
		if (L.kind !== "quad" || !L.on || !L.n) continue;
		if (!used) { gl.useProgram(PQ.p); bindDepth(PQ.p, PQ.u, api); gl.uniform2f(PQ.u.u_vp, w, h); gl.uniform1f(PQ.u.u_dpr, dpr); gl.uniform1f(PQ.u.u_focal, s.focal); gl.depthMask(false); used = true; }
		prepareQuad(L, api); placeLayer(PQ.u, s, L);
		if (L.cst) gl.vertexAttrib4f(6, 1, 1, 1, 1);
		gl.uniform1f(PQ.u.u_k, 1 / (L.rAx === 1 ? R_SPHERE : R_ELL)); gl.uniform1i(PQ.u.u_mode, L.mode); gl.uniform1i(PQ.u.u_units, L.units);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, L.tex); gl.uniform1i(PQ.u.u_tex, 0);
		gl.bindVertexArray(L.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, L.n);
	}
	gl.bindVertexArray(null); gl.depthMask(true); gl.disable(gl.DEPTH_TEST);
}
function answerProbes(w, h) {
	if (!probes.length) return;
	const ids = probes.splice(0);
	try { const data = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data); for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: true, data: id === ids[ids.length - 1] ? data : data.slice() }); }
	catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String(e?.message || e) }); }
}
export function frame(cam, s, { w, h }, api) {
	if (!gl) return false;
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
	if (layers.size) drawAll(false, s, api, w, h, cam?.dpr || 1);
	answerProbes(w, h);
	return false;
}
const decodeId = (r, g, b, a) => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
export function pick(x, y, r, ctx) {
	if (!gl || !meshPick || !layers.size || !ctx?.s) return null;
	const { w, h } = ctx.size;
	if (pickW !== w || pickH !== h || !pickFbo) {
		if (pickTex) gl.deleteTexture(pickTex); if (pickDepth) gl.deleteRenderbuffer(pickDepth); if (pickFbo) gl.deleteFramebuffer(pickFbo);
		pickTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, pickTex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h); gl.bindTexture(gl.TEXTURE_2D, null);
		pickDepth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, pickDepth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
		pickFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTex, 0); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, pickDepth);
		pickW = w; pickH = h;
	} else gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
	drawAll(true, ctx.s, ctx.api, w, h, ctx.cam?.dpr || 1);
	const rr = Math.max(0, Math.round(r)), side = rr * 2 + 1, x0 = Math.round(x) - rr, y0 = (h - 1 - Math.round(y)) - rr;
	const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(w, x0 + side), cy1 = Math.min(h, y0 + side);
	let best = null;
	if (cx1 > cx0 && cy1 > cy0) {
		const sub = new Uint8Array((cx1 - cx0) * (cy1 - cy0) * 4);
		gl.readPixels(cx0, cy0, cx1 - cx0, cy1 - cy0, gl.RGBA, gl.UNSIGNED_BYTE, sub);
		for (let j = 0; j < cy1 - cy0; j++) for (let i = 0; i < cx1 - cx0; i++) {
			const k = (j * (cx1 - cx0) + i) * 4, id = decodeId(sub[k], sub[k + 1], sub[k + 2], sub[k + 3]); if (!id) continue;
			const dd = Math.hypot(cx0 + i - (x0 + rr), cy0 + j - (y0 + rr));
			if (!best || dd < best.distance) best = { id, distance: dd };
		}
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	if (!best) return null;
	for (const [q, L] of layers) if (best.id >= L.base && best.id < L.base + L.n) {
		const index = best.id - L.base;
		return { id: best.id, q, layer: q, index, distance: best.distance, lngLat: [L.ll[index * 3], L.ll[index * 3 + 1]], properties: L.props?.[index] ?? { index } };
	}
	return null;
}
export function destroy() {
	if (!gl) return;
	layers.forEach(drop); layers.clear();
	for (const P of [mesh, meshPick, quadP, quadPick]) if (P) gl.deleteProgram(P.p);
	gl.deleteBuffer(quad); if (dummyTex) gl.deleteTexture(dummyTex);
	if (pickTex) gl.deleteTexture(pickTex); if (pickDepth) gl.deleteRenderbuffer(pickDepth); if (pickFbo) gl.deleteFramebuffer(pickFbo);
	gl = null;
}
