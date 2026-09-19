// 世界の地震＝GPU 描画（レンダーワーカー内で地球・注記と同じフレームに描くオーバーレイ・#13）。
// main（quakes.js）は UI・再生・pick・札を持ち、ここへは { type:"layer" }（震源の列）と { type:"state" }（表示範囲・見せ方）を渡すだけ。
// このモジュールは依存ゼロ（worker が URL で import() する＝バンドルを跨ぐ）。同じ表（STOPS/depthColor）を main の凡例も使う。
//
// 表現の決め事
//   位置   … 震源＝震央 [経度, 緯度] から深さぶん地球の内側（列は main の worker が作る＝単位球ワールド）
//   色     … 深さ。浅い＝赤 → 橙 → 黄 → 緑 → 水色 → 深い＝青（色軸は √(深さ/700km)＝浅い側の差が見える）
//   大きさ … エネルギーの量を「球の体積」とみなす。E ∝ 10^(1.5M) ⇒ 半径 ∝ 10^(0.5M)。M6 の半径を基準に実寸で置く
//   形     … M>6 は本物の 3D 球（インスタンス描画の多面体・陰影つき・深度つき）。M≤6 は 2D スプライト（球の陰影を描いた円）
//   表示下限 … 実寸が 1px 未満の地震は最小サイズで描き、そのぶん薄くする（小さな地震は「雲」として見える）
//   透け   … 視線が地球の中を通る長さ L に応じて exp(−L/λ) で薄める＝地球の裏側は見えず、真下の深い震源は少し沈んで見える
// 契約（app.js の map.overlay）：init(canvas) / message(data) / frame(cam, camState, size) → 続きが要れば true / destroy()

export const M_SPLIT = 6;            // これより大きい（M>6）＝3D 球
export const DEPTH_MAX = 700;
export const STOPS = [   // t = √(depth/700)
	[0.00, [255, 38, 38]],     // 0 km   赤
	[0.15, [255, 48, 34]],     // 16 km  赤（浅発の大半＝10 km 前後はここ）
	[0.30, [255, 140, 26]],    // 63 km  橙
	[0.42, [255, 214, 32]],    // 123 km 黄
	[0.55, [86, 214, 96]],     // 212 km 緑
	[0.72, [30, 196, 255]],    // 363 km 水色
	[1.00, [52, 84, 255]],     // 700 km 青
];
export const depthT = d => Math.sqrt(Math.min(Math.max(d, 0), DEPTH_MAX) / DEPTH_MAX);
export function depthColor(d) {
	const t = depthT(d);
	for (let i = 1; i < STOPS.length; i++) {
		const [t1, c1] = STOPS[i];
		if (t <= t1) {
			const [t0, c0] = STOPS[i - 1], f = (t - t0) / (t1 - t0);
			return c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
		}
	}
	return STOPS[STOPS.length - 1][1];
}
// 表示の既定（main のパネルと同じ値）。main から state で上書き
export const DEFAULTS = { magMin: 2, magMax: 10, size: 1, faint: 0.22, clear: 0.6, m6km: 15 };
export const lambdaOf = clear => 0.012 + 0.28 * clear * clear;   // 透けの減衰長（ワールド単位）＝pick も同じ式

const glslStops = () => {
	const f = v => (v / 255).toFixed(4);
	let s = `vec3 depthColor(float d){ float t = sqrt(clamp(d, 0.0, ${DEPTH_MAX.toFixed(1)}) / ${DEPTH_MAX.toFixed(1)});\n`;
	for (let i = 1; i < STOPS.length; i++) {
		const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i];
		s += `  if (t <= ${t1.toFixed(3)}) return mix(vec3(${c0.map(f)}), vec3(${c1.map(f)}), (t - ${t0.toFixed(3)}) / ${(t1 - t0).toFixed(3)});\n`;
	}
	return s + `  return vec3(${STOPS[STOPS.length - 1][1].map(f)}); }\n`;
};

// ── シェーダ ─────────────────────────────────────────────────────────────────
const COMMON = `#version 300 es
precision highp float;
uniform mat4 u_mvp;
uniform vec3 u_eye;
uniform float u_focal;     // device px（距離 1 のワールド長 → px）
uniform float u_scale;     // M6 の半径（ワールド単位）
uniform float u_lambda;    // 透けの減衰長（ワールド単位）
uniform vec2 u_mag;        // 表示するマグニチュード範囲
uniform vec2 u_year;       // 表示する年の範囲（小数年）
${glslStops()}
// 視線（eye→P）が単位球の中を通る長さ → exp(-L/λ)
float seeThrough(vec3 P) {
	vec3 d = P - u_eye;
	float a = dot(d, d), b = dot(u_eye, d), c = dot(u_eye, u_eye) - 1.0;
	float disc = b * b - a * c;
	if (disc <= 0.0) return 1.0;
	float s = sqrt(disc);
	float t0 = clamp((-b - s) / a, 0.0, 1.0), t1 = clamp((-b + s) / a, 0.0, 1.0);
	return exp(-(t1 - t0) * sqrt(a) / u_lambda);
}
float radiusOf(float m) { return u_scale * pow(10.0, 0.5 * (m - 6.0)); }
bool hidden(vec3 a) { return a.x < u_mag.x || a.x > u_mag.y || a.z < u_year.x || a.z > u_year.y; }
`;

const SPRITE_VS = COMMON + `
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_attr;   // mag, depth, year
uniform float u_minPx, u_floor, u_maxPt, u_split;
out vec4 v_col;
out float v_rad;
void main() {
	vec4 off = vec4(2.0, 2.0, 2.0, 1.0);
	if (hidden(a_attr) || a_attr.x > u_split) { gl_Position = off; gl_PointSize = 0.0; return; }
	float see = seeThrough(a_pos);
	vec4 c = u_mvp * vec4(a_pos, 1.0);
	if (see < 0.015 || c.w <= 0.0) { gl_Position = off; gl_PointSize = 0.0; return; }
	float px = radiusOf(a_attr.x) * u_focal / c.w;          // 実寸の半径（device px）
	float r = clamp(max(px, u_minPx), 0.0, u_maxPt * 0.5 - 1.0);
	float a = px >= u_minPx ? 1.0 : max(u_floor, px / u_minPx);   // 表示下限に持ち上げた分だけ薄く
	gl_PointSize = 2.0 * r + 2.0;                              // +2＝縁のアンチエイリアス余白
	v_rad = r;
	v_col = vec4(depthColor(a_attr.y), a * see);
	gl_Position = c;
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
in vec4 v_col;
in float v_rad;
out vec4 o;
void main() {
	vec2 p = (gl_PointCoord * 2.0 - 1.0) * (v_rad + 1.0);   // px 単位（中心 0）
	float d = length(p);
	float cov = clamp(v_rad + 0.5 - d, 0.0, 1.0);          // 1px の縁ぼかし
	if (cov <= 0.0) discard;
	vec3 col = v_col.rgb;
	if (v_rad > 1.5) {                                       // 球の陰影（左上から光）
		vec2 q = p / v_rad;
		vec3 n = vec3(q.x, -q.y, sqrt(max(0.0, 1.0 - dot(q, q))));
		vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
		float dif = max(dot(n, L), 0.0);
		float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 28.0);
		col = col * (0.32 + 0.78 * dif) + vec3(spec * 0.45);
	}
	float a = v_col.a * cov;
	o = vec4(col * a, a);   // premultiplied
}`;

const SPHERE_VS = COMMON + `
layout(location = 0) in vec3 a_nrm;    // 単位球メッシュの頂点（＝法線）
layout(location = 1) in vec3 i_pos;    // 震源（インスタンス）
layout(location = 2) in vec3 i_attr;   // mag, depth, year
uniform float u_minPx3;
out vec3 v_n;
out vec3 v_v;
out vec4 v_col;
void main() {
	vec4 off = vec4(2.0, 2.0, 2.0, 1.0);
	if (hidden(i_attr)) { gl_Position = off; return; }
	float see = seeThrough(i_pos);
	vec4 cc = u_mvp * vec4(i_pos, 1.0);
	if (see < 0.015 || cc.w <= 0.0) { gl_Position = off; return; }
	float r = radiusOf(i_attr.x);
	float px = r * u_focal / cc.w;
	if (px < u_minPx3) r *= u_minPx3 / px;                   // 遠景でも球として読める最小サイズ
	vec3 w = i_pos + a_nrm * r;
	v_n = a_nrm;
	v_v = normalize(u_eye - w);
	v_col = vec4(depthColor(i_attr.y), see);
	gl_Position = u_mvp * vec4(w, 1.0);
}`;

const SPHERE_FS = `#version 300 es
precision highp float;
in vec3 v_n;
in vec3 v_v;
in vec4 v_col;
uniform vec3 u_up;
out vec4 o;
void main() {
	vec3 n = normalize(v_n), V = normalize(v_v);
	vec3 L = normalize(V + u_up * 0.9);                      // 視線の少し上から照らす
	float dif = max(dot(n, L), 0.0);
	float spec = pow(max(dot(n, normalize(L + V)), 0.0), 48.0);
	float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
	vec3 col = v_col.rgb * (0.28 + 0.8 * dif) + vec3(spec * 0.55) + v_col.rgb * rim * 0.35;
	float a = 0.92 * v_col.a;
	o = vec4(col * a, a);
}`;

// ── 小道具 ───────────────────────────────────────────────────────────────────
function compile(gl, vs, fs) {
	const mk = (type, src) => {
		const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + "\n" + src);
		return s;
	};
	const p = gl.createProgram();
	gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
	const u = {};
	for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
		const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name);
	}
	return { p, u };
}
function icosphere(level = 2) {
	const t = (1 + Math.sqrt(5)) / 2;
	let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
		.map(p => { const l = Math.hypot(...p); return p.map(x => x / l); });
	let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
		[3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
	for (let l = 0; l < level; l++) {
		const cache = new Map(), nf = [];
		const mid = (a, b) => {
			const k = a < b ? a + "," + b : b + "," + a;
			if (cache.has(k)) return cache.get(k);
			const p = v[a].map((x, i) => (x + v[b][i]) / 2), len = Math.hypot(...p);
			v.push(p.map(x => x / len)); cache.set(k, v.length - 1); return v.length - 1;
		};
		for (const [a, b, c] of f) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
		f = nf;
	}
	return { vtx: new Float32Array(v.flat()), idx: new Uint16Array(f.flat()) };
}

// ── 本体（worker 内のモジュール状態＝オーバーレイ 1 枚ぶん）──────────────────────
let gl = null, sprite = null, sphere = null, maxPt = 1, icoVb = null, icoIb = null, icoCount = 0, earthM = 6371000;
const layers = [];   // q → { n, nBig, bufs, spriteVao, sphereVao }
let st = { ...DEFAULTS }, range = [1967, 2100];

export function init(canvas, opts = {}) {
	gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: true, alpha: true, depth: true });
	if (!gl) throw new Error("WebGL2 is not available (quakes overlay)");
	sprite = compile(gl, SPRITE_VS, SPRITE_FS);
	sphere = compile(gl, SPHERE_VS, SPHERE_FS);
	maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
	const ico = icosphere(3); icoCount = ico.idx.length;   // 1280 面＝M9 級を画面いっぱいに寄せても角が見えない
	icoVb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, icoVb); gl.bufferData(gl.ARRAY_BUFFER, ico.vtx, gl.STATIC_DRAW);
	icoIb = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, icoIb); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ico.idx, gl.STATIC_DRAW);
	if (opts.earthM) earthM = opts.earthM;
}

function dropLayer(L) {
	if (!L) return;
	L.bufs.forEach(b => gl.deleteBuffer(b)); gl.deleteVertexArray(L.spriteVao); gl.deleteVertexArray(L.sphereVao);
}
// 層 q を差し替える（pos/attr＝マグニチュード昇順・M>6 は末尾）
function setLayer({ q, n, pos, attr }) {
	dropLayer(layers[q]);
	let k = n; while (k > 0 && attr[(k - 1) * 3] > M_SPLIT) k--;
	const posBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
	const attrBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, attrBuf); gl.bufferData(gl.ARRAY_BUFFER, attr, gl.STATIC_DRAW);
	const spriteVao = gl.createVertexArray(); gl.bindVertexArray(spriteVao);
	gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
	gl.bindBuffer(gl.ARRAY_BUFFER, attrBuf); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
	const sphereVao = gl.createVertexArray(); gl.bindVertexArray(sphereVao);
	gl.bindBuffer(gl.ARRAY_BUFFER, icoVb); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, icoIb);
	const off = k * 3 * 4;
	gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, off); gl.vertexAttribDivisor(1, 1);
	gl.bindBuffer(gl.ARRAY_BUFFER, attrBuf); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, off); gl.vertexAttribDivisor(2, 1);
	gl.bindVertexArray(null);
	layers[q] = { n, nBig: n - k, bufs: [posBuf, attrBuf], spriteVao, sphereVao };
}

export function message(d) {
	if (!gl) return;
	if (d.type === "layer") setLayer(d);
	else if (d.type === "state") { if (d.st) st = { ...st, ...d.st }; if (d.range) range = d.range; }
	else if (d.type === "clear") { layers.forEach(dropLayer); layers.length = 0; }
}

// 地球と同じフレーム・同じ cam で描く（worker の frame() が注記の後に呼ぶ）。s＝cameraState(cam, W, H)
export function frame(cam, s, { w, h }) {
	if (!gl) return false;
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
	gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
	if (!layers.some(L => L && L.n)) return false;
	const dpr = cam.dpr || 1;
	const mvp = new Float32Array(s.mvp), eye = new Float32Array(s.eye);
	const common = (u) => {
		gl.uniformMatrix4fv(u.u_mvp, false, mvp);
		gl.uniform3fv(u.u_eye, eye);
		gl.uniform1f(u.u_focal, s.focal);
		gl.uniform1f(u.u_scale, st.m6km * 1000 * st.size / earthM);
		gl.uniform1f(u.u_lambda, lambdaOf(st.clear));
		gl.uniform2f(u.u_mag, st.magMin - 1e-4, st.magMax + 1e-4);
		gl.uniform2f(u.u_year, range[0], range[1]);
	};
	gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
	// 1) M>6 の 3D 球（深度を書く）
	if (layers.some(L => L?.nBig) && st.magMax > M_SPLIT) {
		gl.useProgram(sphere.p); common(sphere.u);
		gl.uniform1f(sphere.u.u_minPx3, 2.2 * dpr);
		// 画面の「上」＝ワールドでの向き（光源用）：注視点の法線とカメラ方向から
		const up = new Float32Array([s.invMvp[4], s.invMvp[5], s.invMvp[6]]);
		const l = Math.hypot(up[0], up[1], up[2]) || 1; up[0] /= l; up[1] /= l; up[2] /= l;
		gl.uniform3fv(sphere.u.u_up, up);
		gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CW);   // mvp は x 反転（鏡像）＝巻きが逆
		gl.depthMask(true);
		for (const L of layers) if (L?.nBig) { gl.bindVertexArray(L.sphereVao); gl.drawElementsInstanced(gl.TRIANGLES, icoCount, gl.UNSIGNED_SHORT, 0, L.nBig); }
		gl.disable(gl.CULL_FACE);
	}
	// 2) M≤6 のスプライト（深度は読むだけ＝球の後ろは隠れる）
	gl.useProgram(sprite.p); common(sprite.u);
	gl.uniform1f(sprite.u.u_minPx, 1.1 * dpr);
	gl.uniform1f(sprite.u.u_floor, st.faint);
	gl.uniform1f(sprite.u.u_maxPt, maxPt);
	gl.uniform1f(sprite.u.u_split, M_SPLIT);
	gl.depthMask(false);
	for (const L of layers) if (L && L.n > L.nBig) { gl.bindVertexArray(L.spriteVao); gl.drawArrays(gl.POINTS, 0, L.n - L.nBig); }
	gl.depthMask(true);
	gl.bindVertexArray(null);
	return false;   // 自前アニメは無い＝続きは main の state 更新（再生）が起こす
}

export function destroy() {
	if (!gl) return;
	layers.forEach(dropLayer); layers.length = 0;
	gl.deleteBuffer(icoVb); gl.deleteBuffer(icoIb);
	gl.deleteProgram(sprite.p); gl.deleteProgram(sphere.p);
	gl.getExtension("WEBGL_lose_context")?.loseContext();
	gl = null;
}
