// 世界の地震（USGS ComCat・1967〜・M2+）を ortho-japan の地球儀に立体表示する（quakes.html から遅延 import）。
//
// 表現の決め事
//   位置   … 震源＝震央 [経度, 緯度] から深さぶん地球の内側。地球（globe）を半透明にして地中を透かして見せる
//   色     … 深さ。浅い＝赤 → 橙 → 黄 → 緑 → 水色 → 深い＝青（色軸は √(深さ/700km)＝浅い側の差が見える）
//   大きさ … エネルギーの量を「球の体積」とみなす。E ∝ 10^(1.5M) ⇒ 半径 ∝ E^(1/3) ∝ 10^(0.5M)
//            M6 の半径を基準（既定 15 km＝「球の大きさ」で倍率）に、実寸（ワールド単位）で置く＝寄れば大きくなる
//   形     … M>6 は本物の 3D 球（インスタンス描画の多面体・陰影つき・深度つき）
//            M≤6 は 2D スプライト（球の陰影を描いた円＝点スプライト）。どちらも震源の 3D 位置に置くので、傾けると立体に見える
//   表示下限 … 実寸が 1px 未満の地震は最小サイズで描き、そのぶん薄くする（小さな地震は「雲」として見える）
//   透け   … 視線が地球の中を通る長さ L に応じて exp(−L/λ) で薄める＝地球の裏側は見えず、真下の深い震源は少し沈んで見える
//
// エンジンとの接点は公開面だけ：map.cam（カメラ状態）＋ ortho-core の cameraState（エンジンと同じ mvp）・onFrame・
// requestDraw・setOpacity・mapEl。描画は自前の WebGL2 canvas を #c（地図）と #labels（注記）の間に差し込む。
import { cameraState, ellipsoidOn, worldRadiusM } from "ortho-core";

const M_SPLIT = 6;            // これより大きい（M>6）＝3D 球
const Y_MIN = 1967;

// ── 深さ → 色（GLSL と JS で同じ表）────────────────────────────────────────
const DEPTH_MAX = 700;
const STOPS = [   // t = √(depth/700)
	[0.00, [255, 38, 38]],     // 0 km   赤
	[0.15, [255, 48, 34]],     // 16 km  赤（浅発の大半＝10 km 前後はここ）
	[0.30, [255, 140, 26]],    // 63 km  橙
	[0.42, [255, 214, 32]],    // 123 km 黄
	[0.55, [86, 214, 96]],     // 212 km 緑
	[0.72, [30, 196, 255]],    // 363 km 水色
	[1.00, [52, 84, 255]],     // 700 km 青
];
const depthT = d => Math.sqrt(Math.min(Math.max(d, 0), DEPTH_MAX) / DEPTH_MAX);
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
const fmt = n => n.toLocaleString("ja-JP");
const pad = n => String(n).padStart(2, "0");
const fmtTime = (ms, offH = 0) => { const d = new Date(ms + offH * 3600000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };

// ── 本体 ─────────────────────────────────────────────────────────────────────
export async function mountQuakes(map, { src, panelHost } = {}) {
	const mapEl = map.mapEl;
	const cv = document.createElement("canvas");
	cv.className = "quakes-gl";
	cv.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none";
	const labels = mapEl.querySelector("#labels");
	labels ? mapEl.insertBefore(cv, labels) : mapEl.appendChild(cv);
	const gl = cv.getContext("webgl2", { premultipliedAlpha: true, antialias: true, alpha: true, depth: true });
	if (!gl) throw new Error("WebGL2 が使えません");
	const sprite = compile(gl, SPRITE_VS, SPRITE_FS);
	const sphere = compile(gl, SPHERE_VS, SPHERE_FS);
	const maxPt = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];

	// 状態（パネルが書き換える）
	const st = {
		magMin: 2, magMax: 10, yearMin: Y_MIN, yearMax: new Date().getUTCFullYear(),
		size: 1,          // 球の大きさの倍率（M6 半径＝30km×size）
		faint: 0.22,      // 小さな地震の濃さ（表示下限に持ち上げた点の最低不透明度）
		clear: 0.6,       // 地球の透け具合 0..1
	};
	const EARTH_M = worldRadiusM();
	const M6_KM = 15;
	// 層（srcs の 1 本ずつ＝archive・USGS 直近分）。worker から届いたそばから差し替えて重ねて描く
	//   { n, nBig, pos, attr, lon, lat, time, gl:{ bufs, spriteVao, sphereVao } }
	const layers = [];
	const total = () => layers.reduce((a, L) => a + (L?.n ?? 0), 0);
	let dataYearMax = st.yearMax;
	const ico = icosphere(3), icoCount = ico.idx.length;   // 1280 面＝M9 級を画面いっぱいに寄せても角が見えない
	const icoVb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, icoVb); gl.bufferData(gl.ARRAY_BUFFER, ico.vtx, gl.STATIC_DRAW);
	const icoIb = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, icoIb); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ico.idx, gl.STATIC_DRAW);

	const applyGlobe = () => map.setOpacity({ globe: 1 - 0.8 * st.clear, base: 1 - 0.35 * st.clear });
	// 再生（年・月ごとに発生した地震を順に見せる）。play.cur＝窓の先頭（小数年・[cur, cur+step)）。積み上げ＝期間の先頭から cur+step まで
	const play = { on: false, cur: 0, step: 1, accum: false, sps: 2, raf: 0, last: 0 };
	// 表示する年の範囲 [a, b)（小数年）＝再生中は再生の窓・それ以外は期間スライダー
	const yearRange = () => play.on ? [play.accum ? st.yearMin : play.cur, play.cur + play.step] : [st.yearMin, st.yearMax + 1];

	// ── 描画 ──
	// カメラは 1 フレーム遅らせる：地球はレンダーワーカーが次の rAF で描く（main の render は cam を送るだけ）ので、
	// onFrame でその場の cam を使うと地震だけ 1 フレーム先行して見える。前フレームに送った cam＝地球が今見せている姿。
	// 静止した最後の 1 枚は次の rAF で追いつかせる（render が来ないと遅れたままになる）。
	let shownCam = null, catchUp = 0;
	const snapCam = () => ({ ...map.cam, center: [...map.cam.center] });
	const camState = () => {
		const c = shownCam ?? map.cam;
		const dpr = c.dpr || devicePixelRatio || 1;
		const W = Math.max(1, Math.round(mapEl.clientWidth * dpr)), H = Math.max(1, Math.round(mapEl.clientHeight * dpr));
		if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
		return { s: cameraState(c, W, H), dpr };
	};
	function draw() {
		const { s, dpr } = camState();
		gl.viewport(0, 0, cv.width, cv.height);
		gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		if (!total()) return;
		const mvp = new Float32Array(s.mvp), eye = new Float32Array(s.eye);
		const common = (u) => {
			gl.uniformMatrix4fv(u.u_mvp, false, mvp);
			gl.uniform3fv(u.u_eye, eye);
			gl.uniform1f(u.u_focal, s.focal);
			gl.uniform1f(u.u_scale, M6_KM * 1000 * st.size / EARTH_M);
			gl.uniform1f(u.u_lambda, 0.012 + 0.28 * st.clear * st.clear);
			gl.uniform2f(u.u_mag, st.magMin - 1e-4, st.magMax + 1e-4);
			const [ya, yb] = yearRange();
			gl.uniform2f(u.u_year, ya, yb);
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
			for (const L of layers) if (L?.nBig) { gl.bindVertexArray(L.gl.sphereVao); gl.drawElementsInstanced(gl.TRIANGLES, icoCount, gl.UNSIGNED_SHORT, 0, L.nBig); }
			gl.disable(gl.CULL_FACE);
		}
		// 2) M≤6 のスプライト（深度は読むだけ＝球の後ろは隠れる）
		gl.useProgram(sprite.p); common(sprite.u);
		gl.uniform1f(sprite.u.u_minPx, 1.1 * dpr);
		gl.uniform1f(sprite.u.u_floor, st.faint);
		gl.uniform1f(sprite.u.u_maxPt, maxPt);
		gl.uniform1f(sprite.u.u_split, M_SPLIT);
		gl.depthMask(false);
		for (const L of layers) if (L && L.n > L.nBig) { gl.bindVertexArray(L.gl.spriteVao); gl.drawArrays(gl.POINTS, 0, L.n - L.nBig); }
		gl.depthMask(true);
		gl.bindVertexArray(null);
	}
	const offFrame = map.onFrame(() => {
		draw(); placeTags();
		shownCam = snapCam();
		if (!catchUp) catchUp = requestAnimationFrame(() => { catchUp = 0; draw(); });
	});
	const ro = new ResizeObserver(() => { map.requestDraw(); draw(); });
	ro.observe(mapEl);
	const redraw = () => { draw(); placeTags(); };

	// ── パネル ──
	const panel = document.createElement("div");
	panel.className = "quakes-panel";
	panel.innerHTML = `
<style>
.quakes-panel{position:absolute;top:12px;right:12px;z-index:30;width:292px;max-width:calc(100% - 24px);max-height:calc(100% - 80px);overflow:auto;
 box-sizing:border-box;padding:14px 16px 12px;border-radius:12px;background:rgba(12,17,32,.86);color:#e7ecf5;
 border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
 font:12.5px/1.55 "Noto Sans JP","Hiragino Sans","Yu Gothic UI",system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)}
.quakes-panel .head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.quakes-panel h1{font-size:15px;margin:0 0 2px;font-weight:700;letter-spacing:.02em}
.quakes-panel .fold{flex:none;width:26px;height:26px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e7ecf5;font-size:14px;line-height:1;cursor:pointer}
.quakes-panel.min .body{display:none}
.quakes-panel.min{padding-bottom:10px}
.quakes-panel .play{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.quakes-panel .play button{border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#ff8c1a;color:#1a0d00;font-weight:700;padding:5px 12px;cursor:pointer;font:inherit;font-weight:700}
.quakes-panel .play button.on{background:#e7ecf5;color:#0b1021}
.quakes-panel .play select{font:inherit;font-size:12px;border-radius:7px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#e7ecf5;padding:4px 6px}
.quakes-panel .play label.chk{display:inline-flex;align-items:center;gap:4px;color:#b9c3d6}
.quakes-panel .play .spd{flex:1 1 100%;display:flex;align-items:center;gap:8px;color:#b9c3d6}
.quakes-panel .play .spd input{flex:1;margin:0}
.quakes-clock{position:absolute;left:50%;bottom:56px;transform:translateX(-50%);z-index:29;pointer-events:none;padding:8px 18px;border-radius:12px;
 background:rgba(12,17,32,.72);color:#fff;font:700 34px/1.2 "Noto Sans JP","Hiragino Sans",system-ui,sans-serif;font-variant-numeric:tabular-nums;letter-spacing:.03em;
 border:1px solid rgba(255,255,255,.14);text-shadow:0 2px 12px rgba(0,0,0,.6);white-space:nowrap}
.quakes-tag{position:absolute;z-index:29;pointer-events:none;transform:translate(-50%,-100%);margin-top:-14px;padding:5px 9px;border-radius:9px;
 background:rgba(12,17,32,.9);color:#fff;border:1px solid rgba(255,140,26,.7);font:12px/1.4 "Noto Sans JP","Hiragino Sans",system-ui,sans-serif;white-space:nowrap;
 box-shadow:0 4px 16px rgba(0,0,0,.45)}
.quakes-tag b{font-size:14px;color:#ffb35c}
.quakes-tag small{display:block;color:#b9c3d6;font-size:11px}
.quakes-tag::after{content:"";position:absolute;left:50%;bottom:-6px;width:10px;height:10px;transform:translateX(-50%) rotate(45deg);background:rgba(12,17,32,.9);border-right:1px solid rgba(255,140,26,.7);border-bottom:1px solid rgba(255,140,26,.7)}
.quakes-clock small{display:block;font-size:12px;font-weight:400;color:#b9c3d6;text-align:center;margin-top:2px}
.quakes-panel .sub{color:#9aa6bd;font-size:11.5px;margin-bottom:10px}
.quakes-panel .row{margin:9px 0}
.quakes-panel label{display:flex;justify-content:space-between;color:#b9c3d6}
.quakes-panel label b{color:#fff;font-weight:600;font-variant-numeric:tabular-nums}
.quakes-panel input[type=range]{width:100%;margin:3px 0 0;accent-color:#ff8c1a}
.quakes-panel .dual{position:relative;height:22px}
.quakes-panel .dual input{position:absolute;left:0;top:0;pointer-events:none;background:none;-webkit-appearance:none;appearance:none;height:22px}
.quakes-panel .dual input::-webkit-slider-thumb{pointer-events:auto;-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#ff8c1a;border:2px solid #fff;cursor:pointer}
.quakes-panel .dual input::-moz-range-thumb{pointer-events:auto;width:12px;height:12px;border-radius:50%;background:#ff8c1a;border:2px solid #fff;cursor:pointer}
.quakes-panel .dual::before{content:"";position:absolute;left:0;right:0;top:10px;height:3px;border-radius:2px;background:rgba(255,255,255,.2)}
.quakes-panel .bar{height:10px;border-radius:5px;margin:4px 0 2px}
.quakes-panel .ticks{position:relative;height:14px;color:#9aa6bd;font-size:10.5px}
.quakes-panel .ticks span{position:absolute;transform:translateX(-50%);white-space:nowrap}
.quakes-panel .ticks span:first-child{transform:none}.quakes-panel .ticks span:last-child{transform:translateX(-100%)}
.quakes-panel .sizes{display:flex;align-items:flex-end;justify-content:space-between;margin-top:6px}
.quakes-panel .sizes div{display:flex;flex-direction:column;align-items:center;gap:3px;color:#9aa6bd;font-size:10.5px}
.quakes-panel .ball{border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff 0,#ff3a2a 24%,#8a1208 100%)}
.quakes-panel .dot{border-radius:50%;background:#ff3a2a}
.quakes-panel .note{color:#8793aa;font-size:10.5px;margin-top:8px;line-height:1.5}
.quakes-panel .stat{font-variant-numeric:tabular-nums;color:#fff}
.quakes-panel details summary{cursor:pointer;color:#b9c3d6;margin-top:8px}
.quakes-info{position:absolute;z-index:31;pointer-events:none;min-width:180px;padding:9px 12px;border-radius:10px;
 background:rgba(12,17,32,.92);color:#e7ecf5;border:1px solid rgba(255,255,255,.16);
 font:12px/1.55 "Noto Sans JP","Hiragino Sans",system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.4);transform:translate(12px,-50%)}
.quakes-info b{font-size:15px}
.quakes-info .sw{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
@media (max-width:640px){.quakes-panel{top:auto;bottom:44px;right:8px;left:8px;width:auto;max-height:45%}.quakes-clock{bottom:auto;top:10px;font-size:24px;padding:6px 14px}}
</style>
<div class="head"><h1>世界の地震</h1><button type="button" class="fold" data-k="fold" aria-label="パネルを畳む">−</button></div>
<div class="sub">USGS ANSS ComCat ・ M2 以上 ・ <span data-k="span">1967〜</span></div>
<div class="row"><div data-k="status" class="stat">読み込み中…</div></div>
<div class="body">
<div class="row">
 <label>期間 <b data-k="yearLab"></b></label>
 <div class="dual"><input type="range" data-k="y0" step="1"><input type="range" data-k="y1" step="1"></div>
</div>
<div class="row play">
 <button type="button" data-k="play">▶ 再生</button>
 <select data-k="unit"><option value="1">1 年ずつ</option><option value="month">1 か月ずつ</option></select>
 <label class="chk"><input type="checkbox" data-k="accum">積み上げ</label>
 <div class="spd">速さ <input type="range" data-k="speed" min="0.5" max="24" step="0.5"><b data-k="speedLab"></b></div>
</div>
<div class="row">
 <label>マグニチュード <b data-k="magLab"></b></label>
 <div class="dual"><input type="range" data-k="m0" min="2" max="9.5" step="0.1"><input type="range" data-k="m1" min="2" max="9.5" step="0.1"></div>
</div>
<div class="row">
 <label>深さ（色）</label>
 <div class="bar" data-k="bar"></div>
 <div class="ticks" data-k="ticks"></div>
</div>
<div class="row">
 <label>大きさ ＝ エネルギー（球の体積）</label>
 <div class="sizes" data-k="sizes"></div>
 <div class="note">E ∝ 10<sup>1.5M</sup> なので半径 ∝ 10<sup>0.5M</sup>。M が 2 上がると半径 10 倍（エネルギー 1000 倍）。<br>M&gt;6 は 3D の球、M≤6 は 2D スプライト。</div>
</div>
<details open>
 <summary>表示の調整</summary>
 <div class="row"><label>球の大きさ <b data-k="sizeLab"></b></label><input type="range" data-k="size" min="-1.5" max="1.5" step="0.05"></div>
 <div class="row"><label>小さな地震の濃さ <b data-k="faintLab"></b></label><input type="range" data-k="faint" min="0.02" max="1" step="0.01"></div>
 <div class="row"><label>地球の透け具合 <b data-k="clearLab"></b></label><input type="range" data-k="clear" min="0" max="1" step="0.01"></div>
</details>
<div class="note">クリックで地震の詳細。再生＝期間スライダーの範囲を年・月ごとに順送り（Esc で停止）。傾ける（右ドラッグ／2本指）と震源の深さが立体で見えます。<br>出典：U.S. Geological Survey, ANSS Comprehensive Earthquake Catalog</div>
</div>`;
	(panelHost || mapEl).appendChild(panel);
	const $ = k => panel.querySelector(`[data-k="${k}"]`);
	const info = document.createElement("div");
	info.className = "quakes-info"; info.style.display = "none";
	mapEl.appendChild(info);
	const clock = document.createElement("div");
	clock.className = "quakes-clock"; clock.style.display = "none";
	mapEl.appendChild(clock);
	// 再生中の巨大地震の札（窓の中の M≥TAG_MIN・大きい順に TAG_MAX 枚）
	const TAG_MIN = 7.5, TAG_MAX = 3;
	let tags = [];   // { L, i, el }
	const clearTags = () => { tags.forEach(t => t.el.remove()); tags = []; };
	const placeTags = () => {
		if (!tags.length) return;
		const { s, dpr } = camState();
		const r = mapEl.getBoundingClientRect();
		for (const t of tags) {
			const p = project(s, t.L, t.i);
			if (!p) { t.el.style.display = "none"; continue; }
			t.el.style.display = ""; t.el.style.marginTop = "";
			t.el.style.left = (p.x / dpr) + "px"; t.el.style.top = (p.y / dpr) + "px";
		}
		// 重なった札は上へ避ける（先に置いた札の上に積む）
		const placed = [];
		for (const t of tags) {
			if (t.el.style.display === "none") continue;
			let r = t.el.getBoundingClientRect(), lift = 0;
			for (const q of placed) {
				if (r.left < q.right + 4 && r.right > q.left - 4 && r.top < q.bottom + 4 && r.bottom > q.top - 4) {
					lift += r.bottom - q.top + 6;
					r = new DOMRect(r.left, r.top - (r.bottom - q.top + 6), r.width, r.height);
				}
			}
			if (lift) t.el.style.marginTop = (-14 - lift) + "px";
			placed.push(r);
		}
	};
	const refreshTags = () => {
		clearTags();
		const [y0, y1] = yearRange(), m0 = st.magMin - 1e-4, m1 = st.magMax + 1e-4;
		const found = [];
		for (const L of layers) {
			if (!L || !L.nBig) continue;
			for (let i = L.n - L.nBig; i < L.n; i++) {   // M>6 は末尾にまとまっている
				const mg = L.attr[i * 3], yr = L.attr[i * 3 + 2];
				if (mg >= TAG_MIN && mg >= m0 && mg <= m1 && yr >= y0 && yr <= y1) found.push({ L, i, mg });
			}
		}
		found.sort((a, b) => b.mg - a.mg);
		for (const f of found.slice(0, TAG_MAX)) {
			const el = document.createElement("div");
			el.className = "quakes-tag";
			el.innerHTML = tagHtml(f.L, f.i);
			mapEl.appendChild(el);
			tags.push({ L: f.L, i: f.i, el });
		}
		placeTags();
	};
	// 折り畳み：小さい画面は最初から畳む（見出し＋件数だけ残す）
	const setFold = min => { panel.classList.toggle("min", min); $("fold").textContent = min ? "＋" : "−"; $("fold").setAttribute("aria-label", min ? "パネルを開く" : "パネルを畳む"); };
	$("fold").addEventListener("click", () => setFold(!panel.classList.contains("min")));
	setFold(matchMedia("(max-width:640px)").matches);

	// 凡例
	$("bar").style.background = `linear-gradient(90deg,${STOPS.map(([t, c]) => `rgb(${c}) ${(t * 100).toFixed(1)}%`).join(",")})`;
	$("ticks").innerHTML = [0, 30, 70, 150, 300, 700].map(d => `<span style="left:${(depthT(d) * 100).toFixed(1)}%">${d}${d === 700 ? " km" : ""}</span>`).join("");
	const drawSizes = () => {
		// M5〜M9：M6 を 6px 半径として相対（半径 ∝ 10^(0.5M)）。M>6 は球・M≤6 は平たい円
		const base = 5;
		$("sizes").innerHTML = [4, 5, 6, 7, 8, 9].map(m => {
			const r = Math.max(1, Math.min(34, base * Math.pow(10, 0.5 * (m - 6)) ** 0.62));   // 凡例だけ圧縮（そのままだと M9 が 30 倍）
			const cls = m > M_SPLIT ? "ball" : "dot";
			return `<div><span class="${cls}" style="width:${2 * r}px;height:${2 * r}px"></span>M${m}</div>`;
		}).join("");
	};
	drawSizes();

	const yearNow = new Date().getUTCFullYear();
	for (const k of ["y0", "y1"]) { $(k).min = Y_MIN; $(k).max = yearNow; }
	$("y0").value = Y_MIN; $("y1").value = yearNow;
	$("m0").value = 2; $("m1").value = 9.5;
	$("size").value = 0; $("faint").value = st.faint; $("clear").value = st.clear;
	$("speed").value = play.sps;

	let countTimer = 0;
	const syncLabels = () => {
		$("yearLab").textContent = st.yearMin === st.yearMax ? `${st.yearMin}年` : `${st.yearMin}〜${st.yearMax}年`;
		$("magLab").textContent = `M${st.magMin.toFixed(1)}〜${st.magMax >= 9.5 ? "" : st.magMax.toFixed(1)}`;
		$("sizeLab").textContent = `×${st.size < 1 ? st.size.toFixed(2) : st.size.toFixed(1)}（M6 半径 ${Math.round(M6_KM * st.size)} km）`;
		$("faintLab").textContent = Math.round(st.faint * 100) + "%";
		$("clearLab").textContent = Math.round(st.clear * 100) + "%";
		$("speedLab").textContent = `${play.sps}${play.step === 1 ? "年" : "か月"}/秒`;
	};
	// ── 再生 ──
	const periodText = () => {
		const y = Math.floor(play.cur + 1e-6);
		if (play.step === 1) return `${y}年`;
		const mo = Math.round((play.cur - y) * 12) + 1;
		return `${y}年${mo}月`;
	};
	const showClock = () => {
		clock.innerHTML = `${periodText()}<small>${play.accum ? `${st.yearMin}年〜 積み上げ` : play.step === 1 ? "この年の地震" : "この月の地震"}</small>`;
		clock.style.display = "";
	};
	let countT = 0;
	const tick = now => {
		play.raf = requestAnimationFrame(tick);
		if (now - play.last < 1000 / play.sps) return;
		play.last = now;
		play.cur += play.step;
		if (play.cur >= st.yearMax + 1 - 1e-6) play.cur = st.yearMin;   // 端まで来たら先頭へ
		showClock(); refreshTags(); redraw();
		if (now - countT > 250) { countT = now; countVisible(); }
	};
	const startPlay = () => {
		if (play.on) return;
		play.on = true; play.cur = st.yearMin; play.last = 0;
		$("play").textContent = "■ 停止"; $("play").classList.add("on");
		info.style.display = "none";
		showClock(); refreshTags(); redraw(); countVisible();
		play.raf = requestAnimationFrame(tick);
	};
	const stopPlay = () => {
		if (!play.on) return;
		play.on = false; cancelAnimationFrame(play.raf); play.raf = 0;
		$("play").textContent = "▶ 再生"; $("play").classList.remove("on");
		clock.style.display = "none"; clearTags();
		redraw(); countVisible();
	};
	$("play").addEventListener("click", () => play.on ? stopPlay() : startPlay());
	const onKey = e => { if (e.key === "Escape" && play.on) stopPlay(); };
	addEventListener("keydown", onKey);
	// 状況＝件数の行＋層ごとの進み具合（読み込み中は逐次・済んだ後も USGS の要約は残す）
	let countLine = "", notes = [], skippedNote = "";
	const esc = t => String(t).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
	const renderStatus = () => {
		$("status").innerHTML = [countLine, ...notes.filter(Boolean).map(t => `<span style="color:#9aa6bd">${esc(t)}</span>`), skippedNote].filter(Boolean).join("<br>");
	};
	const countVisible = () => {
		const n = total();
		if (!n) return;
		let c = 0, big = 0;
		const [y0, y1] = yearRange(), m0 = st.magMin - 1e-4, m1 = st.magMax + 1e-4;
		for (const L of layers) {
			if (!L) continue;
			const { attr } = L;
			for (let i = 0; i < L.n; i++) {
				const m = attr[i * 3], y = attr[i * 3 + 2];
				if (m >= m0 && m <= m1 && y >= y0 && y <= y1) { c++; if (m > M_SPLIT) big++; }
			}
		}
		countLine = `表示 <b>${fmt(c)}</b> 件 <span style="color:#9aa6bd">（うち M&gt;6 の球 ${fmt(big)}）／ 全 ${fmt(n)} 件</span>`;
		renderStatus();
	};
	const onInput = () => {
		let y0 = +$("y0").value, y1 = +$("y1").value; if (y0 > y1) [y0, y1] = [y1, y0];
		let m0 = +$("m0").value, m1 = +$("m1").value; if (m0 > m1) [m0, m1] = [m1, m0];
		st.yearMin = y0; st.yearMax = y1 >= yearNow ? Math.max(y1, dataYearMax) : y1;
		st.magMin = m0; st.magMax = m1 >= 9.5 ? 10 : m1;
		st.size = Math.pow(10, +$("size").value);
		st.faint = +$("faint").value;
		const clear = +$("clear").value;
		if (clear !== st.clear) { st.clear = clear; applyGlobe(); }
		play.step = $("unit").value === "month" ? 1 / 12 : 1;
		play.accum = $("accum").checked;
		play.sps = +$("speed").value;
		if (play.on) play.cur = Math.min(Math.max(play.cur, st.yearMin), st.yearMax + 1 - play.step);
		syncLabels();
		clearTimeout(countTimer); countTimer = setTimeout(countVisible, 60);
		info.style.display = "none";
		redraw();
	};
	panel.addEventListener("input", onInput);
	syncLabels();
	applyGlobe();

	// ── クリックで詳細（CPU で最寄りを探す）──
	let down = null;
	mapEl.addEventListener("pointerdown", e => { down = [e.clientX, e.clientY]; }, true);
	mapEl.addEventListener("pointerup", e => {
		if (!down || !total() || panel.contains(e.target)) return;
		const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null;
		if (moved > 4) return;
		const r = mapEl.getBoundingClientRect();
		const hit = pick(e.clientX - r.left, e.clientY - r.top);
		if (!hit) { info.style.display = "none"; return; }
		showInfo(hit, e.clientX - r.left, e.clientY - r.top);
	}, true);
	map.on("move", () => { info.style.display = "none"; });

	// 震源 → 画面（device px）。裏側（透けが薄い）や画面外は null
	function project(s, L, i) {
		const m = s.mvp, E = s.eye, W = cv.width, H = cv.height;
		const X = L.pos[i * 3], Y = L.pos[i * 3 + 1], Z = L.pos[i * 3 + 2];
		const w = m[3] * X + m[7] * Y + m[11] * Z + m[15];
		if (w <= 0) return null;
		const x = ((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w * 0.5 + 0.5) * W;
		const y = (1 - ((m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w * 0.5 + 0.5)) * H;
		if (x < 0 || y < 0 || x > W || y > H) return null;
		const dx = X - E[0], dy = Y - E[1], dz = Z - E[2];
		const a = dx * dx + dy * dy + dz * dz, b = E[0] * dx + E[1] * dy + E[2] * dz, c = E[0] * E[0] + E[1] * E[1] + E[2] * E[2] - 1;
		const disc = b * b - a * c;
		if (disc > 0) {
			const sq = Math.sqrt(disc), t0 = Math.min(1, Math.max(0, (-b - sq) / a)), t1 = Math.min(1, Math.max(0, (-b + sq) / a));
			if (Math.exp(-(t1 - t0) * Math.sqrt(a) / (0.012 + 0.28 * st.clear * st.clear)) < 0.05) return null;
		}
		return { x, y };
	}
	const coordText = (lat, lon) => `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
	const tagHtml = (L, i) => {
		const mg = L.attr[i * 3], dp = L.attr[i * 3 + 1], t = L.time[i], place = L.place?.get(i);
		return `<b>M${mg.toFixed(1)}</b>　${fmtTime(t).slice(0, 10)}<small>${place ? esc(place) : coordText(L.lat[i], L.lon[i])}　深さ ${Math.round(dp)} km</small>`;
	};
	function pick(x, y) {
		const { s, dpr } = camState();
		const m = s.mvp, E = s.eye, W = cv.width, H = cv.height;
		const px = x * dpr, py = y * dpr;
		const scale = M6_KM * 1000 * st.size / EARTH_M, lam = 0.012 + 0.28 * st.clear * st.clear;
		const [y0, y1] = yearRange(), m0 = st.magMin - 1e-4, m1 = st.magMax + 1e-4;
		let best = null, bestScore = Infinity;
		for (const L of layers) {
			if (!L) continue;
			const { pos, attr, n } = L;
			for (let i = 0; i < n; i++) {
				const mg = attr[i * 3], yr = attr[i * 3 + 2];
				if (mg < m0 || mg > m1 || yr < y0 || yr > y1) continue;
				const X = pos[i * 3], Y = pos[i * 3 + 1], Z = pos[i * 3 + 2];
				const w = m[3] * X + m[7] * Y + m[11] * Z + m[15];
				if (w <= 0) continue;
				const sx = ((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w * 0.5 + 0.5) * W;
				const sy = (1 - ((m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w * 0.5 + 0.5)) * H;
				const d = Math.hypot(sx - px, sy - py);
				const rad = Math.max(scale * Math.pow(10, 0.5 * (mg - 6)) * s.focal / w, (mg > M_SPLIT ? 2.2 : 1.1) * dpr);
				const tol = Math.max(rad, 5 * dpr);
				if (d > tol) continue;
				// 透け（地球の裏側は拾わない）
				const dx = X - E[0], dy = Y - E[1], dz = Z - E[2];
				const a = dx * dx + dy * dy + dz * dz, b = E[0] * dx + E[1] * dy + E[2] * dz, c = E[0] * E[0] + E[1] * E[1] + E[2] * E[2] - 1;
				const disc = b * b - a * c;
				if (disc > 0) {
					const sq = Math.sqrt(disc), t0 = Math.min(1, Math.max(0, (-b - sq) / a)), t1 = Math.min(1, Math.max(0, (-b + sq) / a));
					if (Math.exp(-(t1 - t0) * Math.sqrt(a) / lam) < 0.05) continue;
				}
				// 近さ（半径で正規化）を主に、同程度なら大きい地震を優先
				const score = d / tol - mg * 0.02;
				if (score < bestScore) { bestScore = score; best = { L, i }; }
			}
		}
		return best;
	}
	function showInfo({ L, i }, x, y) {
		const mg = L.attr[i * 3], dp = L.attr[i * 3 + 1], t = L.time[i];
		const lat = L.lat[i], lon = L.lon[i];
		const [r, g, b] = depthColor(dp);
		info.innerHTML = `<b>M${mg.toFixed(1)}</b>　<span class="sw" style="background:rgb(${r},${g},${b})"></span>深さ ${dp.toFixed(1)} km<br>
${L.place?.get(i) ? esc(L.place.get(i)) + "<br>" : ""}${fmtTime(t)} UTC<br><span style="color:#9aa6bd">${fmtTime(t, 9)} JST</span><br>
${Math.abs(lat).toFixed(3)}°${lat >= 0 ? "N" : "S"}　${Math.abs(lon).toFixed(3)}°${lon >= 0 ? "E" : "W"}`;
		info.style.left = x + "px"; info.style.top = y + "px"; info.style.display = "block";
	}

	// ── データ読み込み ──
	const worker = new Worker(new URL("./quakes-worker.js", import.meta.url), { type: "module", name: "quakes" });
	const loaded = new Promise((resolve, reject) => {
		worker.onmessage = e => {
			const m = e.data;
			if (m.type === "progress") { notes[m.q] = m.text; renderStatus(); }
			else if (m.type === "part") setPart(m);
			else if (m.type === "error") { $("status").textContent = "読み込みに失敗しました：" + m.message; reject(new Error(m.message)); }
			else if (m.type === "done") {
				notes = notes.map(t => /^USGS/.test(t ?? "") ? t : null);   // 済んだら USGS の要約だけ残す
				if (m.skipped?.length) skippedNote = `<span style="color:#ffb86b">読めなかった分：${esc(m.skipped.join("・"))}（再読み込みで取り直し）</span>`;
				renderStatus(); resolve(m); worker.terminate();
			}
		};
	});
	// src＝URL・ArrayBuffer・{ usgs: 起点（日付か archive.json の URL）}、またはその配列（archive＋USGS 直取りを連結）
	const abs = s => new URL(s, location.href).href;
	const srcs = (Array.isArray(src) ? src : [src]).map(s => typeof s === "string" ? abs(s) : s?.usgs && !/^\d{4}-\d{2}-\d{2}$/.test(s.usgs) ? { usgs: abs(s.usgs) } : s);
	worker.postMessage({ srcs, rAx: ellipsoidOn() ? 1 - 1 / 298.257223563 : 1, earthM: EARTH_M }, srcs.filter(s => s instanceof ArrayBuffer));

	// 層 q を差し替える（USGS 直近分は 1 か月届くごとに来る）
	function setPart(m) {
		const { q, n, pos, attr } = m;
		const old = layers[q];
		if (old) { old.gl.bufs.forEach(b => gl.deleteBuffer(b)); gl.deleteVertexArray(old.gl.spriteVao); gl.deleteVertexArray(old.gl.sphereVao); }
		// M>6 はマグニチュード昇順の末尾にまとまっている
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
		layers[q] = { ...m, nBig: n - k, gl: { bufs: [posBuf, attrBuf], spriteVao, sphereVao } };

		// 年の幅（全層）
		let minY = Infinity, maxY = -Infinity;
		for (const L of layers) if (L) for (let i = 0; i < L.n; i++) { const y = L.attr[i * 3 + 2]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
		if (Number.isFinite(maxY)) {
			dataYearMax = Math.floor(maxY);
			if (st.yearMax >= yearNow) st.yearMax = Math.max(st.yearMax, dataYearMax);
			$("span").textContent = `${Math.floor(minY)}〜${dataYearMax}`;
		}
		syncLabels(); countVisible();
		map.requestDraw(); redraw();
	}

	return {
		loaded, state: st, redraw,
		get count() { return total(); },
		get bigCount() { return layers.reduce((a, L) => a + (L?.nBig ?? 0), 0); },
		get layers() { return layers; },   // console 検証用（層ごとの pos/attr/lon/lat/time の列）
		pick: (x, y) => total() ? pick(x, y) : null,
		destroy() { stopPlay(); clearTags(); removeEventListener("keydown", onKey); clock.remove(); offFrame(); cancelAnimationFrame(catchUp); ro.disconnect(); cv.remove(); panel.remove(); info.remove(); worker.terminate(); map.setOpacity({ globe: 1, base: 1 }); },
	};
}
