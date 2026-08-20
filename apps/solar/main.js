// ortho-solar — 地動説の劇場：太陽系の実スケール3D。世界座標＝日心黄道J2000（単位AU）。
// 設計の芯（ortho-japan からの移植思想）：
//  - RTE＝絶対座標を f32 に通さない：CPU(f64)でカメラ相対化してから GPU へ（globe-local-mesh-RTE と同族）
//  - 実スケール・誇張なし：軌道も半径も本物。ただし見えなくなる惑星は「最小ピクセル径クランプ」で
//    点として残す（far-DB のランドマークと同じ思想＝誇張でなく可視性の下駄）
//  - 依存ゼロ WebGL2 直書き・恒星は bucket の stars.6（ortho-japan と同じ星表）
//  - 対数深度バッファ：惑星表面(1e-7AU)〜海王星軌道(60AU)を1パスで
import { createGeopbf, geopbf } from "geopbf";
import { nativeBucket } from "native-bucket";
import { BODIES, byId, bodyPos, orientation, orbitPoints, moonOrbitPoints, jcT, eqToEcl, AU_KM, LIGHT_MIN_PER_AU, D2R } from "ephem";   // packages/ephem へ昇格（japan太陽系圏と共用）

const canvas = document.getElementById("c");
const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
if (!gl) { document.getElementById("nogl").style.display = "grid"; throw new Error("WebGL2 unavailable"); }

// ---- 言語：?lang=ja で日本語・?lang=en で英語に固定。無指定はブラウザ既定に従う（ortho-japan からの導線は ?lang=ja つき） ----
// 文言の原本は英語（index.html の本文と、このファイルの英語リテラル）。日本語は data-ja / data-ja-title と
// 下の JA 分岐に併記＝辞書ファイルを持たない＝原文と訳が離れて片方だけ腐る事故が起きない。
const LANG_Q = new URLSearchParams(location.search).get("lang");
const JA = LANG_Q ? /^ja/i.test(LANG_Q) : /^ja/i.test(navigator.language || "");
if (JA) {
	document.documentElement.lang = "ja";
	document.title = "ortho-solar — 太陽系、地動説で";
	for (const el of document.querySelectorAll("[data-ja]")) el.textContent = el.dataset.ja;
	for (const el of document.querySelectorAll("[data-ja-title]")) el.title = el.dataset.jaTitle;
}
const NAME_JA = { sun: "太陽", mercury: "水星", venus: "金星", earth: "地球", moon: "月", mars: "火星",
	jupiter: "木星", saturn: "土星", uranus: "天王星", neptune: "海王星", pluto: "冥王星" };   // ortho-japan solarsky.js と同じ台帳
const NOTE_JA = { "Dwarf planet": "準惑星" };
const bName = b => JA ? (NAME_JA[b.id] || b.name) : b.name;

// ---- 時刻機械：simTime(ms) と速度（実1秒あたりのシミュレート秒）。JPL 要素の有効期間でクランプ ----
const T_MIN = Date.UTC(1800, 0, 1), T_MAX = Date.UTC(2049, 11, 31);
// 速度は符号つき段位 speedL ∈ [-8, +8]：0=停止・正=順行・負=逆行。◀◀は停止を通り越して
// そのまま逆再生へ＝「過去へ戻りたい→◀◀」の直感が一手で通る（初版の±反転ボタンは廃止）
let simTime = Date.now(), speedL = 1, lastPlayL = 5;
const SPEEDS = [
	{ v: 0, label: "Paused", ja: "停止中" }, { v: 1, label: "Real time", neg: "1 sec/s", ja: "実時間", jaNeg: "1秒/秒" },
	{ v: 60, label: "1 min/s", ja: "1分/秒" }, { v: 3600, label: "1 hour/s", ja: "1時間/秒" },
	{ v: 21600, label: "6 hours/s", ja: "6時間/秒" }, { v: 86400, label: "1 day/s", ja: "1日/秒" },
	{ v: 864000, label: "10 days/s", ja: "10日/秒" }, { v: 2592000, label: "1 month/s", ja: "1か月/秒" },
	{ v: 31557600, label: "1 year/s", ja: "1年/秒" },
];
const simDate = () => new Date(simTime);

// ---- カメラ：焦点天体を球面座標で周回（yaw/pitch/dist）。焦点は天体と一緒に動く＝時を回すと追走 ----
const cam = { focus: "sun", yaw: -60 * D2R, pitch: 22 * D2R, dist: 26, fovy: 45 * D2R };
const OVERVIEW_DIST = 26;   // Sunボタン＝太陽系全景（土星軌道まで入る）
let camPos = [0, 0, 26], viewR = null;   // 毎フレーム更新（f64）
let flight = null;   // {t0,dur, fromFocus,toFocus, fromD,toD} 焦点間フライト（800ms・log補間）

const v3 = { sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], len: a => Math.hypot(a[0], a[1], a[2]) };
function focusPos(id, date) { return bodyPos(id, date); }
function updateCamera(date) {
	let F = focusPos(cam.focus, date), d = cam.dist;
	if (flight) {   // フライト中＝焦点位置と距離を同時補間（位置は生きた天体位置で毎フレーム評価）
		const k = Math.min(1, (performance.now() - flight.t0) / flight.dur);
		const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;   // easeInOutCubic
		const A = focusPos(flight.fromFocus, date);
		F = [A[0] + (F[0] - A[0]) * e, A[1] + (F[1] - A[1]) * e, A[2] + (F[2] - A[2]) * e];
		d = Math.exp(Math.log(flight.fromD) + (Math.log(flight.toD) - Math.log(flight.fromD)) * e);
		if (k >= 1) { flight = null; cam.dist = d; }
	}
	const cp = Math.cos(cam.pitch), off = [d * cp * Math.cos(cam.yaw), d * cp * Math.sin(cam.yaw), d * Math.sin(cam.pitch)];
	camPos = [F[0] + off[0], F[1] + off[1], F[2] + off[2]];
	// 視線基底（前=−z）。up＝黄道北。行優先3行＝right/up/back
	const f = [-off[0] / d, -off[1] / d, -off[2] / d];
	let r = [f[1], -f[0], 0]; const rl = Math.hypot(r[0], r[1]) || 1; r = [r[0] / rl, r[1] / rl, 0];
	const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
	viewR = [r, u, [-f[0], -f[1], -f[2]]];
}
function flyTo(id) {
	const b = byId[id];
	// 近景＝半径の9倍＝天体の直径が画面高の約27%。旧5.5倍は45%＝寄りすぎで、土星は環（半径2.33R）の
	// 半角25°が視野半角22.5°を越えて上下が切れていた（9倍なら15°＝環まで余白ごと収まる）。
	// 手でのドリー下限（focusMinDist＝半径1.1倍）はそのまま＝寄りたければ地表まで寄れる
	const near = Math.max(b.radiusAU * 9, b.radiusAU + 2e-7);
	// 太陽だけ二段：初手は太陽系の全景（＝この劇場のホーム）、全景で見ている時にもう一度押すと太陽そのものの近景へ。
	// 近景でもう一度押せば全景へ戻る＝押すたび行き来する一つのボタン（チップ・ラベル・天体クリックの全入口で同じ）。
	const atOverview = cam.focus === "sun" && (flight ? flight.toD : cam.dist) > near * 4;
	const toD = id === "sun" ? (atOverview ? near : OVERVIEW_DIST) : near;
	flight = { t0: performance.now(), dur: 900, fromFocus: cam.focus, toFocus: id, fromD: flight ? flight.toD : cam.dist, toD };
	cam.focus = id; cam.dist = toD;
	if (id !== "sun") {   // 昼面側に着地（真っ黒な夜面とにらめっこしない）：太陽方向+30°の斜光＝陰影が立つ
		const p = bodyPos(id, simDate());
		cam.yaw = Math.atan2(-p[1], -p[0]) + 30 * D2R;
		cam.pitch = Math.max(8 * D2R, Math.min(35 * D2R, cam.pitch));
	}
	document.querySelectorAll("#chips button").forEach(el => el.classList.toggle("on", el.dataset.id === id));
	writeHash();
}

// ---- GL 基盤 ----
const LOG_FAR = 200;   // 対数深度の far（AU）
const logC = 2 / Math.log2(LOG_FAR + 1);
const LOGZ = `P.z = (log2(max(P.w + 1.0, 1e-9)) * u_logC - 1.0) * P.w;`;
function prog(vs, fs) {
	const mk = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
		if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o) + "\n" + s); return o; };
	const p = gl.createProgram();
	gl.attachShader(p, mk(gl.VERTEX_SHADER, "#version 300 es\nprecision highp float;\n" + vs));
	gl.attachShader(p, mk(gl.FRAGMENT_SHADER, "#version 300 es\nprecision highp float;\n" + fs));
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
	const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
	for (let i = 0; i < n; i++) { const inf = gl.getActiveUniform(p, i); u[inf.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, inf.name); }
	return { p, u };
}
// 球（テクスチャ+ランバート／emissive）。u_model＝向き×半径、u_trans＝カメラ相対位置
const sphereP = prog(`
	in vec3 a_pos; in vec2 a_uv;
	uniform mat3 u_model; uniform vec3 u_trans; uniform mat4 u_view, u_proj; uniform float u_logC;
	out vec2 v_uv; out vec3 v_n;
	void main() {
		vec3 w = u_model * a_pos + u_trans;
		v_uv = a_uv; v_n = u_model * a_pos;
		vec4 P = u_proj * (u_view * vec4(w, 1.0));
		${LOGZ}
		gl_Position = P;
	}`, `
	uniform sampler2D u_tex; uniform sampler2D u_night;
	uniform vec3 u_sun; uniform float u_emiss; uniform float u_cloud; uniform float u_hasNight;
	in vec2 v_uv; in vec3 v_n; out vec4 o;
	void main() {
		vec4 t = texture(u_tex, v_uv);
		float dl = dot(normalize(v_n), u_sun);
		float l = mix(clamp(dl * 1.1, 0.0, 1.0) * 0.94 + 0.05, 1.0, u_emiss);
		vec3 c = t.rgb * l;
		// 夜面の街明かり（地球のみ u_hasNight=1）：昼夜境界 dl=0 の外側で立ち上げて加算＝影に入った側に灯が点る。
		// 加算なのは街明かり自体が光源だから（反射光の l を掛けない）。境界の幅 0.08→-0.10 は薄明の帯の見立て
		c += texture(u_night, v_uv).rgb * (smoothstep(0.08, -0.10, dl) * u_hasNight);
		// u_cloud=1（地球の雲殻）＝白黒の雲図の輝度をそのままアルファに＝薄い雲は薄く抜ける。
		// 通常の球は u_cloud=0＝不透明（既定値0のまま＝他の天体は何も変わらない）
		float a = mix(1.0, max(max(t.r, t.g), t.b), u_cloud);
		o = vec4(c, a);
	}`);
// 土星の環（平板アニュラス・radial UV・両面）。透明部は discard＝深度も正しく抜く
const ringP = prog(`
	in vec2 a_pos; in float a_u;
	uniform mat3 u_model; uniform vec3 u_trans; uniform mat4 u_view, u_proj; uniform float u_logC;
	out float v_u;
	void main() {
		vec3 w = u_model * vec3(a_pos, 0.0) + u_trans;
		v_u = a_u;
		vec4 P = u_proj * (u_view * vec4(w, 1.0));
		${LOGZ}
		gl_Position = P;
	}`, `
	uniform sampler2D u_tex; uniform float u_light;
	in float v_u; out vec4 o;
	void main() {
		vec4 c = texture(u_tex, vec2(v_u, 0.5));
		if (c.a < 0.05) discard;
		o = vec4(c.rgb * u_light, c.a);
	}`);
// 軌道線（絶対AU頂点→シェーダ内でカメラ相対化）
const lineP = prog(`
	in vec3 a_pos;
	uniform vec3 u_camPos; uniform mat4 u_view, u_proj; uniform float u_logC;
	void main() {
		vec4 P = u_proj * (u_view * vec4(a_pos - u_camPos, 1.0));
		${LOGZ}
		gl_Position = P;
	}`, `
	uniform vec4 u_color; out vec4 o;
	void main() { o = u_color; }`);
// 恒星（無限遠天球＝平行移動を無視・80AUの殻に置く）
const starP = prog(`
	in vec3 a_pos; in vec3 a_col; in float a_size; in float a_bright;
	uniform mat4 u_view, u_proj; uniform float u_logC;
	out vec3 v_col; out float v_b;
	void main() {
		vec3 v = mat3(u_view) * (a_pos * 80.0);
		v_col = a_col; v_b = a_bright;
		vec4 P = u_proj * vec4(v, 1.0);
		${LOGZ}
		gl_Position = P;
		gl_PointSize = a_size;
	}`, `
	in vec3 v_col; in float v_b; out vec4 o;
	void main() {
		float d = length(gl_PointCoord - 0.5) * 2.0;
		float a = smoothstep(1.0, 0.25, d) * v_b;
		o = vec4(v_col * a, a);
	}`);
// 太陽グロー（ビルボード・加算）
const glowP = prog(`
	in vec2 a_corner;
	uniform vec3 u_center; uniform float u_size; uniform mat4 u_view, u_proj; uniform float u_logC;
	out vec2 v_c;
	void main() {
		vec3 v = mat3(u_view) * u_center;
		v.xy += a_corner * u_size;
		v_c = a_corner;
		vec4 P = u_proj * vec4(v, 1.0);
		${LOGZ}
		gl_Position = P;
	}`, `
	in vec2 v_c; out vec4 o;
	void main() {
		float r = length(v_c);
		float a = exp(-r * 4.5) * 1.4;
		o = vec4(vec3(1.0, 0.87, 0.6) * a, 0.0);
	}`);

// ---- メッシュ ----
function buf(target, data) { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; }
// UV球（96×48）：v=0が北極（画像の上端）・u=0が経度180°W＝正距円筒テクスチャの標準
const sphere = (() => {
	const NX = 96, NY = 48, pos = [], uv = [], idx = [];
	for (let iy = 0; iy <= NY; iy++) {
		const lat = Math.PI / 2 - iy / NY * Math.PI, cl = Math.cos(lat);
		for (let ix = 0; ix <= NX; ix++) {
			const lon = -Math.PI + ix / NX * 2 * Math.PI;
			pos.push(cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat));
			uv.push(ix / NX, iy / NY);
		}
	}
	for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) {
		const a = iy * (NX + 1) + ix, b = a + NX + 1;
		idx.push(a, b, a + 1, a + 1, b, b + 1);
	}
	const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
	buf(gl.ARRAY_BUFFER, new Float32Array(pos)); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
	buf(gl.ARRAY_BUFFER, new Float32Array(uv)); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
	buf(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx));
	return { vao, n: idx.length };
})();
// 環アニュラス（128分割・2三角形帯）。座標は惑星半径単位＝u_model の半径スケールで実寸へ
function ringMesh(inner, outer) {
	const N = 128, pos = [], us = [];
	for (let i = 0; i <= N; i++) {
		const t = i / N * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
		pos.push(c * inner, s * inner, c * outer, s * outer); us.push(0, 1);
	}
	const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
	buf(gl.ARRAY_BUFFER, new Float32Array(pos)); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	buf(gl.ARRAY_BUFFER, new Float32Array(us)); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
	return { vao, n: (N + 1) * 2 };
}
const glowMesh = (() => {
	const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
	buf(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
	gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	return vao;
})();
// 軌道線 VBO（動的）：惑星ごとに保持。要素は epoch から2年ずれたら焼き直し
const orbitVbo = {};
function lineVao(data) {
	const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
	const b = buf(gl.ARRAY_BUFFER, data);
	gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
	return { vao, b, n: data.length / 3 };
}
function ensureOrbit(id, date) {
	const T = jcT(date);
	let o = orbitVbo[id];
	if (o && Math.abs(T - o.T) < 0.02) return o;   // 2年キャッシュ
	const pts = orbitPoints(id, T);
	if (!o) { o = lineVao(pts); orbitVbo[id] = o; }
	else { gl.bindBuffer(gl.ARRAY_BUFFER, o.b); gl.bufferData(gl.ARRAY_BUFFER, pts, gl.STATIC_DRAW); }
	o.T = T;
	return o;
}
let moonOrbit = null, moonOrbitT = -1;
function ensureMoonOrbit(date) {
	if (moonOrbit && Math.abs(date.getTime() - moonOrbitT) < 216e5) return moonOrbit;   // 6時間キャッシュ
	const pts = moonOrbitPoints(date);
	if (!moonOrbit) moonOrbit = lineVao(pts);
	else { gl.bindBuffer(gl.ARRAY_BUFFER, moonOrbit.b); gl.bufferData(gl.ARRAY_BUFFER, pts, gl.STATIC_DRAW); }
	moonOrbitT = date.getTime();
	return moonOrbit;
}

// ---- テクスチャ（遅延ロード：まず1pxの天体色→画像が来たら差し替え） ----
function makeTex(color) {
	const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
		new Uint8Array([color[0] * 255, color[1] * 255, color[2] * 255, 255]));
	return t;
}
const textures = {};
for (const b of BODIES) {
	textures[b.id] = makeTex(b.color);
	const img = new Image();
	img.onload = () => {
		gl.bindTexture(gl.TEXTURE_2D, textures[b.id]);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
		gl.generateMipmap(gl.TEXTURE_2D);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
		needsDraw = true;
	};
	img.src = "tex/" + b.tex;
	if (b.ring) {
		b.ringTex = makeTex([0.8, 0.75, 0.65]);
		b.ringMesh = ringMesh(b.ring.inner, b.ring.outer);
		const ri = new Image();
		ri.onload = () => {
			gl.bindTexture(gl.TEXTURE_2D, b.ringTex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ri);
			gl.generateMipmap(gl.TEXTURE_2D);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			needsDraw = true;
		};
		ri.src = "tex/" + b.ring.tex;
	}
	// 地球の追加2枚（雲殻・夜の街明かり）。届くまで殻は描かず・街明かりは消灯＝読み込み途中でも嘘にならない
	for (const [key, slot] of [["clouds", "cloudTex"], ["night", "nightTex"]]) {
		if (!b[key]) continue;
		const im = new Image();
		im.onload = () => {
			b[slot] = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, b[slot]);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
			gl.generateMipmap(gl.TEXTURE_2D);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
			needsDraw = true;
		};
		im.src = "tex/" + b[key];
	}
}
const blackTex = makeTex([0, 0, 0]);   // ユニット1の既定＝街明かりを持たない天体でも未バインドを踏まない

// ---- 恒星：bucket の stars.6（RA/Dec・等級・B-V）→黄道系単位ベクトル＋色＋点径（ortho-japan と同式） ----
let starVao = null, starN = 0;
const bvColor = v => v < -0.3 ? [0.70, 0.78, 1] : v < 0.0 ? [0.85, 0.89, 1] : v < 0.3 ? [0.97, 0.98, 1] : v < 0.6 ? [1, 0.97, 0.94] :
	v < 0.8 ? [1, 0.95, 0.78] : v < 1.1 ? [1, 0.88, 0.71] : v < 1.4 ? [1, 0.80, 0.60] : [1, 0.67, 0.57];
(async () => {
	try {
		createGeopbf("https://api.ortho-earth.com", { bucket: nativeBucket });   // ortho-japan と同じ bucket 基盤（読み出しキー不要）
		const pbf = await geopbf("stars.6", { gint: false });
		const fs = pbf?.geojson?.features; if (!fs) return;
		const dpr = Math.min(2, devicePixelRatio || 1);
		const data = new Float32Array(fs.length * 8);
		for (let i = 0; i < fs.length; i++) {
			const { mag, bv } = fs[i].properties, [ra, dec] = fs[i].geometry.coordinates;
			const p = eqToEcl(ra, dec), c = bvColor(bv);
			data.set([p[0], p[1], p[2], c[0], c[1], c[2],
				Math.max(1.5, (9 - mag) * 0.4 * dpr), Math.max(0, 1 - mag / 8)], i * 8);
		}
		const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
		buf(gl.ARRAY_BUFFER, data);
		const S = 32;
		gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
		gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, S, 12);
		gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, S, 24);
		gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, S, 28);
		starVao = vao; starN = fs.length; needsDraw = true;
		console.log(`[stars] ${starN} stars loaded`);
	} catch (e) { console.warn("[stars] load failed (sky stays dark):", e); }
})();

// ---- 行列 ----
let proj = null, pxPerRad = 1;
function resize() {
	const dpr = Math.min(2, devicePixelRatio || 1);
	const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
	if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
	const f = 1 / Math.tan(cam.fovy / 2), aspect = w / h;
	proj = new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, -1.0000002, -1, 0, 0, -2e-7, 0]);   // near/far は対数深度が上書き
	pxPerRad = (h / 2) / Math.tan(cam.fovy / 2);
	needsDraw = true;
}
new ResizeObserver(resize).observe(canvas);
const viewMat4 = () => new Float32Array([
	viewR[0][0], viewR[1][0], viewR[2][0], 0,
	viewR[0][1], viewR[1][1], viewR[2][1], 0,
	viewR[0][2], viewR[1][2], viewR[2][2], 0,
	0, 0, 0, 1]);
// 世界→スクリーン（px）。視野外/背後は null
function project(pw) {
	const r = v3.sub(pw, camPos);
	const x = viewR[0][0] * r[0] + viewR[0][1] * r[1] + viewR[0][2] * r[2];
	const y = viewR[1][0] * r[0] + viewR[1][1] * r[1] + viewR[1][2] * r[2];
	const z = viewR[2][0] * r[0] + viewR[2][1] * r[1] + viewR[2][2] * r[2];
	if (z > -1e-9) return null;
	return { x: canvas.clientWidth / 2 + x / -z * pxPerRad / (Math.min(2, devicePixelRatio || 1)),
		y: canvas.clientHeight / 2 - y / -z * pxPerRad / (Math.min(2, devicePixelRatio || 1)), dist: -z };
}

// ---- UI：下段チップ（Sun=全景ホーム／もう一度押すと太陽の近景）・時間バー・ラベル・情報パネル ----
const chipsEl = document.getElementById("chips");
for (const b of BODIES) {
	const el = document.createElement("button");
	el.textContent = bName(b); el.dataset.id = b.id;
	el.title = b.id === "sun" ? (JA ? "太陽系の全景（もう一度で太陽の近景）" : "Solar system view (press again for a close-up)")
		: (JA ? `${bName(b)}を訪ねる` : `Visit ${b.name}`);
	if (b.id === "sun") el.classList.add("on");
	el.onclick = () => flyTo(b.id);
	chipsEl.appendChild(el);
}
const labels = {};
const labelsEl = document.getElementById("labels");
for (const b of BODIES) {
	const el = document.createElement("div");
	el.className = "bl"; el.textContent = bName(b);
	el.style.color = `rgb(${b.color.map(c => Math.round(160 + c * 95)).join(",")})`;
	el.onclick = () => flyTo(b.id);
	labelsEl.appendChild(el); labels[b.id] = el;
}
const dtEl = document.getElementById("dt"), speedEl = document.getElementById("speed");
const fmtLocal = t => {   // datetime-local 用（ローカル時刻・分まで）
	const d = new Date(t), p = n => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
let dtEditing = false;
dtEl.addEventListener("focus", () => dtEditing = true);
dtEl.addEventListener("blur", () => dtEditing = false);
dtEl.addEventListener("change", () => { const t = new Date(dtEl.value).getTime(); if (Number.isFinite(t)) { simTime = Math.min(T_MAX, Math.max(T_MIN, t)); needsDraw = true; writeHash(); } });
const setSpeed = L => {
	speedL = Math.max(-(SPEEDS.length - 1), Math.min(SPEEDS.length - 1, Math.round(L) || 0));
	if (speedL !== 0) lastPlayL = speedL;
	const m = SPEEDS[Math.abs(speedL)];
	const lab = JA ? (speedL < 0 ? (m.jaNeg || m.ja) : m.ja) : (speedL < 0 ? (m.neg || m.label) : m.label);
	speedEl.textContent = speedL < 0 ? "−" + lab : lab;
	document.getElementById("play").textContent = speedL === 0 ? "▶" : "❚❚";   // ⏸ は Apple 系で絵文字化して浮く＝図形の ❚❚（index.html と対）
	writeHash();
};
document.getElementById("slower").onclick = () => setSpeed(speedL - 1);
document.getElementById("faster").onclick = () => setSpeed(speedL + 1);
document.getElementById("play").onclick = () => setSpeed(speedL === 0 ? lastPlayL : 0);
document.getElementById("now").onclick = () => { simTime = Date.now(); setSpeed(1); needsDraw = true; };
// 出口＝ortho-japan（縫い目の帰り道）。japanの太陽系ガジェットから来た時は history.back()＝
// 出た時の視点そのままへ帰る。直接来訪なら z=1（星空圏・日本中心）の japan へ新規遷移
document.getElementById("exit").onclick = () => {
	if (document.referrer.includes("/japan") && history.length > 1) history.back();
	else location.href = (["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:5173/japan/" : "/japan/") + "#1/36/138";
};
const infoEl = document.getElementById("info");
function updateInfo(date) {
	const b = byId[cam.focus];
	if (b.id === "sun") {
		infoEl.innerHTML = JA ? `<b>太陽</b><span>半径 695,700 km・スペクトル型 G2V</span><span>自転 約25日（赤道）</span>`
			: `<b>Sun</b><span>Radius 695,700 km · Spectral type G2V</span><span>Rotation ≈ 25 days (equator)</span>`;
		return;
	}
	const p = bodyPos(b.id, date), rSun = v3.len(p);
	const e = bodyPos("earth", date), rE = v3.len(v3.sub(p, e));
	const lm = rE * LIGHT_MIN_PER_AU;
	// 単位の綴りだけ言語で切り替える（数値と桁区切りは共通）。距離の副表記は英語=百万km・日本語=億km＝それぞれの読み癖に合わせる
	const light = lm < 1.5 ? (lm * 60).toFixed(0) + (JA ? " 秒" : " s") : lm.toFixed(1) + (JA ? " 分" : " min");
	const rot = b.rotHours < 48 ? b.rotHours.toFixed(1) + (JA ? " 時間" : " h") : (b.rotHours / 24).toFixed(1) + (JA ? " 日" : " days");
	const orb = b.periodDays < 1000 ? b.periodDays.toFixed(1) + (JA ? " 日" : " days") : (b.periodDays / 365.25).toFixed(1) + (JA ? " 年" : " years");
	const rows = (JA ? [
		b.note ? (NOTE_JA[b.note] || b.note) : "",
		`半径 ${b.radiusKm.toLocaleString("ja")} km`,
		`太陽から ${rSun.toFixed(3)} AU（${(rSun * AU_KM / 1e8).toFixed(2)} 億km）`,
		b.id !== "earth" ? `地球から ${rE.toFixed(3)} AU・光で ${light}` : "",
		`自転 ${rot}${b.rot.Wd < 0 ? "（逆行）" : ""}`,
		b.periodDays ? `公転 ${orb}` : "",
	] : [
		b.note || "",
		`Radius ${b.radiusKm.toLocaleString("en")} km`,
		`From Sun ${rSun.toFixed(3)} AU (${Math.round(rSun * AU_KM / 1e6).toLocaleString("en")} M km)`,
		b.id !== "earth" ? `From Earth ${rE.toFixed(3)} AU · light ${light}` : "",
		`Rotation ${rot}${b.rot.Wd < 0 ? " (retrograde)" : ""}`,
		b.periodDays ? `Orbit ${orb}` : "",
	]).filter(Boolean);
	infoEl.innerHTML = `<b>${bName(b)}</b>` + rows.map(r => `<span>${r}</span>`).join("");
}

// ---- URL ⇄ 状態（applyView 一本の流儀：読み＝起動時1回・書き＝操作後debounce） ----
let hashTimer = null;
function writeHash() {
	clearTimeout(hashTimer);
	hashTimer = setTimeout(() => {
		const p = new URLSearchParams({ t: fmtLocal(simTime), f: cam.focus, d: cam.dist.toPrecision(4),
			yaw: (cam.yaw / D2R).toFixed(1), pit: (cam.pitch / D2R).toFixed(1), s: String(speedL) });
		history.replaceState(null, "", "#" + p.toString());
	}, 300);
}
(function readHash() {
	const p = new URLSearchParams(location.hash.slice(1));
	if (p.get("t")) { const t = new Date(p.get("t")).getTime(); if (Number.isFinite(t)) simTime = Math.min(T_MAX, Math.max(T_MIN, t)); }
	if (p.get("f") && byId[p.get("f")]) cam.focus = p.get("f");
	if (p.get("d")) cam.dist = Math.max(1e-6, +p.get("d") || OVERVIEW_DIST);
	if (p.get("yaw")) cam.yaw = +p.get("yaw") * D2R;
	if (p.get("pit")) cam.pitch = Math.max(-88, Math.min(88, +p.get("pit"))) * D2R;
	if (p.get("s") !== null && p.get("s") !== "") setSpeed(+p.get("s"));
	document.querySelectorAll("#chips button").forEach(el => el.classList.toggle("on", el.dataset.id === cam.focus));
})();

// ---- 入力：1本指/マウス=周回・ホイール=対数ドリー・2本指=ピンチ（重心で周回＋間隔でドリー）・タップ=天体訪問 ----
// 指は Map で1本ずつ独立に追う（ortho-japan の input.js と同じ裁き）。旧実装は pointermove が届くたびに
// 「別の指の座標」を lastX/lastY と引き算していた＝2本指で触れた瞬間に指の間隔ぶん yaw が跳ね、
// タブレットではピンチのたびに視点がぐるぐる回った。pinchD ガードも touchmove 到着まで効かず素通りしていた。
// 3本以上は関知しない＝iPadOS のシステムジェスチャに譲る。
const ORBIT_RATE = 0.005;      // rad/CSSpx（周回の手触り＝ortho-japan 太陽系圏と共通）
const pts = new Map();         // pointerId → {x,y}（触れている指/ボタン）
let pinch = null;              // 2本指状態 {d,cx,cy}（前フレーム）
let tap = null;                // 単指タップ候補（2本目が触れた/6px以上動いた時点で捨てる）
// 手でのドリー下限＝天体が画面の95%を占めるところで止める（旧: 半径1.1倍＝地表すれすれまで寄れて
// 2k テクスチャの粗が出た）。視野は縦(fovy)基準なので、縦画面では横幅が先に尽きる＝min(1,W/H)を掛ける。
// tanθ=t の見かけ半角に対し d = R·√(1+t²)/t（球の接線から）。焦点天体ごと・画面比ごとに毎回引き直す
const focusMinDist = () => {
	const t = 0.95 * Math.tan(cam.fovy / 2) * Math.min(1, canvas.clientWidth / canvas.clientHeight);
	return byId[cam.focus].radiusAU * Math.sqrt(1 + t * t) / t + 1e-8;
};
const setDist = d => { cam.dist = Math.max(focusMinDist(), Math.min(120, d)); if (flight) flight.toD = cam.dist; needsDraw = true; };
const orbitBy = (dx, dy) => {
	cam.yaw -= dx * ORBIT_RATE;
	cam.pitch = Math.max(-88 * D2R, Math.min(88 * D2R, cam.pitch + dy * ORBIT_RATE));
	needsDraw = true;
};
const pinchNow = () => {
	const [a, b] = [...pts.values()];
	return { d: Math.hypot(b.x - a.x, b.y - a.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
};
canvas.addEventListener("pointerdown", e => {
	pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
	try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成イベントはcapture不可＝無視 */ }
	tap = pts.size === 1 ? { x: e.clientX, y: e.clientY } : null;
	pinch = pts.size === 2 ? pinchNow() : null;
});
canvas.addEventListener("pointermove", e => {
	const p = pts.get(e.pointerId);
	if (!p) return;
	const px = p.x, py = p.y;
	p.x = e.clientX; p.y = e.clientY;
	if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 6) tap = null;
	if (pts.size === 1) { orbitBy(e.clientX - px, e.clientY - py); writeHash(); return; }
	if (pts.size === 2 && pinch) {
		const n = pinchNow();
		orbitBy(n.cx - pinch.cx, n.cy - pinch.cy);   // 重心の移動＝周回（1本指と同じ所作）
		setDist(cam.dist * pinch.d / n.d);           // 間隔＝ドリー（ひらく＝寄る）
		pinch = n;
		writeHash();
	}
});
const liftPointer = e => {
	pts.delete(e.pointerId);
	pinch = pts.size === 2 ? pinchNow() : null;   // 3本→2本＝残った2本で仕切り直し／1本以下＝解除
	if (pts.size) { tap = null; return; }         // まだ指が残っている＝タップではない
	if (tap) {   // タップ／クリック＝一番近い天体ヒットで訪問
		let best = null, bestD = 18;
		for (const b of BODIES) {
			const s = project(bodyPos(b.id, simDate())); if (!s) continue;
			const rPx = b.radiusAU / s.dist * pxPerRad / (Math.min(2, devicePixelRatio || 1));
			const d = Math.hypot(s.x - tap.x, s.y - tap.y) - Math.max(0, rPx);
			if (d < bestD) { bestD = d; best = b.id; }
		}
		tap = null;
		if (best && (best !== cam.focus || best === "sun")) flyTo(best);   // 太陽だけは注視中でも受ける＝全景⇄近景の行き来
	}
	writeHash();
};
canvas.addEventListener("pointerup", liftPointer);
canvas.addEventListener("pointercancel", liftPointer);   // OSにジェスチャを取られた時に指が残り続けるのを防ぐ
canvas.addEventListener("wheel", e => {
	e.preventDefault();
	setDist(cam.dist * Math.exp(e.deltaY * 0.0012));
	writeHash();
}, { passive: false });

// ---- 描画 ----
let needsDraw = true, lastFrame = performance.now();
const MIN_PX = 2.6;   // 最小ピクセル半径クランプ（実スケールのまま可視性の下駄）
gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
function setCommon(P, view) {
	gl.uniformMatrix4fv(P.u.u_view, false, view); gl.uniformMatrix4fv(P.u.u_proj, false, proj);
	gl.uniform1f(P.u.u_logC, logC);
}
function frame() {
	requestAnimationFrame(frame);
	const now = performance.now(), dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
	const sp = Math.sign(speedL) * SPEEDS[Math.abs(speedL)].v;
	if (sp) {
		simTime += sp * dt * 1000;
		if (simTime <= T_MIN || simTime >= T_MAX) { simTime = Math.min(T_MAX, Math.max(T_MIN, simTime)); setSpeed(0); }
		needsDraw = true;
	}
	if (flight) needsDraw = true;
	if (!needsDraw || !proj) return;
	needsDraw = false;
	const date = simDate();
	updateCamera(date);
	const view = viewMat4();
	if (!dtEditing) dtEl.value = fmtLocal(simTime);
	updateInfo(date);
	gl.clearColor(0.012, 0.016, 0.038, 1);
	gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

	// 1) 恒星（深度書かず・無限遠）
	if (starVao) {
		gl.depthMask(false);
		gl.useProgram(starP.p); setCommon(starP, view);
		gl.bindVertexArray(starVao); gl.drawArrays(gl.POINTS, 0, starN);
		gl.depthMask(true);
	}

	// 2) 天体球（+土星の環）。位置はCPUでカメラ相対化（RTE）・遠い天体は最小px径に半径を持ち上げ
	const dpr = Math.min(2, devicePixelRatio || 1);
	const screens = {};
	gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
	gl.useProgram(sphereP.p); setCommon(sphereP, view);
	// ユニット0＝地表テクスチャ（天体ごとに差し替え）、ユニット1＝夜の街明かり（地球の1枚を1フレーム1回だけ結ぶ）
	gl.uniform1i(sphereP.u.u_tex, 0); gl.uniform1i(sphereP.u.u_night, 1);
	gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, byId.earth.nightTex || blackTex);
	gl.activeTexture(gl.TEXTURE0);
	for (const b of BODIES) {
		const p = bodyPos(b.id, date);
		screens[b.id] = project(p);
		const rel = v3.sub(p, camPos), dist = v3.len(rel);
		const minR = (b.id === "sun" ? 4 : MIN_PX) * dist / pxPerRad * dpr;
		const drawR = Math.max(b.radiusAU, minR);
		b.clamped = drawR > b.radiusAU * 1.001;
		// 月：クランプ表示で地球の点に埋まる間（画面上8px未満）は描かない＝二重点のちらつき回避
		if (b.id === "moon" && b.clamped && screens.earth && screens.moon &&
			Math.hypot(screens.earth.x - screens.moon.x, screens.earth.y - screens.moon.y) < 8) { b.hidden = true; continue; }
		b.hidden = false;
		const M = orientation(b.id, date), s = drawR;
		gl.uniformMatrix3fv(sphereP.u.u_model, false, new Float32Array([
			M[0][0] * s, M[1][0] * s, M[2][0] * s, M[0][1] * s, M[1][1] * s, M[2][1] * s, M[0][2] * s, M[1][2] * s, M[2][2] * s]));
		gl.uniform3f(sphereP.u.u_trans, rel[0], rel[1], rel[2]);
		const sd = b.id === "sun" ? [0, 0, 1] : [-p[0] / v3.len(p), -p[1] / v3.len(p), -p[2] / v3.len(p)];
		gl.uniform3f(sphereP.u.u_sun, sd[0], sd[1], sd[2]);
		gl.uniform1f(sphereP.u.u_emiss, b.emissive ? 1 : 0);
		gl.uniform1f(sphereP.u.u_hasNight, b.nightTex ? 1 : 0);   // 街明かりを持つのは地球だけ
		gl.bindTexture(gl.TEXTURE_2D, textures[b.id]);
		gl.bindVertexArray(sphere.vao); gl.drawElements(gl.TRIANGLES, sphere.n, gl.UNSIGNED_SHORT, 0);
		// 雲殻（地球のみ）＝地表の直後に、深度テストを切って重ねる。
		// 深度で競わせない理由：対数深度は far=200AU に合わせて刻まれており、地球に寄った時(w≈2.5e-4 AU)の
		// 1目盛(1.19e-7 NDC)に対し、殻の浮き 0.25%(16km) が生む差は 4e-8＝1/3目盛しかない＝z-fightingで
        // ちらつく。殻を3%(190km)浮かせれば勝てるが、それは見た目が嘘になる。背面カリング済み＝見えている
		// 殻の面は必ず地表より手前だと幾何学的に確定しているので、順序だけで正しい（深度も書かない）。
		// 月が地球の手前に来る場合も BODIES 順で月が後＝月が雲の上に正しく描かれる。
		if (b.cloudTex && !b.clamped) {
			const cs = drawR * 1.0025;   // ≒16km上（実際の雲の高さ。見た目のためだけの浮きではない）
			gl.uniformMatrix3fv(sphereP.u.u_model, false, new Float32Array([
				M[0][0] * cs, M[1][0] * cs, M[2][0] * cs, M[0][1] * cs, M[1][1] * cs, M[2][1] * cs, M[0][2] * cs, M[1][2] * cs, M[2][2] * cs]));
			gl.uniform1f(sphereP.u.u_hasNight, 0);   // 街明かりは地表の一枚だけ＝殻には乗せない（雲は明かりを遮る側）
			gl.uniform1f(sphereP.u.u_cloud, 1);
			gl.bindTexture(gl.TEXTURE_2D, b.cloudTex);
			gl.disable(gl.DEPTH_TEST);
			gl.drawElements(gl.TRIANGLES, sphere.n, gl.UNSIGNED_SHORT, 0);
			gl.enable(gl.DEPTH_TEST);
			gl.uniform1f(sphereP.u.u_cloud, 0);
		}
		b._rel = rel; b._drawR = drawR; b._sun = sd;
	}
	// 環は球の後（半透明・両面）。クランプ中も環ごと拡大＝土星の見た目を保つ
	gl.disable(gl.CULL_FACE);
	for (const b of BODIES) {
		if (!b.ring || b.hidden) continue;
		gl.useProgram(ringP.p); setCommon(ringP, view);
		const M = orientation(b.id, date), s = b._drawR;
		gl.uniformMatrix3fv(ringP.u.u_model, false, new Float32Array([
			M[0][0] * s, M[1][0] * s, M[2][0] * s, M[0][1] * s, M[1][1] * s, M[2][1] * s, M[0][2] * s, M[1][2] * s, M[2][2] * s]));
		gl.uniform3f(ringP.u.u_trans, b._rel[0], b._rel[1], b._rel[2]);
		const n = [M[0][2], M[1][2], M[2][2]];
		gl.uniform1f(ringP.u.u_light, 0.35 + 0.65 * Math.abs(n[0] * b._sun[0] + n[1] * b._sun[1] + n[2] * b._sun[2]));
		gl.uniform1i(ringP.u.u_tex, 0); gl.bindTexture(gl.TEXTURE_2D, b.ringTex);
		gl.bindVertexArray(b.ringMesh.vao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, b.ringMesh.n);
	}

	// 3) 軌道線（深度テストのみ＝手前の球に隠れる）。惑星に寄ったら空を横切る他軌道は退場
	//    （飛行中の重い層抑制と同じ引き算＝主役の惑星と星空だけ残す）。焦点天体の半径比で判定
	const lineFade = Math.min(1, Math.max(0, (cam.dist / byId[cam.focus].radiusAU - 12) / 48));
	if (lineFade > 0.01) {
		gl.depthMask(false);
		gl.useProgram(lineP.p); setCommon(lineP, view);
		gl.uniform3f(lineP.u.u_camPos, camPos[0], camPos[1], camPos[2]);
		for (const b of BODIES) {
			if (b.id === "sun" || b.id === "moon") continue;
			const o = ensureOrbit(b.id, date);
			gl.uniform4f(lineP.u.u_color, b.color[0], b.color[1], b.color[2], 0.32 * lineFade);
			gl.bindVertexArray(o.vao); gl.drawArrays(gl.LINE_LOOP, 0, o.n);
		}
		const eDist = v3.len(v3.sub(bodyPos("earth", date), camPos));
		if (eDist < 0.25) {   // 月軌道は地球に寄った時だけ（全景ではただの汚れ）
			const o = ensureMoonOrbit(date);
			gl.uniform4f(lineP.u.u_color, 0.78, 0.78, 0.78, 0.3 * lineFade);
			gl.bindVertexArray(o.vao); gl.drawArrays(gl.LINE_LOOP, 0, o.n);
		}
		gl.depthMask(true);
	}

	// 4) 太陽グロー（加算・最前）
	const sunS = screens.sun;
	if (sunS) {
		gl.depthMask(false); gl.blendFunc(gl.ONE, gl.ONE);
		gl.useProgram(glowP.p); setCommon(glowP, view);
		const rel = v3.sub([0, 0, 0], camPos), dist = v3.len(rel);
		const size = Math.max(byId.sun.radiusAU * 3.2, 26 * dist / pxPerRad * dpr);
		gl.uniform3f(glowP.u.u_center, rel[0], rel[1], rel[2]); gl.uniform1f(glowP.u.u_size, size);
		gl.bindVertexArray(glowMesh); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.depthMask(true); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	}

	// 5) HTML ラベル（クリック＝訪問）。寄っている天体（画面の1/4超）は引っ込める。
	//    全景の中心では内惑星のラベルが団子になる＝縦に押し下げて整列（BODIES順＝太陽から優先）
	const placed = [];
	for (const b of BODIES) {
		const el = labels[b.id], s = screens[b.id];
		if (!s || b.hidden || s.x < -40 || s.x > canvas.clientWidth + 40 || s.y < 0 || s.y > canvas.clientHeight) { el.style.display = "none"; continue; }
		const rPx = b.radiusAU / s.dist * pxPerRad / dpr;
		if (rPx > canvas.clientHeight * 0.22) { el.style.display = "none"; continue; }
		let x = s.x + Math.max(6, rPx * 0.8) + 4, y = s.y - 9;
		for (let guard = 0; guard < 12 && placed.some(p => Math.abs(p.x - x) < 64 && Math.abs(p.y - y) < 13); guard++) y += 13;
		placed.push({ x, y });
		el.style.display = "block";
		el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
	}
}
resize();
requestAnimationFrame(frame);
