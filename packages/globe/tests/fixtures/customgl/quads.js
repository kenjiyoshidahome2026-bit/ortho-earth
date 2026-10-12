// 検定用の custom 層モジュール（worker 経路・t-customgl.html・PR-7）＝params.quads の縦向きの四角（東西 size m×高さ size m・中心 lon/lat/h）を
// MapLibre の custom 層と同じ書き方（args.defaultProjectionData.mainMatrix＝メルカトル (x, y, z) → クリップ）で描く。依存ゼロ。
const R = 6371008.8, PI = Math.PI;
const mx = lng => (180 + lng) / 360, my = lat => (180 - 180 / PI * Math.log(Math.tan(PI / 4 + lat * PI / 360))) / 360;
export function createLayer(params = {}) {
	let prog = null, buf = null, uM = null, n = 0, calls = 0;
	const bake = gl => {
		const v = [];
		for (const q of params.quads || []) {
			const k = 1 / (2 * PI * R * Math.cos(q.lat * PI / 180)), x = mx(q.lon), y = my(q.lat), dx = q.size / 2 * k, z0 = (q.h - q.size / 2) * k, z1 = (q.h + q.size / 2) * k, c = q.color || [1, 0, 0];
			for (const [X, Z] of [[x - dx, z0], [x + dx, z0], [x + dx, z1], [x - dx, z0], [x + dx, z1], [x - dx, z1]]) v.push(X, y, Z, c[0], c[1], c[2]);
		}
		n = v.length / 6;
		gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
	};
	return {
		id: params.id || "quads", type: "custom", renderingMode: params.renderingMode || "3d",
		get calls() { return calls; },
		onAdd(_map, gl) {
			const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
			prog = gl.createProgram();
			gl.attachShader(prog, mk(gl.VERTEX_SHADER, "#version 300 es\nuniform mat4 u_m; layout(location=0) in vec3 a; layout(location=1) in vec3 c; out vec3 v; void main(){ v = c; gl_Position = u_m * vec4(a, 1.0); }"));
			gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, "#version 300 es\nprecision highp float; in vec3 v; out vec4 o; void main(){ o = vec4(v, 1.0); }"));
			gl.linkProgram(prog); uM = gl.getUniformLocation(prog, "u_m");
			buf = gl.createBuffer(); bake(gl);
		},
		render(gl, args) {
			calls++;
			gl.useProgram(prog); gl.uniformMatrix4fv(uM, false, Float32Array.from(args.defaultProjectionData.mainMatrix));
			gl.bindBuffer(gl.ARRAY_BUFFER, buf);
			gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
			gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
			gl.drawArrays(gl.TRIANGLES, 0, n);
		},
		onMessage(d, map) { if (d?.type === "quads") { params.quads = d.quads; bake(map.getCanvas().getContext("webgl2")); map.triggerRepaint(); } },
		onRemove(_map, gl) { gl.deleteProgram(prog); gl.deleteBuffer(buf); prog = buf = null; },
	};
}
