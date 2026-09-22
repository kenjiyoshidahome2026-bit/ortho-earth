// 国旗を風にたなびかせる（本人 2026-09-23「国歌をならしている間、大きく見えている旗を風にたなびいているような表現に」）。
// 依存ゼロの WebGL2：旗の画像を 1 枚のテクスチャにして、フラグメントシェーダで uv を波打たせる（左端＝旗竿は動かず、右へ行くほど大きく）。
// 明暗は波の傾き（cos）で付ける＝布のうねり。開始/停止は振幅を 0↔1 へ滑らかに＝止まる時は静かに垂れて元の <img> へ戻す。
// テクスチャの元は SVG＝fetch → Blob → <img> → 2D canvas に描いてから GPU へ（<img src=URL> 直だと汚染で読めない）。
const VS = `#version 300 es
in vec2 a; out vec2 v; void main() { v = vec2(a.x, 1.0 - a.y); gl_Position = vec4(a * 2.0 - 1.0, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float; in vec2 v; out vec4 o;
uniform sampler2D u_tex; uniform float u_t, u_amp, u_pad;
void main() {
	float x = v.x;                                   // 0=旗竿 … 1=自由端
	float sway = u_amp * x;                          // 竿側は固定・自由端ほど揺れる
	float wave = sin(x * 7.0 - u_t * 4.2) * 0.035 + sin(x * 13.0 - u_t * 6.7 + v.y * 3.0) * 0.012;
	float y = (v.y - u_pad) / (1.0 - 2.0 * u_pad) + wave * sway;   // 上下の余白（u_pad）は波で押し出された分の逃げ場
	if (y < 0.0 || y > 1.0) { o = vec4(0.0); return; }
	vec4 c = texture(u_tex, vec2(x, y));
	float slope = cos(x * 7.0 - u_t * 4.2) * 0.35 * sway + cos(x * 13.0 - u_t * 6.7 + v.y * 3.0) * 0.12 * sway;   // 波の傾き＝明暗（光は左から）
	o = vec4(c.rgb * (1.0 + slope * 0.55), c.a);
}`;
const PAD = 0.07;   // 上下の余白比（canvas の中で旗が占める帯の外側＝波の逃げ場）

/** img（旗の <img>）に重ねる。戻り＝{ start(), stop(), destroy() } */
export function createFlagWave(img, { dpr = Math.min(2, devicePixelRatio || 1) } = {}) {
	let canvas = null, gl = null, tex = null, prog = null, raf = 0, amp = 0, target = 0, t0 = performance.now(), last = t0, alive = true, ready = null;
	const mount = async () => {
		if (!img.complete) await new Promise(r => { img.onload = r; img.onerror = r; });
		const rect = img.getBoundingClientRect(), box = img.parentElement.getBoundingClientRect();
		if (!rect.width || !rect.height) throw new Error("flag box empty");
		const padPx = rect.height * PAD / (1 - 2 * PAD);
		canvas = document.createElement("canvas");
		Object.assign(canvas.style, { position: "absolute", left: (rect.left - box.left) + "px", top: (rect.top - box.top - padPx) + "px", width: rect.width + "px", height: (rect.height + 2 * padPx) + "px", filter: getComputedStyle(img).filter, pointerEvents: "none" });
		canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round((rect.height + 2 * padPx) * dpr);
		// テクスチャ＝SVG を表示寸法で 2D 描画（fetch → Blob → 同一オリジンの blob: URL＝汚染しない）
		const blob = await fetch(img.src).then(r => r.blob());
		const url = URL.createObjectURL(blob), im = new Image();
		await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = url; });
		const cv = document.createElement("canvas"); cv.width = Math.round(rect.width * dpr); cv.height = Math.round(rect.height * dpr);
		cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url);
		gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true });
		if (!gl) throw new Error("no webgl2");
		const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
		prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
		const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
		const vao = gl.createVertexArray(); gl.bindVertexArray(vao); const loc = gl.getAttribLocation(prog, "a"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
		tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.useProgram(prog); gl.uniform1f(gl.getUniformLocation(prog, "u_pad"), PAD);
		gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	};
	const frame = now => {
		raf = 0; if (!alive || !gl) return;
		const dt = Math.min(0.1, (now - last) / 1000); last = now;
		amp += (target - amp) * Math.min(1, dt * (target > amp ? 2.5 : 1.8));   // 立ち上がりは早め・止まる時はゆっくり垂れる
		gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
		gl.useProgram(prog);
		gl.uniform1f(gl.getUniformLocation(prog, "u_t"), (now - t0) / 1000); gl.uniform1f(gl.getUniformLocation(prog, "u_amp"), amp);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		if (target > 0 || amp > 0.004) raf = requestAnimationFrame(frame);
		else { canvas.style.display = "none"; img.style.visibility = ""; }   // 止まり切ったら元の <img> へ
	};
	const kick = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
	return {
		async start() {
			ready ??= mount().catch(e => { console.warn("[flag] wave unavailable", e); alive = false; });
			await ready; if (!alive || !canvas) return;
			if (!canvas.isConnected) img.parentElement.appendChild(canvas);
			canvas.style.display = ""; img.style.visibility = "hidden";   // 静止画と入れ替え（見た目は同じ寸法・同じ影）
			target = 1; kick();
		},
		stop() { target = 0; kick(); },
		destroy() { alive = false; if (raf) cancelAnimationFrame(raf); raf = 0; img.style.visibility = ""; canvas?.remove(); gl?.getExtension("WEBGL_lose_context")?.loseContext(); gl = null; },
	};
}
