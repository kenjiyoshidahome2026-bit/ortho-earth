// 人工衛星＝GPU 描画（レンダーワーカー内で地球・注記と同じフレームに描くオーバーレイ・#13）。quakes-gl.js と同型＝「3D の地上」。
// main（sats.js）は UI・伝播（SGP4・1 Hz）・pick・札を持ち、ここへは { type:"sats" }（位置と速度の列）・{ type:"state" }（分類の出し入れ）・
// { type:"marks" }（白縁の丸を付ける衛星）・{ type:"path" }（選択衛星の軌道）を渡すだけ。
// このモジュールは依存ゼロ（worker が URL で import() する＝バンドルを跨ぐ）。分類の表（CATS）は main の凡例も使う。
//
// 表現の決め事
//   位置   … 地球固定（ECEF）を β 単位球ワールドにした列（main が伝播時に作る＝y 北極・z 東経 90°）。
//            間のフレームは位置＋速度×経過（u_dt）で直線外挿＝1 秒で数 m の誤差（画面では 0 px）
//   色     … 分類（Starlink / 低 / 中 / 静止 / 長楕円）＝CATS。凡例で出し入れ（u_vis）
//   大きさ … 一辺 1.6〜3.2 px の四角（寄るほど少し大きく）。大きいと地球の前面が点で塗り潰れる
//   隠れ   … 視線と地球の交差で決める＝地平線の向こうでも高く上がった衛星は地球の縁の外に見える
//   畳み   … 地球の見かけの半径が MIN_EARTH_PX 未満（太陽系圏の奥）＝点が地球に団子＝描かない
//   選択   … 軌道（前後半周＝自転込みの通り道・明）・地上軌跡（淡）・真下への糸。宇宙ステーションと選択衛星は白縁の丸（名前は main の札）
//   糸     … 毎フレーム、点と同じ外挿（位置＋速度×u_dt）の先から球の法線で地表へ（main は位置を測地の緯度・経度・高さで置く＝法線の足が直下点）
//   日照   … 地球の影（円柱＝半影は無視）の中の点は暗く薄く（太陽の向き u_sun は main が共通の時計の時刻で ephem/sun から）
//   動き   … 衛星は止まらない＝描き終えたら IDLE_MS 後に host.requestDraw()（静止中は 10 fps・カメラが動けば毎フレーム）
// 契約（app.js の map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size) → 続きが要れば true / destroy()

// 分類（描く順＝配列順＝数の多い Starlink が一番下）。label は main が t() で付ける（このモジュールは訳を持たない）
export const CATS = [
	{ key: "starlink", color: [111, 157, 255] },
	{ key: "leo", color: [37, 179, 148] },
	{ key: "meo", color: [240, 154, 40] },
	{ key: "geo", color: [236, 91, 115] },
	{ key: "heo", color: [176, 124, 242] },
];
export const CAT_NONE = CATS.length;   // 伝播に失敗した衛星＝描かない
export const MIN_EARTH_PX = 14;        // 地球の見かけの半径（CSS px）がこれ未満＝畳む
export const IDLE_MS = 100;            // カメラが止まっている間の描き直し間隔
export const MARK_PX = 9;              // 白縁の丸の直径（CSS px）

// ── シェーダ ─────────────────────────────────────────────────────────────────
const COMMON = `#version 300 es
precision highp float;
uniform mat4 u_mvp;
uniform vec3 u_eye;
// 視線（eye→p）が単位球（地球）を通るか＝地球の陰
bool behindEarth(vec3 p) {
	vec3 d = p - u_eye;
	float dd = dot(d, d);
	float t = -dot(u_eye, d) / dd;
	if (t <= 0.0 || t >= 1.0) return false;
	vec3 q = u_eye + d * t;
	return dot(q, q) < 1.0;
}
`;

const POINT_VS = COMMON + `
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_vel;
layout(location = 2) in float a_cat;
uniform float u_dt;          // 伝播時刻からの経過（秒）
uniform float u_size;        // 点の一辺（device px）
uniform float u_vis[${CATS.length}];
uniform vec3 u_col[${CATS.length}];
uniform float u_alpha;
uniform float u_white;       // 1＝白で塗る（宇宙ステーションの丸）
uniform vec3 u_sun;          // 太陽の向き（ワールドの軸・単位ベクトル）
uniform float u_shade;       // 1＝地球の影を暗く描く
out vec4 v_col;
bool inShadow(vec3 p) { float d = dot(p, u_sun); return d < 0.0 && dot(p, p) - d * d < 1.0; }   // 地球の影（円柱）
void main() {
	vec4 off = vec4(2.0, 2.0, 2.0, 1.0);
	int c = int(a_cat + 0.5);
	if (c >= ${CATS.length} || u_vis[c] < 0.5) { gl_Position = off; gl_PointSize = 0.0; return; }
	vec3 p = a_pos + a_vel * u_dt;
	vec4 cc = u_mvp * vec4(p, 1.0);
	if (cc.w <= 1e-6 || behindEarth(p)) { gl_Position = off; gl_PointSize = 0.0; return; }
	gl_PointSize = u_size;
	vec3 col = u_white > 0.5 ? vec3(1.0) : u_col[c];
	float a = u_alpha;
	if (u_shade > 0.5 && inShadow(p)) { col *= u_white > 0.5 ? 0.6 : 0.45; a *= u_white > 0.5 ? 1.0 : 0.55; }   // 影の中＝暗く薄く（白縁の丸は色だけ落とす＝見失わない）
	v_col = vec4(col, a);
	gl_Position = vec4(cc.xy, 0.0, cc.w);   // z は使わない（near/far で切られない・点同士の前後も見ない）
}`;

const POINT_FS = `#version 300 es
precision highp float;
in vec4 v_col;
uniform float u_round;       // 1＝白縁の丸（gl_PointCoord で縁を描く）・0＝四角
out vec4 o;
void main() {
	vec4 c = v_col;
	if (u_round > 0.5) {
		float d = length(gl_PointCoord * 2.0 - 1.0);
		if (d > 1.0) discard;
		if (d > 0.68) c = vec4(0.08, 0.094, 0.125, 0.85);   // 縁＝rgba(20,24,32,.85)
	}
	o = vec4(c.rgb * c.a, c.a);   // premultiplied
}`;

const LINE_VS = COMMON + `
layout(location = 0) in vec3 a_pos;
uniform float u_ground;      // 1＝地表の線（手前半球判定）・0＝宙の線（視線と地球の交差）
out float v_hide;
void main() {
	vec4 cc = u_mvp * vec4(a_pos, 1.0);
	bool h = u_ground > 0.5 ? dot(a_pos, u_eye) < 1.0 : behindEarth(a_pos);
	v_hide = (h || cc.w <= 1e-6) ? 1.0 : 0.0;
	gl_Position = vec4(cc.xy, 0.0, max(cc.w, 1e-6));
}`;

const LINE_FS = `#version 300 es
precision highp float;
in float v_hide;
uniform vec4 u_lcol;         // premultiplied でない rgba
out vec4 o;
void main() {
	if (v_hide > 0.5) discard;
	o = vec4(u_lcol.rgb * u_lcol.a, u_lcol.a);
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
		const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, ""); u[name] = gl.getUniformLocation(p, name);
	}
	return { p, u };
}

// ── 本体（worker 内のモジュール状態＝オーバーレイ 1 枚ぶん）──────────────────────
let gl = null, host = null, point = null, line = null;
let n = 0, t0 = 0, posBuf = null, velBuf = null, catBuf = null, vao = null;
let markBuf = null, markStations = 0, markPick = 0;           // 白縁の丸＝要素インデックス（先頭 markStations 個＝宇宙ステーション・続く markPick 個＝選択）
let lineBuf = null, lineVao = null;                           // 選択衛星の線＝{ space, ground, plumb } を 1 本のバッファに並べる
let lines = null;                                             // { space:[off,count], ground:[off,count], plumb:[off,2], color:[r,g,b] }
let lastPos = null, lastVel = null, sel = -1, sun = null;     // 真下への糸＝選択衛星の位置と速度（CPU の写し）・日照＝太陽の向き
let vis = CATS.map(() => 1), idleT = 0;

export function init(canvas, opts = {}, h = null) {
	host = h;
	gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: true, alpha: true, depth: false });
	if (!gl) throw new Error("WebGL2 is not available (sats overlay)");
	point = compile(gl, POINT_VS, POINT_FS);
	line = compile(gl, LINE_VS, LINE_FS);
	posBuf = gl.createBuffer(); velBuf = gl.createBuffer(); catBuf = gl.createBuffer(); markBuf = gl.createBuffer();
	vao = gl.createVertexArray(); gl.bindVertexArray(vao);
	gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
	gl.bindBuffer(gl.ARRAY_BUFFER, velBuf); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
	gl.bindBuffer(gl.ARRAY_BUFFER, catBuf); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, markBuf);
	gl.bindVertexArray(null);
	lineBuf = gl.createBuffer();
	lineVao = gl.createVertexArray(); gl.bindVertexArray(lineVao);
	gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
	gl.bindVertexArray(null);
	if (opts.vis) vis = opts.vis.map(v => v ? 1 : 0);
}

export function message(d) {
	if (!gl) return;
	if (d.type === "sats") {            // 伝播の結果（1 Hz）＝位置・速度・分類（cat は分類が変わらないなら省略可）
		n = d.n; t0 = d.t0; lastPos = d.pos; lastVel = d.vel; sun = d.sun || null;
		gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, d.pos, gl.DYNAMIC_DRAW);
		gl.bindBuffer(gl.ARRAY_BUFFER, velBuf); gl.bufferData(gl.ARRAY_BUFFER, d.vel, gl.DYNAMIC_DRAW);
		if (d.cat) { gl.bindBuffer(gl.ARRAY_BUFFER, catBuf); gl.bufferData(gl.ARRAY_BUFFER, d.cat, gl.STATIC_DRAW); }
	} else if (d.type === "state") { if (d.vis) vis = d.vis.map(v => v ? 1 : 0); }
	else if (d.type === "marks") {      // 白縁の丸＝{ stations: Uint32Array, pick: Uint32Array }
		const idx = new Uint32Array([...(d.stations || []), ...(d.pick || [])]);
		markStations = (d.stations || []).length; markPick = (d.pick || []).length; sel = d.sel ?? -1;
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, markBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
	} else if (d.type === "path") {     // 選択衛星の軌道＝{ space, ground, plumb, color } か null（消す）
		if (!d.space) { lines = null; return; }
		const space = d.space, ground = d.ground || new Float32Array(0);
		const all = new Float32Array(space.length + ground.length + 6);   // 末尾 2 点＝真下への糸（frame が毎フレーム書く）
		all.set(space, 0); all.set(ground, space.length);
		lines = { space: [0, space.length / 3], ground: [space.length / 3, ground.length / 3], plumb: [(space.length + ground.length) / 3, 2], color: d.color || [1, 1, 1] };
		gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf); gl.bufferData(gl.ARRAY_BUFFER, all, gl.DYNAMIC_DRAW);
	} else if (d.type === "clear") { n = 0; lines = null; markStations = markPick = 0; }
}
// 真下への糸＝点と同じ外挿の先 → 球の法線で地表（単位球）へ。点を出していない衛星（打ち上げ前・伝播失敗＝NaN）は引かない
function plumbAt(dt) {
	if (sel < 0 || !lastPos || sel >= n) return null;
	const i = sel * 3, x = lastPos[i] + lastVel[i] * dt, y = lastPos[i + 1] + lastVel[i + 1] * dt, z = lastPos[i + 2] + lastVel[i + 2] * dt, r = Math.hypot(x, y, z);
	return Number.isFinite(r) && r > 1 ? Float32Array.of(x, y, z, x / r, y / r, z / r) : null;
}

// 地球と同じフレーム・同じ cam で描く（worker の frame() が注記の後に呼ぶ）。s＝cameraState(cam, W, H)
export function frame(cam, s, { w, h }, api) {
	if (!gl) return false;
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0);
	gl.clear(gl.COLOR_BUFFER_BIT);
	if (!n) return false;
	const dpr = cam.dpr || 1, E = s.eye, ee = E[0] * E[0] + E[1] * E[1] + E[2] * E[2];
	const earthPx = s.focal / dpr / Math.sqrt(Math.max(ee - 1, 1e-12));   // 地球の見かけの半径（CSS px）
	if (earthPx < MIN_EARTH_PX) return false;                              // 太陽系圏の奥＝畳む（戻れば次のカメラ移動で描く）
	const dt = Math.max(-30, Math.min(30, ((api?.time ?? Date.now()) - t0) / 1000));   // api.time＝共通の時計の時刻（#42）。外挿は ±30 秒まで（sats.js の DT_MAX と同じ）
	const mvp = new Float32Array(s.mvp), eye = new Float32Array(E);
	const r = 0.8 + Math.min(0.8, earthPx / 1200);                         // 点の半幅（CSS px）＝寄るほど少し大きく
	gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	gl.disable(gl.DEPTH_TEST);

	// 1) 全機の点（分類色の四角）
	gl.useProgram(point.p);
	gl.uniformMatrix4fv(point.u.u_mvp, false, mvp); gl.uniform3fv(point.u.u_eye, eye);
	gl.uniform1f(point.u.u_dt, dt);
	gl.uniform1fv(point.u.u_vis, new Float32Array(vis));
	gl.uniform3fv(point.u.u_col, new Float32Array(CATS.flatMap(c => c.color.map(v => v / 255))));
	gl.uniform1f(point.u.u_size, 2 * r * dpr); gl.uniform1f(point.u.u_alpha, 0.8); gl.uniform1f(point.u.u_white, 0); gl.uniform1f(point.u.u_round, 0);
	gl.uniform3fv(point.u.u_sun, new Float32Array(sun || [1, 0, 0])); gl.uniform1f(point.u.u_shade, sun ? 1 : 0);
	gl.bindVertexArray(vao);
	gl.drawArrays(gl.POINTS, 0, n);

	// 2) 選択衛星の線（点の上に引く＝地球の前面は 1 万点で埋まる・下に敷くと沈んで見えない）
	if (lines) {
		gl.useProgram(line.p);
		gl.uniformMatrix4fv(line.u.u_mvp, false, mvp); gl.uniform3fv(line.u.u_eye, eye);
		gl.bindVertexArray(lineVao);
		const [cr, cg, cb] = lines.color;
		if (lines.ground[1] > 1) { gl.uniform1f(line.u.u_ground, 1); gl.uniform4f(line.u.u_lcol, cr, cg, cb, 0.35); gl.drawArrays(gl.LINE_STRIP, lines.ground[0], lines.ground[1]); }   // 地上軌跡
		gl.uniform1f(line.u.u_ground, 0);
		if (lines.space[1] > 1) { gl.uniform4f(line.u.u_lcol, cr, cg, cb, 0.85); gl.drawArrays(gl.LINE_STRIP, lines.space[0], lines.space[1]); }   // 宙の通り道
		const pl = plumbAt(dt);   // 真下への糸（毎フレーム＝点と一緒に動く）
		if (pl) { gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf); gl.bufferSubData(gl.ARRAY_BUFFER, lines.plumb[0] * 12, pl); gl.uniform4f(line.u.u_lcol, cr, cg, cb, 0.5); gl.drawArrays(gl.LINES, lines.plumb[0], 2); }
		gl.bindVertexArray(vao);
	}

	// 3) 白縁の丸＝宇宙ステーション（白）と選択衛星（分類色）。名前は main の札
	if (markStations + markPick) {
		gl.useProgram(point.p);
		gl.uniform1f(point.u.u_size, MARK_PX * dpr); gl.uniform1f(point.u.u_alpha, 1); gl.uniform1f(point.u.u_round, 1);
		if (markStations) { gl.uniform1f(point.u.u_white, 1); gl.drawElements(gl.POINTS, markStations, gl.UNSIGNED_INT, 0); }
		if (markPick) { gl.uniform1f(point.u.u_white, 0); gl.drawElements(gl.POINTS, markPick, gl.UNSIGNED_INT, markStations * 4); }
	}
	gl.bindVertexArray(null);
	// 衛星は動き続ける＝静止中も IDLE_MS おきに描き直す（カメラが動けば毎フレーム来る）
	if (host && !idleT) idleT = setTimeout(() => { idleT = 0; host.requestDraw(); }, IDLE_MS);
	return false;
}

export function destroy() {
	if (idleT) { clearTimeout(idleT); idleT = 0; }
	if (!gl) return;
	for (const b of [posBuf, velBuf, catBuf, markBuf, lineBuf]) gl.deleteBuffer(b);
	gl.deleteVertexArray(vao); gl.deleteVertexArray(lineVao);
	gl.deleteProgram(point.p); gl.deleteProgram(line.p);
	gl.getExtension("WEBGL_lose_context")?.loseContext();
	gl = null; host = null; n = 0; lines = null; lastPos = lastVel = sun = null; sel = -1;
}
