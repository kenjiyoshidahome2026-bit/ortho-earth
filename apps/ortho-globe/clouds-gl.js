// 雲（レンダーワーカー内で地球・注記と同じフレームに描くオーバーレイ・#13）。sats-gl.js／quakes-gl.js と同型。
// main（clouds.js）は静止気象衛星の赤外画像（NASA GIBS）を読み、全球の正距円筒「冷たさ」テクスチャへ詰めてタイルごとに渡す。
// ここはそれを描くだけ。このモジュールは依存ゼロ（worker が URL で import() する＝バンドルを跨ぐ）。
//
// 二つの描き方（opts.vol）
//   殻（vol=false）… 高度 alt の球殻 1 枚に貼る（試作の第 1 段・軽い）
//   高さ（vol=true・既定）… 輝度温度から雲頂の高さを出し、高度 0〜HMAX の層を視線で歩く（レイマーチ）＝体積の雲の第 1 段
//     雲頂 … 地表気温の目安 Ts(緯度)＝28−0.45·|緯度| ℃ から減率 6.5 ℃/km で (Ts−T)/6.5 km（0.5〜17 km）。実寸（誇張しない）
//     厚み … 冷たい（背の高い対流の）雲ほど雲底まで柱・薄い雲は 1 km の板（k^1.5 で混ぜる）
//     濃さ … 真上から見た不透明度が殻と同じになるよう消散係数を厚みで割る（Beer–Lambert・前から後ろへ合成）
//     陰影 … 高さの割合で上ほど明るい＋太陽の方へ 1.5 km 先を 1 点見て雲の中なら暗く（自分の影＝朝夕に凹凸が浮く）
//   どちらも：雲らしさ k＝((Ts−warm)−T)／((Ts−warm)−cold)＝地表の目安より warm 度以上冷たい所だけ雲（高緯度の冷たい地面を雲にしない）
//
// 表現の決め事（共通）
//   座標   … β 単位球ワールド（地球＝半径 1・楕円体は mvp が S を畳む）。視線の基底は ortho-core の viewRays と同式＝CPU の f64 で作って uniform
//            （invMvp を GPU で積和しない＝#46/#65 の轍）。球との交点は桁落ちなしの根の形（c＝|E|²−R² は f64 で引く）
//   隠れ   … 地球に当たる視線はそこで止める。層の外からは近い交点から、層の中（低い視点）からは目の前から歩く
//   冷たさ … テクスチャ 1 バイト（b＝(60−T℃)×1.6・0＝データ無し＝暖かい＝雲なし）。T→不透明度・高さはここ（閾値を変えても取り直し不要）
//   昼夜   … 太陽の向き（main が共通の時計の時刻で ephem/sun から）で昼＝白・夜＝暗い青灰（赤外は夜も見える＝消さずに沈める）
//   細かさ … 画素の足跡から mip の段を自分で出す（textureLod）＝経度 ±180° の継ぎ目で微分が跳ねて線が出るのを避ける
//            データの解像度を大きく超えて寄ったら薄める（ぼやけた塊で地図を塞がない）
// 契約（app.js の map.overlay）：init(canvas, opts, host) / message(data) / frame(cam, camState, size, api) → 続きが要れば true / destroy()

export const ENC = 1.6;          // 冷たさの目盛り（1 バイト＝0.625 ℃）
export const T_WARM = 60;        // b＝0 の温度（℃）＝パレットの最高温（56.9 超）より上＝データ無しは「暖かい」
export const EARTH_A = 6378137;  // β ワールドの単位（楕円体の赤道半径 m）
export const HMAX = 17000;       // 雲の層の上端（m）＝熱帯の圏界面
const STEP_M = 400, MAX_STEPS = 64;
export const VOL_RES = 0.5;     // 高さの雲は縦横この倍率の画素で描いて引き伸ばす（雲のデータは 7 km/画素＝柔らかい・画素数 1/4＝実測 2.1→約 0.5 ms 級）

const VS = `#version 300 es
out vec2 v_ndc;
void main() {
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;   // 画面を覆う三角形 1 枚
	v_ndc = p;
	gl_Position = vec4(p, 0.0, 1.0);
}`;

// 共通：uniform と、点 → 経緯度 → 輝度温度・雲らしさ
const HEAD = `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform vec3 u_F, u_X, u_Y, u_E;   // 視線 v(ndc)＝F＋x·X＋y·Y（clip w が 1 になる長さ）・目の位置（β ワールド）
uniform float u_c;                 // |E|²−R²（殻＝1＋alt/a・高さ＝層の上端 1＋HMAX/a）
uniform float u_c1;                // |E|²−1（地球）
uniform float u_rax;               // 楕円体の b/a（球＝1）：tanφ＝tanβ／rax
uniform vec3 u_sun;                // 太陽の向き（β ワールドの軸）
uniform float u_sunOn;
uniform sampler2D u_tex;
uniform vec3 u_tex3;               // (テクスチャの幅 px, 縦に覆う度数, 最大 mip 段)
uniform float u_pxX;               // 2/W
uniform vec4 u_look;               // (warm＝地表の目安より何度冷たければ雲か, cold＝真っ白の温度 ℃, ガンマ, 最大不透明度)
uniform float u_fadeLod;           // これより細かく寄ったら薄める（負の mip 段）
out vec4 o;
const float PI = 3.141592653589793, A = ${EARTH_A.toFixed(1)};
vec2 lonlat(vec3 P) { return vec2(atan(P.z, P.x), atan(P.y, u_rax * length(P.xz))); }
float lodAt(float t, vec3 v, vec3 n) {
	float inc = max(abs(dot(normalize(v), n)), 0.08);
	float foot = t * length(u_X) * u_pxX / inc;          // 画素の足跡（斜めほど伸びる）
	return log2(max(foot / (2.0 * PI / u_tex3.x), 1e-6));
}
float tempAt(vec2 ll, float lod) {                     // 輝度温度 ℃（データ無し＝${T_WARM}＝暖かい）
	vec2 uv = vec2(ll.x / (2.0 * PI) + 0.5, (0.5 * PI - ll.y) / radians(u_tex3.y));
	return ${T_WARM.toFixed(1)} - textureLod(u_tex, uv, clamp(lod, 0.0, u_tex3.z)).r * 255.0 / ${ENC.toFixed(3)};
}
float tsAt(vec2 ll) { return 28.0 - 0.45 * abs(degrees(ll.y)); }   // 地表気温の目安（℃）
float kOf(float T, float Ts) { float w = Ts - u_look.x; return clamp((w - T) / (w - u_look.y), 0.0, 1.0); }
float alphaOf(float k, float lod) {
	float al = pow(k, u_look.z) * u_look.w;
	return al * (1.0 - smoothstep(u_fadeLod - 1.5, u_fadeLod, -lod));   // データの解像度を超えて寄った＝薄める
}
float dayAt(vec3 n) { return u_sunOn > 0.5 ? smoothstep(-0.12, 0.2, dot(n, u_sun)) : 1.0; }
const vec3 NIGHT = vec3(0.30, 0.34, 0.44);
`;

// 殻 1 枚
const FS_SHELL = HEAD + `
void main() {
	vec3 v = u_F + v_ndc.x * u_X + v_ndc.y * u_Y;
	float a = dot(v, v), b = dot(u_E, v), h = b * b - a * u_c;
	float t;
	if (u_c > 0.0) {                                   // 殻の外
		if (b >= 0.0 || h < 0.0) discard;
		t = u_c / (-b + sqrt(h));                      // 近い根（桁落ちなしの形）
	} else {                                           // 殻の内＝上向きの交点。地面へ向かう視線は描かない
		if (u_c1 > 0.0 && b < 0.0 && b * b - a * u_c1 > 0.0) discard;
		t = (-b + sqrt(max(h, 0.0))) / a;
	}
	vec3 P = u_E + t * v, n = normalize(P);
	vec2 ll = lonlat(P);
	float lod = lodAt(t, v, n);
	float T = tempAt(ll, lod);
	float k = kOf(T, tsAt(ll));
	float al = alphaOf(k, lod);
	if (al < 0.004) discard;
	float day = dayAt(n);
	vec3 col = mix(NIGHT, mix(vec3(0.80, 0.83, 0.88), vec3(1.0), k), day);
	al *= mix(0.6, 1.0, day);
	o = vec4(col * al, al);   // premultiplied
}`;

// 高さのある雲（層を歩く）
const FS_VOL = HEAD + `
uniform float u_hmax;
struct Col { float top, base, k, al; };
Col column(vec2 ll, float lod) {                       // その経緯度の雲の柱（m）
	float T = tempAt(ll, lod), Ts = tsAt(ll), k = kOf(T, Ts);
	float top = clamp((Ts - T) / 6.5, 0.5, u_hmax / 1000.0) * 1000.0;
	float thick = mix(1000.0, max(top - 800.0, 1000.0), pow(k, 1.5));
	return Col(top, max(top - thick, 300.0), k, min(alphaOf(k, lod), 0.985));
}
void main() {
	vec3 v = u_F + v_ndc.x * u_X + v_ndc.y * u_Y;
	float a = dot(v, v), b = dot(u_E, v), h = b * b - a * u_c;
	float t0, t1;
	if (u_c > 0.0) {                                   // 層の上から＝近い交点〜遠い交点
		if (b >= 0.0 || h < 0.0) discard;
		float s = sqrt(h); t0 = u_c / (-b + s); t1 = (-b + s) / a;
	} else { t0 = 0.0; t1 = (-b + sqrt(max(h, 0.0))) / a; }   // 層の中から＝目の前から上端まで
	float h1 = b * b - a * u_c1;
	if (u_c1 > 0.0 && b < 0.0 && h1 > 0.0) t1 = min(t1, u_c1 / (-b + sqrt(h1)));   // 地球に当たったら止める
	if (t1 <= t0) discard;
	float vl = sqrt(a), pathM = (t1 - t0) * vl * A;
	int N = int(clamp(ceil(pathM / ${STEP_M.toFixed(1)}), 4.0, ${MAX_STEPS.toFixed(1)}));
	float dt = (t1 - t0) / float(N), dsM = dt * vl * A;
	float j = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);   // 刻みのずらし＝縞を粒に
	float Tr = 1.0; vec3 C = vec3(0.0);
	for (int i = 0; i < ${MAX_STEPS}; i++) {
		if (i >= N) break;
		float t = t0 + (float(i) + j) * dt;
		vec3 P = u_E + t * v; float r = length(P); float z = (r - 1.0) * A;
		if (z < 0.0 || z > u_hmax) continue;
		vec3 n = P / r;
		vec2 ll = lonlat(P);
		float lod = lodAt(t, v, n);
		Col c = column(ll, lod);
		if (c.al < 0.004 || z > c.top || z < c.base) continue;
		float sig = -log(1.0 - c.al) / max(c.top - c.base, 300.0);   // 真上から見た不透明度＝殻と同じ
		float aa = 1.0 - exp(-sig * dsM);
		float day = dayAt(n), fr = (z - c.base) / max(c.top - c.base, 1.0), lit = 1.0;
		if (day > 0.0) {
			// 同じ柱の中＝雲頂まで太陽の方へ通る雲の量で減衰（上ほど明るい・低い太陽ほど深く暗い）
			float mu = max(dot(n, u_sun), 0.15);
			lit = exp(-sig * 0.35 * (c.top - z) / mu);
			// 隣の柱の影＝太陽の方へ 4 km 先に自分より高い雲がある時だけ
			vec3 Q = P + u_sun * (4000.0 / A); float zq = (length(Q) - 1.0) * A;
			Col q = column(lonlat(Q), lod);
			if (q.al > 0.1 && zq < q.top && zq > q.base && q.top > c.top + 500.0) lit *= 0.6;
		}
		vec3 dayCol = vec3(0.62, 0.66, 0.74) * (0.75 + 0.25 * fr) + vec3(0.40, 0.38, 0.34) * lit;   // 空の光（青み）＋日射（暖色）
		vec3 col = mix(NIGHT, min(dayCol, vec3(1.0)), day);
		aa *= mix(0.6, 1.0, day);
		C += Tr * aa * col; Tr *= 1.0 - aa;
		if (Tr < 0.02) break;
	}
	float al = 1.0 - Tr;
	if (al < 0.004) discard;
	o = vec4(C, al);   // premultiplied（C は透過率で重み付け済み）
}`;

// 引き伸ばし（半分の解像度で描いた雲＝premultiplied を双線形で画面へ）
const FS_BLIT = `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform sampler2D u_img;
out vec4 o;
void main() { o = texture(u_img, v_ndc * 0.5 + 0.5); }`;

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

// 視線の基底（ortho-core camera.js の viewRays と同式・f64）。mvp/invMvp は列優先
function viewRays(mvp, M) {
	const g = [mvp[3], mvp[7], mvp[11]];
	const un = (x, y, z) => { const o = [0, 1, 2, 3].map(r => M[r] * x + M[4 + r] * y + M[8 + r] * z + M[12 + r]); return [o[0] / o[3], o[1] / o[3], o[2] / o[3]]; };
	const ray = (x, y) => { const a = un(x, y, 0), b = un(x, y, 1), v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], k = g[0] * v[0] + g[1] * v[1] + g[2] * v[2]; return v.map(c => c / k); };
	const F = ray(0, 0), X = ray(1, 0), Y = ray(0, 1);
	return { F, X: X.map((c, i) => c - F[i]), Y: Y.map((c, i) => c - F[i]) };
}

// ── 本体（worker 内のモジュール状態＝オーバーレイ 1 枚ぶん）──────────────────────
let gl = null, host = null, shell = null, vol = null, blit = null, vao = null, tex = null;
let fbo = null, fboTex = null, fboW = 0, fboH = 0, res = VOL_RES;
let texW = 0, texH = 0, vspan = 180, maxLod = 0, needMip = false, tiles = 0;
let sun = null, altM = 10000, useVol = true;
let look = [8, -50, 0.9, 0.92], fadeLod = 4;
let perf = false, perfN = 0, perfSum = 0;

export function init(canvas, opts = {}, h = null) {
	host = h;
	gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false });
	if (!gl) throw new Error("WebGL2 is not available (clouds overlay)");
	shell = compile(gl, VS, FS_SHELL);
	vol = compile(gl, VS, FS_VOL);
	blit = compile(gl, VS, FS_BLIT);
	vao = gl.createVertexArray();
	perf = !!opts.perf;
	style(opts);
}

function style(d) {
	if (d.alt != null) altM = d.alt;
	if (d.vol != null) useVol = !!d.vol;
	if (d.look) look = d.look;
	if (d.fadeLod != null) fadeLod = d.fadeLod;
	if (d.res != null) res = Math.max(0.25, Math.min(1, d.res));
}

// 半分の解像度の描き先（大きさが変わった時だけ作り直す）
function target(w, h) {
	if (fbo && fboW === w && fboH === h) return;
	if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(fboTex); }
	fboW = w; fboH = h;
	fboTex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, fboTex);
	gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

export function message(d) {
	if (!gl) return;
	if (d.type === "grid") {            // 全球の升目＝{ w, h, vspan }（GIBS の EPSG:4326 の段そのもの）
		if (tex) gl.deleteTexture(tex);
		texW = d.w; texH = d.h; vspan = d.vspan; tiles = 0;
		maxLod = Math.floor(Math.log2(Math.max(texW, texH)));
		tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texStorage2D(gl.TEXTURE_2D, maxLod + 1, gl.R8, texW, texH);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, texW, texH, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(texW * texH));
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		needMip = true;
	} else if (d.type === "tile") {     // 冷たさのタイル＝{ x, y, w, h, data:Uint8Array }（テクスチャの画素座標）
		if (!tex) return;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, d.x, d.y, d.w, d.h, gl.RED, gl.UNSIGNED_BYTE, d.data);
		needMip = true; tiles++;
	} else if (d.type === "sun") { sun = d.dir || null; }
	else if (d.type === "style") { style(d); }
	else if (d.type === "perf") { perf = !!d.on; perfN = perfSum = 0; }
	else if (d.type === "clear") { if (tex) gl.deleteTexture(tex); tex = null; tiles = 0; }
}

export function frame(cam, s, { w, h }, api) {
	if (!gl) return false;
	gl.viewport(0, 0, w, h);
	gl.clearColor(0, 0, 0, 0);
	gl.clear(gl.COLOR_BUFFER_BIT);
	if (!tex || !tiles) return false;
	if (needMip) { gl.bindTexture(gl.TEXTURE_2D, tex); gl.generateMipmap(gl.TEXTURE_2D); needMip = false; }
	const t0 = perf ? performance.now() : 0;
	const prog = useVol ? vol : shell, u = prog.u;
	const lw = useVol ? Math.max(1, Math.round(w * res)) : w, lh = useVol ? Math.max(1, Math.round(h * res)) : h;
	const r = viewRays(s.mvp, s.invMvp), E = s.eye;
	const R = 1 + (useVol ? HMAX : altM) / EARTH_A, ee = E[0] * E[0] + E[1] * E[1] + E[2] * E[2];
	gl.useProgram(prog.p);
	gl.uniform3fv(u.u_F, new Float32Array(r.F)); gl.uniform3fv(u.u_X, new Float32Array(r.X)); gl.uniform3fv(u.u_Y, new Float32Array(r.Y));
	gl.uniform3fv(u.u_E, new Float32Array(E));
	gl.uniform1f(u.u_c, ee - R * R); gl.uniform1f(u.u_c1, ee - 1);
	gl.uniform1f(u.u_rax, api?.rAx ?? 1);
	gl.uniform3fv(u.u_sun, new Float32Array(sun || [1, 0, 0])); gl.uniform1f(u.u_sunOn, sun ? 1 : 0);
	gl.uniform3f(u.u_tex3, texW, vspan, maxLod);
	gl.uniform1f(u.u_pxX, 2 / lw);
	gl.uniform4fv(u.u_look, new Float32Array(look));
	gl.uniform1f(u.u_fadeLod, fadeLod);
	if (u.u_hmax) gl.uniform1f(u.u_hmax, HMAX);
	gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u.u_tex, 0);
	gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	gl.disable(gl.DEPTH_TEST);
	gl.bindVertexArray(vao);
	const q = perf && tq ? gl.createQuery() : null;
	if (q) gl.beginQuery(tq.TIME_ELAPSED_EXT, q);
	if (useVol) {                          // 小さく描いて → 引き伸ばして重ねる
		target(lw, lh);
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.viewport(0, 0, lw, lh); gl.clear(gl.COLOR_BUFFER_BIT);
		gl.disable(gl.BLEND);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, w, h);
		gl.enable(gl.BLEND);
		gl.useProgram(blit.p);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fboTex); gl.uniform1i(blit.u.u_img, 0);
	}
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); tqPending.push(q); }
	gl.bindVertexArray(null);
	if (perf) measure(t0, w, h);
	return false;
}

// 計測（?perf=1）：GPU の経過時間（EXT_disjoint_timer_query_webgl2）を 30 フレーム平均で main へ。無ければ gl.finish の壁時計（目安）
let tq = null, tqPending = [];
function measure(t0, w, h) {
	const mode = useVol ? "vol" : "shell";
	const report = (ms, how) => { perfSum += ms; if (++perfN === 30) { host?.post({ type: "perf", ms: perfSum / perfN, mode, how, w, h }); perfN = perfSum = 0; } };
	tq ??= gl.getExtension("EXT_disjoint_timer_query_webgl2") || false;
	if (!tq) { gl.finish(); report(performance.now() - t0, "finish"); }
	else {
		for (let i = tqPending.length - 1; i >= 0; i--) {   // 結果の出た問い合わせを回収
			const q = tqPending[i];
			if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
			if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) report(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6, "gpu");
			gl.deleteQuery(q); tqPending.splice(i, 1);
		}
	}
	host?.requestDraw();   // 測っている間は描き続ける
}

export function destroy() {
	if (!gl) return;
	if (tex) gl.deleteTexture(tex);
	gl.deleteVertexArray(vao); gl.deleteProgram(shell.p); gl.deleteProgram(vol.p); gl.deleteProgram(blit.p);
	if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(fboTex); fbo = fboTex = null; fboW = fboH = 0; }
	gl.getExtension("WEBGL_lose_context")?.loseContext();
	gl = null; host = null; tex = null; tiles = 0; sun = null;
}
