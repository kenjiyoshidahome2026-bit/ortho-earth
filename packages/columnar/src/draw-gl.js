// draw-gl.js ── 列チャンク層の描画（同一フレームのオーバーレイ＝map.overlay・render worker 内で地球と同じ rAF・同じ cam に描く・#90）。
// 契約（@ortho-earth/globe の map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) / destroy()
//   message { type:"chunk", g, chunk, table }   … chunk.js の列チャンク（origin・points・levels）＋fid 表（Uint32Array(n*4)・gint と同じ形）。同じ g は置き換え
//           { type:"table", g, table }          … 表だけ差し替え（paint / filter の変化＝幾何はそのまま）
//           { type:"levels", g, levels }        … 後から届く LOD の段を足す（最初の 1 枚は今の zoom の段だけで出す）
//           { type:"remove", g }／{ type:"vis", on }／{ type:"clear" }／{ type:"perf", on }（frame の CPU ms を host.post で返す）
//           { type:"probe", id }               … 次の frame の後に自分の画素（readPixels・premultiplied RGBA・下が先）を host.post（検定用＝anno-draw と同じ口）
// 描き方：
//   面＝三角形をそのまま（色は fid 表の R）・線と面の輪郭＝辺ごとのインスタンス四角形（幅は表の 1/8 CSS px × dpr・角は正方キャップで埋める）・点＝スプライト（半径は表の 1/4 px）
//   LOD＝チャンクの levels から「zoom ≥ 今の zoom の最小の段」（無ければ全解像度）
//   地平の向こう＝接平面の判定 dot(P, E−P) > 0 を**原点相対**で（u_oe＝dot(O, E−O) は CPU の f64・残りは小さい量どうし）＝f32 の桁落ちなし。
//     旧＝絶対座標で視線と球の交点 t0 を見る式は、z13 でも t0 が 1−1e-4 の縁に来て画素ごとに明滅した（線に穴・2026-09-27 実測）。面・線は FS（画素単位＝縁で正しく切れる）・点は VS。地形には沿わない（楕円体の上・段 5）
//   原点相対（RTE）＝mvp×平行移動(origin) を倍精度で掛けてから float32 へ（points-gl と同じ流儀）
// ⚠ 依存ゼロ（import 文なし）＝render worker が URL で import() する。
const HORIZON = `
uniform vec3 u_eyeRel;   // E − O（f64 で引いて f32 へ＝小さい）
uniform float u_oe;      // dot(O, E − O)（f64）
bool behindGlobe(vec3 p) {   // p＝原点相対。見える ⇔ dot(P, E − P) > 0 ＝ u_oe + dot(p, eyeRel − p) − dot(O, p)（全部小さい量＝桁落ちしない）
	return u_oe + dot(p, u_eyeRel - p) - dot(u_origin, p) <= 0.0;
}`;
const TAB = `
uniform highp usampler2D u_tab;
uniform int u_tabW;
uvec4 rec(uint f) { int i = int(f); return texelFetch(u_tab, ivec2(i % u_tabW, i / u_tabW), 0); }
vec4 unpack(uint c) { return vec4(float((c >> 24u) & 255u), float((c >> 16u) & 255u), float((c >> 8u) & 255u), float(c & 255u)) / 255.0; }`;
const OFF = "vec4(2.0, 2.0, 2.0, 1.0)";

const VS_FILL = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in uint a_feat;
uniform mat4 u_mvp; uniform vec3 u_origin;
${TAB}
out vec4 v_col; out vec3 v_rel;
void main() {
	uvec4 r = rec(a_feat); vec4 col = unpack(r.r);
	if ((r.b & 1u) == 0u || col.a <= 0.0) { gl_Position = ${OFF}; v_col = vec4(0.0); v_rel = vec3(0.0); return; }
	v_col = col; v_rel = a_pos;
	gl_Position = u_mvp * vec4(a_pos, 1.0);
}`;
const FS_SURF = `#version 300 es
precision highp float;
in vec4 v_col; in vec3 v_rel;
uniform vec3 u_origin;
out vec4 o;
${HORIZON}
void main() {
	if (v_col.a <= 0.0 || behindGlobe(v_rel)) discard;
	o = vec4(v_col.rgb * v_col.a, v_col.a);
}`;
const VS_LINE = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
layout(location = 0) in vec3 a_p0;
layout(location = 1) in vec3 a_p1;
layout(location = 2) in uint a_feat;
uniform mat4 u_mvp; uniform vec3 u_origin; uniform vec2 u_vp; uniform float u_dpr;
${TAB}
out vec4 v_col; out vec3 v_rel;
void main() {
	uint f = a_feat & 0x7fffffffu;
	uvec4 r = rec(f); vec4 col = unpack(r.g); float w = float((r.b >> 24u) & 255u) / 8.0 * u_dpr;
	if ((a_feat & 0x80000000u) != 0u || (r.b & 1u) == 0u || col.a <= 0.0 || w <= 0.0) { gl_Position = ${OFF}; v_col = vec4(0.0); v_rel = vec3(0.0); return; }
	vec4 c0 = u_mvp * vec4(a_p0, 1.0), c1 = u_mvp * vec4(a_p1, 1.0);
	if (c0.w <= 0.0 || c1.w <= 0.0) { gl_Position = ${OFF}; v_col = vec4(0.0); v_rel = vec3(0.0); return; }
	vec2 s0 = c0.xy / c0.w * 0.5 * u_vp, s1 = c1.xy / c1.w * 0.5 * u_vp;
	vec2 d = s1 - s0; float L = length(d); vec2 dir = L > 0.0 ? d / L : vec2(1.0, 0.0); vec2 nrm = vec2(-dir.y, dir.x);
	int id = gl_VertexID; bool at1 = (id >> 1) == 1; float side = float((id & 1) * 2 - 1);
	float wp = max(w, 1.0); col.a *= min(w, 1.0);   // 1px 未満は 1px で薄く
	vec4 c = at1 ? c1 : c0; vec2 s = at1 ? s1 : s0;
	vec2 off = nrm * side * wp * 0.5 + dir * (at1 ? 1.0 : -1.0) * wp * 0.5;   // 正方キャップ＝繋ぎ目の欠けを埋める
	vec2 sp = s + off;
	gl_Position = vec4(sp / (0.5 * u_vp) * c.w, c.z, c.w);
	v_col = col; v_rel = at1 ? a_p1 : a_p0;
}`;
const VS_POINT = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in uint a_feat;
uniform mat4 u_mvp; uniform vec3 u_origin; uniform float u_dpr; uniform float u_maxPt;
${TAB}
${HORIZON}
out vec4 v_col; out float v_rad;
void main() {
	uvec4 r = rec(a_feat); vec4 col = unpack(r.g); float rad = float((r.b >> 8u) & 255u) / 4.0 * u_dpr;
	if ((r.b & 1u) == 0u || col.a <= 0.0 || rad <= 0.0 || behindGlobe(a_pos)) { gl_Position = ${OFF}; gl_PointSize = 0.0; v_col = vec4(0.0); v_rad = 0.0; return; }
	vec4 c = u_mvp * vec4(a_pos, 1.0);
	if (c.w <= 0.0) { gl_Position = ${OFF}; gl_PointSize = 0.0; v_col = vec4(0.0); v_rad = 0.0; return; }
	v_rad = min(rad, u_maxPt * 0.5 - 1.0); v_col = col;
	gl_PointSize = v_rad * 2.0 + 2.0;
	gl_Position = c;
}`;
const FS_POINT = `#version 300 es
precision highp float;
in vec4 v_col; in float v_rad;
out vec4 o;
void main() {
	vec2 p = (gl_PointCoord * 2.0 - 1.0) * (v_rad + 1.0);
	float cov = clamp(v_rad + 0.5 - length(p), 0.0, 1.0);
	if (cov <= 0.0 || v_col.a <= 0.0) discard;
	float a = v_col.a * cov;
	o = vec4(v_col.rgb * a, a);
}`;

let gl = null, host = null, pFill = null, pLine = null, pPoint = null, maxPt = 1, visible = true, perf = false, pfN = 0, pfMs = 0;
const probes = [];   // 検定用の画素の取り寄せ（次の frame の後で読む）
const chunks = new Map();   // g → { origin, n, tab, tabW, points:{vao,n}|null, levels:[{zoom, lines:{vao,nSeg}|null, fills:{vao,count}|null}], bufs:[] }
const TAB_W = 1024;

function compile(vs, fs) {
	const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + "\n" + src); return s; };
	const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
	const u = {}; for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm); }
	return { p, u };
}
export function init(canvas, opts = {}, h = null) {
	host = h;
	gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: true, alpha: true, depth: false });
	if (!gl) throw new Error("WebGL2 is not available (columnar overlay)");
	pFill = compile(VS_FILL, FS_SURF); pLine = compile(VS_LINE, FS_SURF); pPoint = compile(VS_POINT, FS_POINT);
	maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
	perf = !!opts.perf;
}
const buf = (data, target = gl.ARRAY_BUFFER) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
function tableTex(u32, n) {
	const h = Math.max(1, Math.ceil(n / TAB_W)), full = TAB_W * h * 4;
	let data = u32; if (u32.length !== full) { data = new Uint32Array(full); data.set(u32.subarray(0, Math.min(u32.length, full))); }
	const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, TAB_W, h, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data);
	gl.bindTexture(gl.TEXTURE_2D, null);
	return t;
}
function drop(C) {
	if (!C) return;
	for (const b of C.bufs) gl.deleteBuffer(b);
	for (const v of C.vaos) gl.deleteVertexArray(v);
	gl.deleteTexture(C.tab);
}
function uploadLevel(C, L) {
	const lv = { zoom: L.zoom, lines: null, fills: null };
	if (L.lines && L.lines.feat.length >= 2) {
		const pb = buf(L.lines.pos), fb = buf(L.lines.feat);
		const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, pb);
		gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(0, 1);
		gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 12); gl.vertexAttribDivisor(1, 1);   // 次の頂点＝同じ buffer の 12 バイト先
		gl.bindBuffer(gl.ARRAY_BUFFER, fb); gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 0, 0); gl.vertexAttribDivisor(2, 1);
		gl.bindVertexArray(null);
		lv.lines = { vao, nSeg: L.lines.feat.length - 1 }; C.bufs.push(pb, fb); C.vaos.push(vao);
	}
	if (L.fills && L.fills.index.length) {
		const pb = buf(L.fills.pos), fb = buf(L.fills.feat), ib = buf(L.fills.index, gl.ELEMENT_ARRAY_BUFFER);
		const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
		gl.bindBuffer(gl.ARRAY_BUFFER, fb); gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
		gl.bindVertexArray(null);
		lv.fills = { vao, count: L.fills.index.length }; C.bufs.push(pb, fb, ib); C.vaos.push(vao);
	}
	C.levels = C.levels.filter(x => x.zoom !== lv.zoom);
	C.levels.push(lv);
	C.levels.sort((a, b) => a.zoom - b.zoom);   // 昇順＝「zoom ≥ 今の zoom の最小の段」を前から探す
}
function upload(d) {
	drop(chunks.get(d.g));
	const c = d.chunk, C = { origin: c.origin, n: c.n, tab: tableTex(d.table, c.n), tabW: TAB_W, points: null, levels: [], bufs: [], vaos: [] };
	if (c.points && c.points.feat.length) {
		const pb = buf(c.points.pos), fb = buf(c.points.feat);
		const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
		gl.bindBuffer(gl.ARRAY_BUFFER, fb); gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0);
		gl.bindVertexArray(null);
		C.points = { vao, n: c.points.feat.length }; C.bufs.push(pb, fb); C.vaos.push(vao);
	}
	for (const L of c.levels) uploadLevel(C, L);
	chunks.set(d.g, C);
}
export function message(d) {
	if (!gl) return;
	try { message1(d); } catch (e) { console.error("[columnar overlay]", d.type, e?.message || e); host?.post?.({ type: "error", where: d.type, error: String(e?.message || e) }); }
}
function message1(d) {
	if (d.type === "chunk") upload(d);
	else if (d.type === "table") { const C = chunks.get(d.g); if (C) { gl.deleteTexture(C.tab); C.tab = tableTex(d.table, C.n); } }
	else if (d.type === "levels") { const C = chunks.get(d.g); if (C) for (const L of d.levels) uploadLevel(C, L); }
	else if (d.type === "remove") { drop(chunks.get(d.g)); chunks.delete(d.g); }
	else if (d.type === "vis") visible = !!d.on;
	else if (d.type === "clear") { chunks.forEach(drop); chunks.clear(); }
	else if (d.type === "perf") { perf = !!d.on; pfN = 0; pfMs = 0; }
	else if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); }
}
function flushProbes(w, h) {
	if (!probes.length) return;
	const ids = probes.splice(0);
	try { const data = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data); const glErr = gl.getError(); const info = { chunks: chunks.size, levels: [...chunks.values()].map(C => C.levels.map(L => [L.zoom, L.lines?.nSeg ?? 0, L.fills?.count ?? 0])), glErr }; for (const id of ids) host?.post?.({ type: "pixels", id, w, h, data: id === ids[ids.length - 1] ? data : data.slice(), info }); }
	catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String(e?.message || e) }); }
}
const levelFor = (C, z) => { for (const L of C.levels) if (L.zoom >= z) return L; return C.levels[C.levels.length - 1]; };   // 段がまだ揃わない間は有る中で一番近い段
export function frame(cam, s, { w, h }) {
	if (!gl) return false;
	const t0 = perf ? performance.now() : 0;
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	if (!chunks.size || !visible) { flushProbes(w, h); return false; }
	const dpr = cam.dpr || 1, z = cam.zoom ?? 0, M = s.mvp, mvpL = new Float32Array(16), E = s.eye;
	const setCommon = (P, C) => {
		for (let i = 0; i < 12; i++) mvpL[i] = M[i];
		const o = C.origin; for (let r = 0; r < 4; r++) mvpL[12 + r] = M[r] * o[0] + M[4 + r] * o[1] + M[8 + r] * o[2] + M[12 + r];   // mvp·T(o)＝4 列目だけ（倍精度で）
		const ex = E[0] - o[0], ey = E[1] - o[1], ez = E[2] - o[2];   // 目の原点相対（f64 で引く）
		gl.uniformMatrix4fv(P.u.u_mvp, false, mvpL); gl.uniform3f(P.u.u_origin, o[0], o[1], o[2]);
		gl.uniform3f(P.u.u_eyeRel, ex, ey, ez); gl.uniform1f(P.u.u_oe, o[0] * ex + o[1] * ey + o[2] * ez);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, C.tab); gl.uniform1i(P.u.u_tab, 0); gl.uniform1i(P.u.u_tabW, C.tabW);
	};
	gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
	// 1) 面
	gl.useProgram(pFill.p);
	for (const C of chunks.values()) { const L = levelFor(C, z); if (!L?.fills) continue; setCommon(pFill, C); gl.bindVertexArray(L.fills.vao); gl.drawElements(gl.TRIANGLES, L.fills.count, gl.UNSIGNED_INT, 0); }
	// 2) 線と面の輪郭
	gl.useProgram(pLine.p); gl.uniform2f(pLine.u.u_vp, w, h); gl.uniform1f(pLine.u.u_dpr, dpr);
	for (const C of chunks.values()) { const L = levelFor(C, z); if (!L?.lines) continue; setCommon(pLine, C); gl.bindVertexArray(L.lines.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, L.lines.nSeg); }
	// 3) 点
	gl.useProgram(pPoint.p); gl.uniform1f(pPoint.u.u_dpr, dpr); gl.uniform1f(pPoint.u.u_maxPt, maxPt);
	for (const C of chunks.values()) { if (!C.points) continue; setCommon(pPoint, C); gl.bindVertexArray(C.points.vao); gl.drawArrays(gl.POINTS, 0, C.points.n); }
	gl.bindVertexArray(null);
	flushProbes(w, h);
	if (perf) { const ms = performance.now() - t0; pfMs = pfN ? pfMs + (ms - pfMs) * 0.2 : ms; if (++pfN >= 3) host?.post?.({ type: "perf", ms: pfMs, n: pfN, chunks: chunks.size }); }   // 3 フレーム目から EMA を毎フレーム
	return false;
}
export function destroy() { if (!gl) return; chunks.forEach(drop); chunks.clear(); gl.deleteProgram(pFill.p); gl.deleteProgram(pLine.p); gl.deleteProgram(pPoint.p); gl.getExtension("WEBGL_lose_context")?.loseContext(); gl = null; }
