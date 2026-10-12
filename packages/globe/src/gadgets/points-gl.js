// 汎用の点オーバーレイ（同一フレームのオーバーレイ＝map.overlay・レンダーワーカー内で地球と同じ rAF・同じ cam に描く）。
// 用途＝GeoParquet の点だけのファイル（gadgets/parquet-view.js）：列（経緯度）→ 単位球の xyz → そのまま GPU。gint も GeoPBF も経由しない。
// 契約（app.js map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) / destroy()
//   message { type:"layer", q, n, pos: Float32Array(n*3), rgba?: Uint8Array(n*4), size?: Float32Array(n), origin?: [x,y,z] }（同じ q は置き換え・rgba＝点ごとの色＝属性で色分け・size＝点ごとの半径 CSS px＝map.addData の getRadius・PR-4）
//           origin＝pos の原点（原点相対＝RTE・3D Tiles の点群 #41）＝絶対座標を float32 に通さない（寄ると 0.4m 級のガタつき）。
//           mvp×平行移動(origin) は倍精度で掛けてから float32 へ＝原点付近の精度が桁で戻る
//           ／{ type:"remove", q }／{ type:"vis", q, on }（表示だけ切替）／{ type:"style", size, color:[r,g,b,a] }（rgba の無い層の色）／{ type:"clear" }
//           検定用の { type:"probe", id }＝次の frame の後に自分の画素を host.post（{ type:"pixels", … }・t-ellparity）。描画には関与しない。
//           deck.gl 差分 PR-6（2026-10-12）：layer に f（Float32Array n＝フィルタの値）と transition（{ duration } ms＝前の層（同じ q・同じ n）から位置・色・半径を混ぜる）、
//           { type:"filter", q?, range:[lo, hi]|null }・{ type:"brush", x, y, r（CSS px）| null }・{ type:"mask", bbox, w, h, data（R8）| null }＝GPU 側で点を落とす（当たり判定も同じ）
// 当たり判定（統一 picking・deck.gl 差分 PR-1・2026-10-11）：pick(x, y, r, ctx)＝device px の点の半径 r の中で一番近い点＝{ id, q, index, distance, lngLat, properties }｜null。
//   GPU picking＝点の番号（層ごとの base＋gl_VertexID・1 から・0＝無し）を RGBA8 に焼く別パス（Gint と同じ流儀）を頼まれた時だけ FBO へ描き、(2r+1)² の窓を読む。
//   描く形は本番と同じ丸（同じ coverage で discard）＝見えている所だけ当たる。pos は CPU 側にも持つ（当たった点の経緯度を返す）。
// ⚠ 依存ゼロ（import 文なし）＝vite は ?url のファイルをそのまま置く。
const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec4 a_rgba;   // 点ごとの色（無い層は u_color）
layout(location = 2) in float a_size;  // 点ごとの半径（CSS px・無い層は u_size）
layout(location = 3) in float a_f;     // フィルタの値（getFilterValue・PR-6）
layout(location = 4) in vec3 a_pos0;   // トランジションの前の値（位置・色・半径・PR-6）
layout(location = 5) in vec4 a_rgba0;
layout(location = 6) in float a_size0;
uniform float u_perSize;   // 1＝a_size を使う
uniform float u_dpr;
uniform float u_maxPt;
uniform mat4 u_mvp;         // 層ごと＝mvp×平行移動(origin)
uniform vec3 u_origin;      // 層の原点
uniform vec3 u_eyeRel;      // eye − origin（倍精度で引いてから f32）
uniform float u_oe;         // dot(origin, eye − origin)（倍精度）
uniform float u_size;      // 半径（device px）
uniform vec4 u_color;
uniform float u_perPoint;  // 1＝a_rgba を使う
uniform vec2 u_filter; uniform float u_filterOn;          // 範囲フィルタ（DataFilterExtension 相当）
uniform vec3 u_brush;                                      // ブラシ（x, y, r・device px・r ≤ 0＝無し・BrushingExtension 相当）
uniform vec2 u_half;                                       // canvas の半分（device px）
uniform sampler2D u_mask; uniform float u_maskOn; uniform vec4 u_maskBox; uniform float u_rAx;   // マスク（MaskExtension 相当）＝経緯度 bbox に張った R8 の画像
uniform float u_t; uniform float u_trans;                  // トランジション（0..1・u_trans＝1 で a_*0 と混ぜる）
uniform vec3 u_dOrigin;                                    // 前の層の原点 − 今の原点（倍精度で引く）＝a_pos0 は前の原点相対
out vec4 v_col;
out float v_size;
void main() {
	vec3 pos = u_trans > 0.5 ? mix(a_pos0 + u_dOrigin, a_pos, u_t) : a_pos;
	vec4 col = u_perPoint > 0.5 ? (u_trans > 0.5 ? mix(a_rgba0, a_rgba, u_t) : a_rgba) : u_color;
	float sz = u_perSize > 0.5 ? (u_trans > 0.5 ? mix(a_size0, a_size, u_t) : a_size) * u_dpr : u_size;
	v_col = col; v_size = min(u_maxPt * 0.5 - 1.0, sz);
	vec4 off = vec4(2.0, 2.0, 2.0, 1.0);
	if (u_filterOn > 0.5 && (a_f < u_filter.x || a_f > u_filter.y)) { gl_Position = off; gl_PointSize = 0.0; return; }
	// 地平線の向こう（球の裏側）は描かない：dot(P, eye − P) < 0。原点相対で（絶対座標の f32 は z11 で揺れる）
	if (u_oe - dot(u_origin, pos) + dot(pos, u_eyeRel) - dot(pos, pos) < 0.0) { gl_Position = off; gl_PointSize = 0.0; return; }
	if (u_maskOn > 0.5) {   // 点の経緯度（β 単位球 → 測地）を bbox の uv に
		vec3 P = pos + u_origin; float lon = degrees(atan(P.z, P.x)), beta = asin(clamp(P.y / length(P), -1.0, 1.0)), lat = degrees(atan(tan(beta) / u_rAx));
		vec2 uv = vec2((lon - u_maskBox.x) / (u_maskBox.z - u_maskBox.x), (lat - u_maskBox.y) / (u_maskBox.w - u_maskBox.y));
		if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || texture(u_mask, uv).r < 0.5) { gl_Position = off; gl_PointSize = 0.0; return; }
	}
	vec4 cpos = u_mvp * vec4(pos, 1.0);
	if (cpos.w <= 0.0) { gl_Position = off; gl_PointSize = 0.0; return; }
	if (u_brush.z > 0.0) { vec2 scr = vec2((cpos.x / cpos.w + 1.0) * u_half.x, (1.0 - cpos.y / cpos.w) * u_half.y); if (distance(scr, u_brush.xy) > u_brush.z) { gl_Position = off; gl_PointSize = 0.0; return; } }
	gl_PointSize = v_size * 2.0 + 2.0;
	gl_Position = cpos;
}`;
const FS = `#version 300 es
precision highp float;
in vec4 v_col;   // premultiplied でない RGBA
in float v_size;
out vec4 o;
void main() {
	vec2 p = (gl_PointCoord * 2.0 - 1.0) * (v_size + 1.0);
	float cov = clamp(v_size + 0.5 - length(p), 0.0, 1.0);
	if (cov <= 0.0) discard;
	float a = v_col.a * cov;
	o = vec4(v_col.rgb * a, a);
}`;
// 当たり判定の別パス＝同じ VS に点の番号を足し（base＋gl_VertexID）、FS は番号を 4 バイトに焼く（blend 無し・coverage は本番と同じ丸）
const VS_PICK = VS.replace("out vec4 v_col;", "out vec4 v_col; flat out highp uint v_id; uniform highp uint u_base;").replace("v_col = col;", "v_col = col; v_id = u_base + uint(gl_VertexID);");
const FS_PICK = `#version 300 es
precision highp float;
flat in highp uint v_id;
in float v_size;
out vec4 o;
void main() {
	vec2 p = (gl_PointCoord * 2.0 - 1.0) * (v_size + 1.0);
	if (length(p) > v_size + 0.5) discard;
	o = vec4(float(v_id & 255u), float((v_id >> 8) & 255u), float((v_id >> 16) & 255u), float((v_id >> 24) & 255u)) / 255.0;
}`;
// 読んだ窓（RGBA8・side×side・GL の並び＝下の行が先）から中心に一番近い 0 でない番号を選ぶ（純関数・node の検定 tests/pick.mjs が読む）
export const decodeId = (r, g, b, a) => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
export function nearestId(data, side, flipY = true) {
	const c = (side - 1) / 2;
	let best = null;
	for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
		const k = (j * side + i) * 4, id = decodeId(data[k], data[k + 1], data[k + 2], data[k + 3]);
		if (!id) continue;
		const dy = flipY ? (side - 1 - j) - c : j - c, dx = i - c, d = Math.hypot(dx, dy);
		if (!best || d < best.distance) best = { id, distance: d, dx, dy };
	}
	return best;
}
let gl = null, prog = null, uni = {}, maxPt = 1;
let pickProg = null, pickUni = {}, pickFbo = null, pickTex = null, pickW = 0, pickH = 0;   // 当たり判定の別パス（頼まれた時だけ作る）
const layers = new Map();   // q → { n, buf, cbuf, sbuf, vao, perPoint, perSize, pos, origin, base }
// 層ごとの番号の底（1 から・層の点数ぶん連続）＝層が増減した時に振り直す
function rebase() { let b = 1; for (const L of layers.values()) { L.base = b; b += L.n; } }
let style = { size: 3, color: [0.9, 0.3, 0.2, 0.85] };
let brush = null;                 // { x, y, r }（CSS px）
let mask = null, maskTex = null;  // { bbox, w, h }・R8 の texture
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
	if (!gl) throw new Error("WebGL2 is not available (points overlay)");
	({ p: prog, u: uni } = compile(VS, FS));
	try { ({ p: pickProg, u: pickUni } = compile(VS_PICK, FS_PICK)); } catch (e) { pickProg = null; console.warn("[points] pick pass unavailable", e?.message); }
	maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
}
const drop = L => { if (!L) return; for (const b of [L.buf, L.cbuf, L.sbuf, L.fbuf, ...(L.bufs0 || [])]) if (b && !L.keep?.has(b)) gl.deleteBuffer(b); gl.deleteVertexArray(L.vao); L.vao = null; };
export function message(d) {
	if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
	if (!gl) return;
	if (d.type === "layer") {
		const prev = layers.get(d.q);
		const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, d.pos, gl.STATIC_DRAW);
		const vao = gl.createVertexArray(); gl.bindVertexArray(vao); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
		const attr = (loc, arr, size, type, norm) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, norm, 0, 0); return b; };
		const cbuf = d.rgba ? attr(1, d.rgba, 4, gl.UNSIGNED_BYTE, true) : (gl.disableVertexAttribArray(1), null);
		const sbuf = d.size ? attr(2, d.size, 1, gl.FLOAT, false) : (gl.disableVertexAttribArray(2), null);
		const fbuf = d.f ? attr(3, d.f, 1, gl.FLOAT, false) : (gl.disableVertexAttribArray(3), null);
		// トランジション（deck.gl の transitions 相当）＝前の層（同じ q・同じ点数）の buffer を a_*0 に繋ぎ、u_t で混ぜる。点数が違えば混ぜない
		let trans = null, bufs0 = [];
		if (d.transition && prev && prev.n === d.n && prev.vao) {
			const dur = +d.transition.duration || +d.transition || 300;
			const bind0 = (loc, b, size, type, norm) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, norm, 0, 0); bufs0.push(b); };
			bind0(4, prev.buf, 3, gl.FLOAT, false);
			if (cbuf && prev.cbuf) bind0(5, prev.cbuf, 4, gl.UNSIGNED_BYTE, true); else if (cbuf) bind0(5, cbuf, 4, gl.UNSIGNED_BYTE, true); else gl.disableVertexAttribArray(5);
			if (sbuf && prev.sbuf) bind0(6, prev.sbuf, 1, gl.FLOAT, false); else if (sbuf) bind0(6, sbuf, 1, gl.FLOAT, false); else gl.disableVertexAttribArray(6);
			const po = prev.origin || [0, 0, 0], no = d.origin || [0, 0, 0];
			trans = { start: performance.now(), dur, dOrigin: [po[0] - no[0], po[1] - no[1], po[2] - no[2]] };   // 原点は焼くごとに重心＝前の位置は前の原点相対＝差を足して今の原点相対へ
			prev.keep = new Set(bufs0);   // 前の層の buffer のうち借りた物は消さない（終わったら消す）
		} else { gl.disableVertexAttribArray(4); gl.disableVertexAttribArray(5); gl.disableVertexAttribArray(6); }
		gl.bindVertexArray(null);
		drop(prev);
		layers.set(d.q, { n: d.n, buf, cbuf, sbuf, fbuf, vao, perPoint: !!d.rgba, perSize: !!d.size, hasF: !!d.f, origin: d.origin || null, on: true, pos: d.pos, base: 0, filter: prev?.filter ?? null, trans, bufs0: trans ? bufs0.filter(b => b !== cbuf && b !== sbuf) : [] });
		rebase(); host?.requestDraw?.();
	} else if (d.type === "remove") { drop(layers.get(d.q)); layers.delete(d.q); rebase(); }
	else if (d.type === "vis") { const L = layers.get(d.q); if (L) L.on = !!d.on; }
	else if (d.type === "clear") { layers.forEach(drop); layers.clear(); rebase(); }
	else if (d.type === "style") { style = { ...style, ...d }; }
	else if (d.type === "filter") { const r = d.range ? [+d.range[0], +d.range[1]] : null; if (d.q != null) { const L = layers.get(d.q); if (L) L.filter = r; } else for (const L of layers.values()) L.filter = r; host?.requestDraw?.(); }
	else if (d.type === "brush") { brush = d.x != null && d.r > 0 ? { x: d.x, y: d.y, r: d.r } : null; host?.requestDraw?.(); }
	else if (d.type === "mask") {
		if (maskTex) { gl.deleteTexture(maskTex); maskTex = null; } mask = null;
		if (d.data && d.w && d.h) { maskTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, d.w, d.h, 0, gl.RED, gl.UNSIGNED_BYTE, d.data); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); mask = { bbox: d.bbox, w: d.w, h: d.h }; }
		host?.requestDraw?.();
	}
}
export const _state = () => ({ brush, mask: mask?.bbox ?? null, layers: [...layers].map(([q, L]) => ({ q, n: L.n, filter: L.filter, trans: !!L.trans })) });
// 検定用の画素（dbgHost.__ovPixels・t-ellparity）＝probe を受けたら、次の frame で描いた直後に readPixels して host へ（columnar の draw-gl と同じ口・premultiplied RGBA・下が先）
function answerProbes(w, h) {
	if (!probes.length) return;
	const ids = probes.splice(0);
	try { const data = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data); for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: true, data: id === ids[ids.length - 1] ? data : data.slice() }); }
	catch (e) { for (const id of ids) host?.post?.({ type: "pixels", id, error: String(e?.message || e) }); }
}
let rAxNow = 1;   // 楕円体の b/a（frame の api から・マスクの経緯度）
export function frame(cam, s, size, api) {
	if (api?.rAx) rAxNow = api.rAx;
	draw(cam, s, size);
	if (gl) answerProbes(size.w, size.h);
	return [...layers.values()].some(L => L.trans);   // トランジション中は描き続ける
}
function draw(cam, s, { w, h }) {
	if (!gl) return false;
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	if (!layers.size) return false;
	gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	drawLayers(prog, uni, s, cam.dpr || 1, false, w, h);
	return false;
}
// 本番（P＝prog）と当たり判定（P＝pickProg・u_base を層ごとに）で同じ層を同じ行列で描く
function drawLayers(P, U, s, dpr, idMode, w, h) {
	gl.useProgram(P);
	const M = s.mvp, mvpL = new Float32Array(16), mvp0 = new Float32Array(M), E = s.eye, now = performance.now();
	gl.uniform1f(U.u_size, Math.min(maxPt * 0.5 - 1, style.size * dpr)); gl.uniform1f(U.u_dpr, dpr); gl.uniform1f(U.u_maxPt, maxPt);
	gl.uniform2f(U.u_half, w / 2, h / 2);
	if (brush) gl.uniform3f(U.u_brush, brush.x * dpr, brush.y * dpr, brush.r * dpr); else gl.uniform3f(U.u_brush, 0, 0, 0);
	if (mask && maskTex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.uniform1i(U.u_mask, 0); gl.uniform1f(U.u_maskOn, 1); gl.uniform4f(U.u_maskBox, mask.bbox[0], mask.bbox[1], mask.bbox[2], mask.bbox[3]); gl.uniform1f(U.u_rAx, rAxNow || 1); } else { gl.uniform1f(U.u_maskOn, 0); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null); }   // マスク無し＝unit 0 を空に（pick の FBO の texture が残っていると「読みながら書く」＝描画が黙って捨てられる）
	if (!idMode) gl.uniform4fv(U.u_color, new Float32Array(style.color));
	for (const L of layers.values()) {
		if (!L.on) continue;
		const o = L.origin;
		if (o) {   // mvp·T(o)＝4 列目だけが変わる（倍精度で掛ける）
			for (let i = 0; i < 12; i++) mvpL[i] = M[i];
			for (let r = 0; r < 4; r++) mvpL[12 + r] = M[r] * o[0] + M[4 + r] * o[1] + M[8 + r] * o[2] + M[12 + r];
			gl.uniformMatrix4fv(U.u_mvp, false, mvpL); gl.uniform3f(U.u_origin, o[0], o[1], o[2]);
		} else { gl.uniformMatrix4fv(U.u_mvp, false, mvp0); gl.uniform3f(U.u_origin, 0, 0, 0); }
		const oo = o || [0, 0, 0], ex = E[0] - oo[0], ey = E[1] - oo[1], ez = E[2] - oo[2];
		gl.uniform3f(U.u_eyeRel, ex, ey, ez); gl.uniform1f(U.u_oe, oo[0] * ex + oo[1] * ey + oo[2] * ez);
		if (idMode) gl.uniform1ui(U.u_base, L.base);
		gl.uniform1f(U.u_filterOn, L.filter && L.hasF ? 1 : 0); if (L.filter) gl.uniform2f(U.u_filter, L.filter[0], L.filter[1]);
		if (L.trans && !idMode && now - L.trans.start >= L.trans.dur) {   // 終わり＝a_*0 を外してから借りた buffer を消す（VAO が参照したまま消すと描けなくなる）
			gl.bindVertexArray(L.vao); for (const loc of [4, 5, 6]) gl.disableVertexAttribArray(loc); gl.bindVertexArray(null);
			for (const b of L.bufs0) gl.deleteBuffer(b); L.bufs0 = []; L.trans = null;
		}
		if (L.trans) { const t = Math.min(1, (now - L.trans.start) / L.trans.dur); gl.uniform1f(U.u_t, t); gl.uniform1f(U.u_trans, 1); gl.uniform3f(U.u_dOrigin, L.trans.dOrigin[0], L.trans.dOrigin[1], L.trans.dOrigin[2]); }
		else { gl.uniform1f(U.u_trans, 0); gl.uniform1f(U.u_t, 1); }
		gl.uniform1f(U.u_perPoint, L.perPoint ? 1 : 0); gl.uniform1f(U.u_perSize, L.perSize ? 1 : 0); gl.bindVertexArray(L.vao); gl.drawArrays(gl.POINTS, 0, L.n);
	}
	gl.bindVertexArray(null);
}
// 当たり判定（統一 picking）：x, y, r＝device px（y は上が 0）。ctx＝{ cam, s, size, api }（render worker が最後に描いたフレームの物）
export function pick(x, y, r, ctx) {
	if (!gl || !pickProg || !layers.size || !ctx?.s) return null;
	const { w, h } = ctx.size, dpr = ctx.cam?.dpr || 1;
	if (pickW !== w || pickH !== h || !pickFbo) {   // FBO（RGBA8・canvas と同寸）＝寸法が変わった時だけ作り直す
		if (pickTex) gl.deleteTexture(pickTex); if (pickFbo) gl.deleteFramebuffer(pickFbo);
		pickTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, pickTex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
		pickFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTex, 0);
		pickW = w; pickH = h;
	} else gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
	gl.viewport(0, 0, w, h); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	rAxNow = ctx.api?.rAx || rAxNow;
	drawLayers(pickProg, pickUni, ctx.s, dpr, true, w, h);
	const rr = Math.max(0, Math.round(r)), side = rr * 2 + 1, x0 = Math.round(x) - rr, y0 = (h - 1 - Math.round(y)) - rr;   // GL は下が 0
	const data = new Uint8Array(side * side * 4);
	// 窓が端にかかる分は 0 のまま（canvas の外は当たらない）
	const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(w, x0 + side), cy1 = Math.min(h, y0 + side);
	if (cx1 > cx0 && cy1 > cy0) {
		const sub = new Uint8Array((cx1 - cx0) * (cy1 - cy0) * 4);
		gl.readPixels(cx0, cy0, cx1 - cx0, cy1 - cy0, gl.RGBA, gl.UNSIGNED_BYTE, sub);
		for (let j = 0; j < cy1 - cy0; j++) data.set(sub.subarray(j * (cx1 - cx0) * 4, (j + 1) * (cx1 - cx0) * 4), ((j + cy0 - y0) * side + (cx0 - x0)) * 4);
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	const best = nearestId(data, side, true);
	if (!best) return null;
	let q = null, L = null; for (const [k, v] of layers) if (best.id >= v.base && best.id < v.base + v.n) { q = k; L = v; break; }
	if (!L) return null;
	const index = best.id - L.base;
	let lngLat = null;
	if (L.pos && L.pos.length >= index * 3 + 3) {   // 単位球（楕円体＝β 空間）の xyz → 経緯度。tanφ = tanβ / rAx（rAx＝b/a・球では 1）
		const o = L.origin || [0, 0, 0], px = L.pos[index * 3] + o[0], py = L.pos[index * 3 + 1] + o[1], pz = L.pos[index * 3 + 2] + o[2];
		const rAx = ctx.api?.rAx || 1, lon = Math.atan2(pz, px) * 180 / Math.PI, beta = Math.asin(Math.max(-1, Math.min(1, py / Math.hypot(px, py, pz))));
		lngLat = [lon, Math.atan(Math.tan(beta) / rAx) * 180 / Math.PI];
	}
	return { id: best.id, q, index, distance: best.distance, lngLat, properties: { q, index } };
}
export function destroy() { if (!gl) return; layers.forEach(L => { L.keep = null; drop(L); }); layers.clear(); if (maskTex) gl.deleteTexture(maskTex); maskTex = null; mask = null; gl.deleteProgram(prog); if (pickProg) gl.deleteProgram(pickProg); if (pickTex) gl.deleteTexture(pickTex); if (pickFbo) gl.deleteFramebuffer(pickFbo); pickProg = pickTex = pickFbo = null; pickW = pickH = 0; gl.getExtension("WEBGL_lose_context")?.loseContext(); gl = null; }
