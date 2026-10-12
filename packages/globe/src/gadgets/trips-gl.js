// 軌跡のオーバーレイ（deck.gl の TripsLayer 相当・差分 PR-6・2026-10-12）＝同一フレームのオーバーレイ（render worker・WebGL2・地球と同じ rAF・同じ cam）。
// 時刻付きの折れ線を currentTime までの trailLength ぶんだけ描く（頭から尾へ薄く＝fadeTrail）。頂点は main（src/adddata.js bakeTrips）が線分ごとに 4 つ焼く＝GPU は時刻を varying で運び画素ごとに切る（頭の位置が線分の途中でも正確）。
// 契約（map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) / destroy()
//   message { type:"layer", q, nv, ni, pos, oth, side, time, id(Uint32Array), index(Uint32Array), rgba?, width?, f?, origin, trips:[{ i, lngLat, t0, t1 }] }
//           ／{ type:"time", t }（currentTime）／{ type:"style", trail, fade, width, color }／{ type:"animate", from, to, speed（時刻の単位/秒）, loop } | { type:"animate", on:false }／{ type:"clock", on }（map の共通の時計 api.time＝ms を currentTime に）
//           ／{ type:"filter", q?, range:[lo, hi] | null }（軌跡ごとの f）／{ type:"remove", q }／{ type:"vis", q, on }／{ type:"clear" }／{ type:"probe", id }
// 当たり判定（統一 picking・PR-1）：pick(x, y, r, ctx)＝軌跡の番号を RGBA8 に焼く別パス（描いている部分だけ当たる）→ { id, q, index, distance, lngLat（軌跡の始点）, properties:{ q, index, t0, t1 } }
// 地平線は FS で discard（dot(P, eye−P) を原点相対で・arcs-gl と同じ）。⚠ 依存ゼロ（import 文なし）。
const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_oth;     // 同じ線分のもう一方の端
layout(location = 2) in float a_side;   // ±1＝側・|2|＝oth は前の点
layout(location = 3) in float a_time;
layout(location = 4) in vec4 a_rgba;
layout(location = 5) in float a_w;
layout(location = 6) in highp uint a_id;
layout(location = 7) in float a_f;
uniform mat4 u_mvp; uniform vec3 u_origin; uniform vec3 u_eyeRel; uniform float u_oe;
uniform vec2 u_half; uniform float u_dpr;
uniform vec2 u_filter; uniform float u_filterOn;
out vec4 v_col; out float v_side; out float v_half; out float v_hid; out float v_time; flat out highp uint v_id;
void main() {
	v_col = a_rgba; v_time = a_time; v_id = a_id;
	vec4 off = vec4(2.0, 2.0, 2.0, 1.0);
	if (u_filterOn > 0.5 && (a_f < u_filter.x || a_f > u_filter.y)) { gl_Position = off; return; }
	v_hid = u_oe - dot(u_origin, a_pos) + dot(a_pos, u_eyeRel) - dot(a_pos, a_pos);
	float sgn = abs(a_side) > 1.5 ? -1.0 : 1.0, side = sign(a_side);
	vec4 c0 = u_mvp * vec4(a_pos, 1.0), c1 = u_mvp * vec4(a_oth, 1.0);
	if (c0.w <= 0.0) { gl_Position = off; return; }
	if (c1.w <= 0.0) c1 = c0 + vec4(1e-3, 0.0, 0.0, 0.0);
	vec2 s0 = c0.xy / c0.w * u_half, s1 = c1.xy / c1.w * u_half;
	vec2 tg = (s1 - s0) * sgn; float L = length(tg); tg = L > 1e-6 ? tg / L : vec2(1.0, 0.0);
	vec2 nrm = vec2(-tg.y, tg.x);
	float halfW = a_w * u_dpr * 0.5;
	v_half = halfW; v_side = side * (halfW + 0.5);
	gl_Position = c0; gl_Position.xy += nrm * v_side / u_half * c0.w;
}`;
const FS_HEAD = `#version 300 es
precision highp float;
in vec4 v_col; in float v_side; in float v_half; in float v_hid; in float v_time; flat in highp uint v_id;
uniform float u_time; uniform float u_trail; uniform float u_fade;
out vec4 o;
void main() {
	if (v_hid < 0.0) discard;
	float age = u_time - v_time;
	if (age < 0.0 || age > u_trail) discard;
	float cov = clamp(v_half + 0.5 - abs(v_side), 0.0, 1.0);
	if (cov <= 0.0) discard;
`;
const FS = FS_HEAD + `	float a = v_col.a * cov * (u_fade > 0.5 ? 1.0 - age / u_trail : 1.0);
	o = vec4(v_col.rgb * a, a);
}`;
const FS_PICK = FS_HEAD + `	o = vec4(float(v_id & 255u), float((v_id >> 8) & 255u), float((v_id >> 16) & 255u), float((v_id >> 24) & 255u)) / 255.0;
}`;
export const decodeId = (r, g, b, a) => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
function nearestId(data, side) {
	const c = (side - 1) / 2; let best = null;
	for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) { const k = (j * side + i) * 4, id = decodeId(data[k], data[k + 1], data[k + 2], data[k + 3]); if (!id) continue; const d = Math.hypot(i - c, (side - 1 - j) - c); if (!best || d < best.distance) best = { id, distance: d }; }
	return best;
}
let gl = null, prog = null, uni = {}, pickProg = null, pickUni = {}, pickFbo = null, pickTex = null, pickW = 0, pickH = 0;
const layers = new Map();   // q → { nv, ni, bufs, vao, has, origin, on, base, trips, filter }
function rebase() { let b = 1; for (const L of layers.values()) { L.base = b; b += L.trips.length; } }
let style = { trail: 1, fade: true, width: 2, color: [1, 0.6, 0.1, 0.9] };
let time = 0, anim = null, useClock = false, lastWall = 0;
let host = null;
const probes = [];
function compile(vs, fs) {
	const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
	const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
	const u = {}; for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm); }
	return { p, u };
}
export function init(canvas, _opts, h) {
	host = h || null;
	gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: true, alpha: true, depth: false });
	if (!gl) throw new Error("WebGL2 is not available (trips overlay)");
	({ p: prog, u: uni } = compile(VS, FS));
	try { ({ p: pickProg, u: pickUni } = compile(VS, FS_PICK)); } catch (e) { pickProg = null; console.warn("[trips] pick pass unavailable", e?.message); }
}
const drop = L => { if (!L) return; for (const b of L.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(L.vao); };
export function message(d) {
	if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
	if (!gl) return;
	if (d.type === "layer") {
		drop(layers.get(d.q));
		const vao = gl.createVertexArray(), bufs = []; gl.bindVertexArray(vao);
		const attr = (loc, arr, size, type, norm, int) => { const b = gl.createBuffer(); bufs.push(b); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); if (int) gl.vertexAttribIPointer(loc, size, type, 0, 0); else gl.vertexAttribPointer(loc, size, type, norm, 0, 0); };
		attr(0, d.pos, 3, gl.FLOAT, false); attr(1, d.oth, 3, gl.FLOAT, false); attr(2, d.side, 1, gl.FLOAT, false); attr(3, d.time, 1, gl.FLOAT, false);
		if (d.rgba) attr(4, d.rgba, 4, gl.UNSIGNED_BYTE, true); else gl.disableVertexAttribArray(4);
		if (d.width) attr(5, d.width, 1, gl.FLOAT, false); else gl.disableVertexAttribArray(5);
		attr(6, d.id, 1, gl.UNSIGNED_INT, false, true);
		if (d.f) attr(7, d.f, 1, gl.FLOAT, false); else gl.disableVertexAttribArray(7);
		const ib = gl.createBuffer(); bufs.push(ib); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.index, gl.STATIC_DRAW);
		gl.bindVertexArray(null);
		layers.set(d.q, { nv: d.nv, ni: d.ni, bufs, vao, has: { c: !!d.rgba, w: !!d.width, f: !!d.f }, origin: d.origin || null, on: true, base: 0, trips: d.trips || [], filter: null, tMin: d.tMin, tMax: d.tMax });
		rebase();
	} else if (d.type === "remove") { drop(layers.get(d.q)); layers.delete(d.q); rebase(); }
	else if (d.type === "vis") { const L = layers.get(d.q); if (L) L.on = !!d.on; }
	else if (d.type === "clear") { layers.forEach(drop); layers.clear(); rebase(); }
	else if (d.type === "style") { const { type, ...rest } = d; style = { ...style, ...rest }; }
	else if (d.type === "time") { time = +d.t || 0; anim = null; useClock = false; }
	else if (d.type === "animate") { anim = d.on === false ? null : { from: d.from, to: d.to, speed: d.speed ?? 1, loop: d.loop !== false }; if (anim) { time = anim.from; useClock = false; lastWall = 0; } }
	else if (d.type === "clock") { useClock = !!d.on; if (useClock) anim = null; }
	else if (d.type === "filter") { const r = d.range ? [+d.range[0], +d.range[1]] : null; if (d.q != null) { const L = layers.get(d.q); if (L) L.filter = r; } else for (const L of layers.values()) L.filter = r; }
	host?.requestDraw?.();
}
export const _state = () => ({ time, anim: !!anim, useClock, layers: layers.size });
function answerProbes(w, h) {
	if (!probes.length) return;
	const ids = probes.splice(0);
	try { const data = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data); for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: true, time, data: id === ids[ids.length - 1] ? data : data.slice() }); }
	catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String(e?.message || e) }); }
}
export function frame(cam, s, size, api) {
	if (!gl) return false;
	let more = false;
	if (useClock && api?.time != null) { time = api.time; more = api.clock?.rate !== 0; }
	else if (anim) { const now = performance.now(); if (lastWall) { time += (now - lastWall) / 1000 * anim.speed; if (time > anim.to) { if (anim.loop) time = anim.from + (time - anim.to) % Math.max(1e-9, anim.to - anim.from); else { time = anim.to; anim = null; } } } lastWall = now; more = !!anim; }
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.viewport(0, 0, size.w, size.h);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	if (layers.size) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); drawLayers(prog, uni, s, cam.dpr || 1, size, false); }
	answerProbes(size.w, size.h);
	return more;
}
function drawLayers(P, U, s, dpr, { w, h }, idMode) {
	gl.useProgram(P);
	const M = s.mvp, mvpL = new Float32Array(16), mvp0 = new Float32Array(M), E = s.eye;
	gl.uniform2f(U.u_half, w / 2, h / 2); gl.uniform1f(U.u_dpr, dpr);
	gl.uniform1f(U.u_time, time); gl.uniform1f(U.u_trail, Math.max(1e-9, style.trail)); gl.uniform1f(U.u_fade, style.fade ? 1 : 0);
	for (const L of layers.values()) {
		if (!L.on) continue;
		const o = L.origin;
		if (o) { for (let i = 0; i < 12; i++) mvpL[i] = M[i]; for (let r = 0; r < 4; r++) mvpL[12 + r] = M[r] * o[0] + M[4 + r] * o[1] + M[8 + r] * o[2] + M[12 + r]; gl.uniformMatrix4fv(U.u_mvp, false, mvpL); gl.uniform3f(U.u_origin, o[0], o[1], o[2]); }
		else { gl.uniformMatrix4fv(U.u_mvp, false, mvp0); gl.uniform3f(U.u_origin, 0, 0, 0); }
		const oo = o || [0, 0, 0], ex = E[0] - oo[0], ey = E[1] - oo[1], ez = E[2] - oo[2];
		gl.uniform3f(U.u_eyeRel, ex, ey, ez); gl.uniform1f(U.u_oe, oo[0] * ex + oo[1] * ey + oo[2] * ez);
		gl.uniform1f(U.u_filterOn, L.filter && L.has.f ? 1 : 0); if (L.filter) gl.uniform2f(U.u_filter, L.filter[0], L.filter[1]);
		gl.bindVertexArray(L.vao);
		if (!L.has.c) { const c = style.color; gl.vertexAttrib4f(4, c[0], c[1], c[2], c[3] ?? 1); }
		if (!L.has.w) gl.vertexAttrib1f(5, style.width);
		if (!L.has.f) gl.vertexAttrib1f(7, 0);
		gl.drawElements(gl.TRIANGLES, L.ni, gl.UNSIGNED_INT, 0);
	}
	gl.bindVertexArray(null);
}
export function pick(x, y, r, ctx) {
	if (!gl || !pickProg || !layers.size || !ctx?.s) return null;
	const { w, h } = ctx.size, dpr = ctx.cam?.dpr || 1;
	if (pickW !== w || pickH !== h || !pickFbo) {
		if (pickTex) gl.deleteTexture(pickTex); if (pickFbo) gl.deleteFramebuffer(pickFbo);
		pickTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, pickTex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
		pickFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTex, 0);
		pickW = w; pickH = h;
	} else gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
	gl.viewport(0, 0, w, h); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	drawLayers(pickProg, pickUni, ctx.s, dpr, { w, h }, true);
	const rr = Math.max(0, Math.round(r)), side = rr * 2 + 1, x0 = Math.round(x) - rr, y0 = (h - 1 - Math.round(y)) - rr;
	const data = new Uint8Array(side * side * 4);
	const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(w, x0 + side), cy1 = Math.min(h, y0 + side);
	if (cx1 > cx0 && cy1 > cy0) { const sub = new Uint8Array((cx1 - cx0) * (cy1 - cy0) * 4); gl.readPixels(cx0, cy0, cx1 - cx0, cy1 - cy0, gl.RGBA, gl.UNSIGNED_BYTE, sub); for (let j = 0; j < cy1 - cy0; j++) data.set(sub.subarray(j * (cx1 - cx0) * 4, (j + 1) * (cx1 - cx0) * 4), ((j + cy0 - y0) * side + (cx0 - x0)) * 4); }
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	const best = nearestId(data, side);
	if (!best) return null;
	// 焼いた番号＝軌跡の a_id（層の中の 1〜n）。層が複数なら描画順＝後の層が勝つので、同じ番号を持つ層のうち後の物を取る
	let q = null, L = null; for (const [k, v] of layers) if (v.on && best.id >= 1 && best.id <= v.trips.length) { q = k; L = v; }
	if (!L) return null;
	const tr = L.trips[best.id - 1];
	return { id: best.id, q, index: best.id - 1, distance: best.distance, lngLat: tr?.lngLat ?? null, properties: { q, index: best.id - 1, t0: tr?.t0, t1: tr?.t1, time } };
}
export function destroy() { if (!gl) return; layers.forEach(drop); layers.clear(); gl.deleteProgram(prog); if (pickProg) gl.deleteProgram(pickProg); if (pickTex) gl.deleteTexture(pickTex); if (pickFbo) gl.deleteFramebuffer(pickFbo); pickProg = pickTex = pickFbo = null; pickW = pickH = 0; gl.getExtension("WEBGL_lose_context")?.loseContext(); gl = null; }
