// 打ち上げ花火＝GPU 描画（レンダーワーカー内で地球・注記と同じフレームに描くオーバーレイ・#13）。シーンの深度（#47）の最初の利用者。
// main（fireworks.js）は UI・打ち上げの合図を持ち、ここへは { type:"site" }（発射地点）・{ type:"launch" }（玉の号数と色）・{ type:"clear" } を渡すだけ。
// このモジュールは依存ゼロ（worker が URL で import() する＝バンドルを跨ぐ）。玉の表（SHELLS）は main の選択肢も使う。
//
// 表現の決め事
//   実寸   … 発射地点からの ENU（東・北・上・メートル）で粒子を動かし、描く時に api.clipH の clip 座標へ線形に写す
//            （u_c0＝地点の clip・u_cE/u_cN/u_cU＝1 m あたりの clip の差＝地形リフト込みの同じ規約。float32 でも近景で 1 cm 級）
//   玉     … 号数ごとに開く直径と打ち上げ高度（日本の煙火の目安：10 号＝直径約 320 m・高度約 330 m）
//   上昇   … 重力だけ（空気抵抗なし）＝頂点で開く。上昇中は尾（小さな火の粉）を落とす
//   星     … 球状に均一に飛び、速度は減衰（k=1/s）＝約 3 秒で開く直径に達する。重力で少し垂れ、寿命の終わりで消える
//   種類   … 菊（星が尾を引く）・牡丹（尾なし・くっきり）・柳（金色・長寿命・重く垂れる）・変化（途中で色が変わる）＝KINDS
//   見え   … 加算合成（ONE, ONE）で重なるほど白く光る。星は頭＋残像 2 点（直前の位置・小さく薄く）＝動きの筋。開く瞬間は閃光（0.25 s）
//   隠れ   … シーンの深度（api.depth）で手前のビル・地形・スカイツリーの陰にある星は捨てる（discard）。深度が無い環境では隠れない
//   時計   … 共通の時計 api.time で進める（#42）＝早送り・停止・巻き戻しに追従。粒子が居る間は毎フレーム描く（frame → true）
// 契約（map.overlay）：init(canvas, opts, host) → { depth:true } / message(data) / frame(cam, camState, size, api) → 続きが要れば true / destroy()

// 玉の表（号数 → 開く直径 m・打ち上げ高度 m・星の数）。label は main が付ける（このモジュールは訳を持たない）
export const SHELLS = [
	{ go: 3, diam: 60, apex: 120, stars: 120 },
	{ go: 5, diam: 150, apex: 190, stars: 200 },
	{ go: 10, diam: 320, apex: 330, stars: 360 },
	{ go: 20, diam: 480, apex: 500, stars: 520 },
	{ go: 40, diam: 750, apex: 800, stars: 720 },
];
export const COLORS = [[1.0, 0.35, 0.25], [1.0, 0.8, 0.3], [0.4, 0.9, 0.5], [0.4, 0.7, 1.0], [0.95, 0.5, 0.95], [1.0, 1.0, 0.9]];
// 玉の種類（見え方）。label は main が付ける
export const KINDS = [
	{ key: "kiku", trail: true, life: [2.8, 4.2], gravity: 1.0, damp: 1.0 },                 // 菊＝尾を引く
	{ key: "botan", trail: false, life: [2.4, 3.6], gravity: 1.0, damp: 1.0 },               // 牡丹＝くっきり
	{ key: "yanagi", trail: true, life: [5.0, 7.0], gravity: 2.2, damp: 0.7, gold: true },   // 柳＝金色・長く垂れる
	{ key: "henka", trail: false, life: [2.8, 4.0], gravity: 1.0, damp: 1.0, change: true }, // 変化＝途中で色が変わる
];
const GOLD = [1.0, 0.78, 0.35];
const G = 9.8, DAMP = 1.0, MAX_P = 65536;
const rnd = () => Math.random();

// ── 純関数（node の検定が使う）──────────────────────────────────────────────
// 玉の上昇＝重力だけ：頂点 apex に届く初速と時間
export function launchOf(apex) { const v0 = Math.sqrt(2 * G * apex); return { v0, tApex: v0 / G }; }
// 星の初速＝減衰 k の下で半径 r（＝diam/2）に届く：r(∞)＝v/k → v＝r·k
export function starSpeedOf(diam, k = DAMP) { return (diam / 2) * k; }
// 星の位置（減衰＋重力・解析解）：p(t)＝p0 + v(1−e^{−kt})/k − g·(t − (1−e^{−kt})/k)/k
export function starPos(v, t, k = DAMP, g = 1) { const f = (1 - Math.exp(-k * t)) / k; return [v[0] * f, v[1] * f, v[2] * f - G * g * (t - f) / k]; }

// ── シェーダ ─────────────────────────────────────────────────────────────────
const VS = `#version 300 es
layout(location = 0) in vec3 a_pos;    // ENU（m）
layout(location = 1) in vec4 a_col;    // rgb・a（寿命の残り 0..1）
layout(location = 2) in float a_size;  // 直径（m）
uniform vec4 u_c0, u_cE, u_cN, u_cU;   // 地点の clip・1 m あたりの clip の差
uniform float u_focal;                 // device px
uniform float u_mPerUnit;              // 世界 1 単位＝何 m（地球の半径）
out vec4 v_col;
out float v_w;
void main() {
	vec4 c = u_c0 + u_cE * a_pos.x + u_cN * a_pos.y + u_cU * a_pos.z;
	if (c.w <= 1e-6) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; v_col = vec4(0.0); v_w = 1.0; return; }
	float px = a_size / u_mPerUnit * u_focal / c.w;   // 実寸→device px
	gl_PointSize = clamp(px, 2.0, 64.0);
	float fade = clamp(px / 2.0, 0.25, 1.0);         // 1 px 未満の星は薄く（遠景で点が塗り潰れない）
	v_col = vec4(a_col.rgb, a_col.a * fade);
	v_w = c.w;
	gl_Position = c;
}`;
const FS = glsl => `#version 300 es
precision highp float;
${glsl}
uniform vec2 u_size;
in vec4 v_col;
in float v_w;
out vec4 o;
void main() {
	float d = length(gl_PointCoord * 2.0 - 1.0);
	if (d > 1.0) discard;
	if (sceneOcclusion(gl_FragCoord.xy / u_size, v_w) > 0.5) discard;   // ビル・地形の陰（#47）
	float a = v_col.a * exp(-d * d * 3.0) * (1.0 - d);   // 中心が明るく縁へ柔らかく（発光）
	o = vec4(v_col.rgb * a, a);          // premultiplied・加算合成
}`;

function compile(gl, vs, fs) {
	const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + "\n" + src); return s; };
	const p = gl.createProgram();
	gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
	const u = {};
	for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, ""); u[name] = gl.getUniformLocation(p, name); }
	return { p, u };
}

// ── 本体（worker 内のモジュール状態＝オーバーレイ 1 枚ぶん）──────────────────────
let gl = null, host = null, prog = null, vao = null, bufPos = null, bufCol = null, bufSize = null;
let site = null;            // { lon, lat }
let earthM = 6371000;
let shells = [];            // 上昇中の玉 { t0, v0, tApex, diam, stars, col, col2, kind, trailT }
let stars = [];             // 星 { t0, x, y, z, v:[3], life, col, col2, size, kind, sparkT }
let sparks = [];            // 火の粉（玉の尾・菊の引き） { t0, x, y, z, vz, life, col }
let flashes = [];           // 開く瞬間の閃光 { t0, x, y, z, size }
let posA = new Float32Array(MAX_P * 3), colA = new Float32Array(MAX_P * 4), sizeA = new Float32Array(MAX_P);
let lastT = 0, statN = 0;

export function init(canvas, opts = {}, h = null) {
	host = h;
	if (opts.earthM) earthM = opts.earthM;
	gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false });
	if (!gl) throw new Error("WebGL2 is not available (fireworks overlay)");
	prog = compile(gl, VS, FS(h?.depthGLSL || "float sceneOcclusion(vec2 uv, float w) { return 0.0; }"));   // 深度の GLSL が無いホスト＝隠れ無し
	bufPos = gl.createBuffer(); bufCol = gl.createBuffer(); bufSize = gl.createBuffer();
	vao = gl.createVertexArray(); gl.bindVertexArray(vao);
	gl.bindBuffer(gl.ARRAY_BUFFER, bufPos); gl.bufferData(gl.ARRAY_BUFFER, posA.byteLength, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
	gl.bindBuffer(gl.ARRAY_BUFFER, bufCol); gl.bufferData(gl.ARRAY_BUFFER, colA.byteLength, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
	gl.bindBuffer(gl.ARRAY_BUFFER, bufSize); gl.bufferData(gl.ARRAY_BUFFER, sizeA.byteLength, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
	gl.bindVertexArray(null);
	return { depth: true };   // シーンの深度を申し出る（#47）
}

export function message(d) {
	if (!d) return;
	if (d.type === "site") { site = { lon: d.lon, lat: d.lat }; }
	else if (d.type === "launch") {   // { go, color?（COLORS の番号）, now（共通の時計の時刻 ms）, dx?, dy?（発射地点からのずれ m） }
		const sh = SHELLS.find(s => s.go === d.go) || SHELLS[2];
		const { v0, tApex } = launchOf(sh.apex);
		const kind = KINDS.find(k => k.key === d.kind) || KINDS[0];
		const ci = d.color != null ? d.color % COLORS.length : (Math.random() * COLORS.length) | 0;
		const col = kind.gold ? GOLD : COLORS[ci], col2 = COLORS[(ci + 2 + ((Math.random() * 3) | 0)) % COLORS.length];   // 変化の後の色＝別の色
		shells.push({ t0: d.now, v0, tApex, diam: sh.diam, stars: sh.stars, col, col2, kind, x: d.dx || 0, y: d.dy || 0, trailT: d.now });
		host?.requestDraw();
	} else if (d.type === "clear") { shells = []; stars = []; sparks = []; flashes = []; host?.requestDraw(); }
	else if (d.type === "stats") host?.post({ type: "stats", ...stats() });   // 検定・console 用＝今の粒子の数
}

// 粒子を進めて配列に詰める（now＝共通の時計の時刻 ms）。戻り＝粒子の数
function step(now) {
	let n = 0;
	const put = (x, y, z, r, g, b, a, size) => { if (n >= MAX_P) return; posA[n * 3] = x; posA[n * 3 + 1] = y; posA[n * 3 + 2] = z; colA[n * 4] = r; colA[n * 4 + 1] = g; colA[n * 4 + 2] = b; colA[n * 4 + 3] = a; sizeA[n] = size; n++; };
	// 玉＝上昇（頂点で開く）
	const keep = [];
	for (const s of shells) {
		const t = (now - s.t0) / 1000;
		if (t < 0) { keep.push(s); continue; }
		if (t >= s.tApex) {   // 開く：星を球状に均一に＋閃光
			const K = s.kind, v = starSpeedOf(s.diam, K.damp), tb = s.t0 + s.tApex * 1000, z0 = s.v0 * s.v0 / (2 * G);
			for (let i = 0; i < s.stars; i++) {
				const u = 2 * rnd() - 1, ph = 2 * Math.PI * rnd(), rr = Math.sqrt(1 - u * u), sp = v * (0.9 + 0.2 * rnd());
				stars.push({ t0: tb, x: s.x, y: s.y, z: z0, v: [rr * Math.cos(ph) * sp, rr * Math.sin(ph) * sp, u * sp], life: K.life[0] + rnd() * (K.life[1] - K.life[0]), col: s.col, col2: s.col2, size: 1.6 + s.diam / 220, kind: K, sparkT: tb });
			}
			flashes.push({ t0: tb, x: s.x, y: s.y, z: z0, size: s.diam * 0.12 });
			continue;
		}
		const z = s.v0 * t - 0.5 * G * t * t;
		put(s.x, s.y, z, 1.0, 0.85, 0.6, 0.9, 2.0);
		while (s.trailT < now) { s.trailT += 40; const tt = (s.trailT - s.t0) / 1000, zz = s.v0 * tt - 0.5 * G * tt * tt; sparks.push({ t0: s.trailT, x: s.x + (rnd() - 0.5) * 2, y: s.y + (rnd() - 0.5) * 2, z: zz, vz: -(rnd() * 8), life: 0.5 + rnd() * 0.4, col: null }); }
		keep.push(s);
	}
	shells = keep;
	// 閃光（開く瞬間・0.25 s）
	flashes = flashes.filter(f => now - f.t0 < 250);
	for (const f of flashes) { const k = (now - f.t0) / 250; put(f.x, f.y, f.z, 1.0, 0.97, 0.9, 0.9 * (1 - k), f.size * (0.6 + k)); }
	// 星＝頭＋残像 2 点（直前の位置＝動きの筋）。菊・柳は引き（火の粉）を落とす
	stars = stars.filter(st => (now - st.t0) / 1000 < st.life);
	for (const st of stars) {
		const K = st.kind, t = (now - st.t0) / 1000, k = t / st.life;
		const a = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3, tw = 0.8 + 0.2 * Math.sin(t * 23 + st.v[0]);   // 終わりに消える・少し瞬く
		const c = K.change && k > 0.5 ? st.col2 : st.col, size = st.size * (k < 0.25 ? 1.5 : 1.0);
		for (let j = 0; j < 3; j++) {   // j=0 頭・1,2 残像
			const p = starPos(st.v, Math.max(0, t - j * 0.06), K.damp, K.gravity), f = j ? 0.45 / j : 1;
			put(st.x + p[0], st.y + p[1], st.z + p[2], c[0], c[1], c[2], a * tw * f, size * (j ? 0.7 : 1));
		}
		if (K.trail) while (st.sparkT < now && t < st.life * 0.85) { st.sparkT += 90; const ts = (st.sparkT - st.t0) / 1000, p = starPos(st.v, ts, K.damp, K.gravity); sparks.push({ t0: st.sparkT, x: st.x + p[0], y: st.y + p[1], z: st.z + p[2], vz: -(2 + rnd() * 6), life: 0.6 + rnd() * 0.5, col: K.gold ? GOLD : c }); }
	}
	// 火の粉（玉の尾・引き）
	sparks = sparks.filter(sp => (now - sp.t0) / 1000 < sp.life);
	for (const sp of sparks) { const t = (now - sp.t0) / 1000, c = sp.col || [1.0, 0.6, 0.2]; put(sp.x, sp.y, sp.z + sp.vz * t, c[0], c[1], c[2], 0.55 * (1 - t / sp.life), 0.8); }
	return n;
}

// 地球と同じフレーム・同じ cam で描く（worker の frame() が注記の後に呼ぶ）
export function frame(cam, s, { w, h }, api) {
	if (!gl) return false;
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
	if (!site || !api?.clipH) return false;
	if (api.project(site.lon, site.lat)[2] < 0) return shells.length + stars.length + sparks.length > 0;   // 発射地点が地球の裏＝描かない（海面の球は深度を書かない＝f<0 で隠す）。粒子が居れば次フレームも見る
	const now = api.time ?? Date.now();
	const n = step(now); statN = n; lastT = now;
	if (!n) return false;
	// 発射地点の clip と 1 m あたりの差（東・北は経緯度で 100 m ずらして差を取る＝clip は世界座標に線形）
	const c0 = api.clipH(site.lon, site.lat, 0);
	const mDeg = 111320, dLat = 100 / mDeg, dLon = 100 / (mDeg * Math.cos(site.lat * Math.PI / 180));
	const cE = api.clipH(site.lon + dLon, site.lat, 0).map((v, i) => (v - c0[i]) / 100);
	const cN = api.clipH(site.lon, site.lat + dLat, 0).map((v, i) => (v - c0[i]) / 100);
	const cU = api.clipH(site.lon, site.lat, 100).map((v, i) => (v - c0[i]) / 100);
	gl.bindBuffer(gl.ARRAY_BUFFER, bufPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, posA, 0, n * 3);
	gl.bindBuffer(gl.ARRAY_BUFFER, bufCol); gl.bufferSubData(gl.ARRAY_BUFFER, 0, colA, 0, n * 4);
	gl.bindBuffer(gl.ARRAY_BUFFER, bufSize); gl.bufferSubData(gl.ARRAY_BUFFER, 0, sizeA, 0, n);
	gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);   // 加算合成＝重なるほど明るく（premultiplied の上に足す）
	gl.disable(gl.DEPTH_TEST);
	gl.useProgram(prog.p);
	gl.uniform4fv(prog.u.u_c0, new Float32Array(c0)); gl.uniform4fv(prog.u.u_cE, new Float32Array(cE)); gl.uniform4fv(prog.u.u_cN, new Float32Array(cN)); gl.uniform4fv(prog.u.u_cU, new Float32Array(cU));
	gl.uniform1f(prog.u.u_focal, s.focal); gl.uniform1f(prog.u.u_mPerUnit, earthM);
	gl.uniform2f(prog.u.u_size, w, h);
	if (api.depth) api.depth.bind(gl, prog.p, 3);
	else if (prog.u.u_sceneDepthOn) gl.uniform1f(prog.u.u_sceneDepthOn, 0);
	gl.bindVertexArray(vao);
	gl.drawArrays(gl.POINTS, 0, n);
	gl.bindVertexArray(null);
	return true;   // 粒子が居る間は毎フレーム
}

export const stats = () => ({ particles: statN, shells: shells.length, stars: stars.length, sparks: sparks.length, t: lastT, shellT: shells.map(sh => +((lastT - sh.t0) / 1000).toFixed(2)) });   // shellT＝各玉の経過秒（負＝時計がまだ打ち上げ前）

export function destroy() {
	if (!gl) return;
	for (const b of [bufPos, bufCol, bufSize]) gl.deleteBuffer(b);
	gl.deleteVertexArray(vao); gl.deleteProgram(prog.p);
	gl.getExtension("WEBGL_lose_context")?.loseContext();
	gl = null; host = null; shells = []; stars = []; sparks = []; flashes = [];
}
