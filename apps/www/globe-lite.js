// トップの背景＝軽い地球（正距円筒の webp 1 枚を正射投影の球に貼って回すだけ）。
// エンジン（ortho-japan）は載せない：背景に要るのは「回る地球の絵」だけ＝88KB の画像と 150 行の WebGL で足りる。
// デモ用の重いデータは prefetch.js が背後で IDB に入れる（/japan/ を開いた時に効く）。
// 構図は旧 v1 / v2 背景と同じ＝半径は画面短辺の 0.4・中心経緯度 (0,0) から東へ 4°/s。
// WebGL2＝textureGrad で経度の継ぎ目（u=0/1）でもミップが正しい／WebGL1＝ミップ無しの線形（継ぎ目の筋を出さない）。
// prefers-reduced-motion では回さない。WebGL が無ければ何も描かない（カードが本題＝背景は黒のまま）。

const VS = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
const FS_BODY = `
uniform vec2 uCenter; uniform float uR; uniform float uLon; uniform float uLat; uniform float uDpr;
const float PI = 3.141592653589793;
vec4 shade(vec2 frag, out vec2 uv, out bool hit) {
	vec2 q = (frag - uCenter) / uR;   // gl_FragCoord は下から上＝q.y>0 が北
	float d2 = dot(q, q);
	hit = d2 < 1.0;
	if (!hit) {   // 大気の縁（外側へ薄れる青い輪）
		float d = sqrt(d2), g = exp(-(d - 1.0) * 14.0) * 0.55;
		return vec4(0.45, 0.62, 0.95, 1.0) * g;
	}
	float z = sqrt(1.0 - d2);
	vec3 v = vec3(q.x, q.y, z);   // 視点座標（z=手前）
	float cl = cos(uLat), sl = sin(uLat);
	vec3 w = vec3(v.x, v.y * cl + v.z * sl, -v.y * sl + v.z * cl);   // 中心緯度だけ傾ける
	float lat = asin(clamp(w.y, -1.0, 1.0));
	float lon = atan(w.x, w.z) + uLon;
	uv = vec2(fract(lon / (2.0 * PI) + 0.5), 0.5 - lat / PI);
	float limb = mix(0.55, 1.0, pow(z, 0.45));   // 縁を少し沈める（球らしさ）
	float rim = smoothstep(0.82, 1.0, sqrt(d2)) * 0.25;   // 縁に大気の青をうっすら
	return vec4(limb, rim, 0.0, 1.0);
}`;
const FS2 = `#version 300 es
precision highp float;
uniform sampler2D uTex;
${FS_BODY}
out vec4 o;
void main(){
	vec2 uv; bool hit;
	vec4 s = shade(gl_FragCoord.xy, uv, hit);
	if (!hit) { o = s; return; }
	vec2 dx = dFdx(uv), dy = dFdy(uv);
	dx.x -= floor(dx.x + 0.5); dy.x -= floor(dy.x + 0.5);   // 経度の継ぎ目で微分が 1 飛ぶ＝折り返してミップの暴走を止める
	vec3 c = textureGrad(uTex, uv, dx, dy).rgb * s.x;
	o = vec4(mix(c, vec3(0.55, 0.72, 1.0), s.y), 1.0);
}`;
const FS1 = `precision highp float;
uniform sampler2D uTex;
${FS_BODY}
void main(){
	vec2 uv; bool hit;
	vec4 s = shade(gl_FragCoord.xy, uv, hit);
	if (!hit) { gl_FragColor = s; return; }
	vec3 c = texture2D(uTex, uv).rgb * s.x;
	gl_FragColor = vec4(mix(c, vec3(0.55, 0.72, 1.0), s.y), 1.0);
}`;

export function liteGlobe(host, { src, degPerSec = 4, lat0 = 0, lon0 = 0, onFirstFrame } = {}) {
	const canvas = document.createElement("canvas");
	Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", display: "block" });
	host.appendChild(canvas);
	const opts = { alpha: true, premultipliedAlpha: true, antialias: true };
	let gl = canvas.getContext("webgl2", opts), v2 = !!gl;
	if (!gl) gl = canvas.getContext("webgl", opts);
	if (!gl) { canvas.remove(); return null; }
	const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
	const prog = gl.createProgram();
	gl.attachShader(prog, sh(gl.VERTEX_SHADER, v2 ? "#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }" : VS));
	gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, v2 ? FS2 : FS1));
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("[globe-lite]", gl.getProgramInfoLog(prog)); canvas.remove(); return null; }
	gl.useProgram(prog);
	const buf = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
	const loc = gl.getAttribLocation(prog, "p");
	gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
	const U = n => gl.getUniformLocation(prog, n);
	const uCenter = U("uCenter"), uR = U("uR"), uLon = U("uLon"), uLat = U("uLat");
	gl.uniform1i(U("uTex"), 0);
	gl.uniform1f(uLat, lat0 * Math.PI / 180);

	let ready = false, lon = lon0 * Math.PI / 180, t0 = 0, raf = 0, W = 0, H = 0;
	const tex = gl.createTexture();
	const img = new Image();
	img.decoding = "async";
	img.onload = () => {
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		if (v2) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
		else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		ready = true;
		draw();
		canvas.style.opacity = "0"; canvas.style.transition = "opacity .6s ease";
		requestAnimationFrame(() => { canvas.style.opacity = "1"; });   // 出る時はふわっと
		onFirstFrame?.();
		if (spinning) start();
	};
	img.onerror = () => console.warn("[globe-lite] texture failed", src);
	img.src = src;

	const resize = () => {
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		W = Math.max(1, Math.round(host.clientWidth * dpr)); H = Math.max(1, Math.round(host.clientHeight * dpr));
		if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
		gl.viewport(0, 0, W, H);
		gl.uniform2f(uCenter, W / 2, H / 2);
		gl.uniform1f(uR, Math.min(W, H) * 0.4);
		if (ready && !raf) draw();
	};
	function draw() {
		gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
		if (!ready) return;
		gl.uniform1f(uLon, lon);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}
	const step = t => {
		const dt = Math.min(0.1, (t - t0) / 1000); t0 = t;
		lon += degPerSec * dt * Math.PI / 180;
		draw();
		raf = requestAnimationFrame(step);
	};
	const start = () => { if (raf || !ready) return; t0 = performance.now(); raf = requestAnimationFrame(step); };
	const stop = () => { cancelAnimationFrame(raf); raf = 0; };
	const motionMq = matchMedia("(prefers-reduced-motion: reduce)");
	let spinning = !motionMq.matches;
	motionMq.addEventListener?.("change", () => { spinning = !motionMq.matches; spinning ? start() : stop(); });
	const ro = new ResizeObserver(resize); ro.observe(host);
	resize();
	return { canvas, destroy() { stop(); ro.disconnect(); canvas.remove(); } };
}
