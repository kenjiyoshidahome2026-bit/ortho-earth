// WebGL2 レンダラ：build の op列（style層順）をそのままの順序で描く＝厳密な painter's algorithm。
// fill = earcut三角形、line = capsule(SDF)。層順を守るのでビル塗り/道路/外周線の前後関係が正しくなる。
import { FILL_VS, FILL_FS, LINE_VS, LINE_FS } from "./glsl.js";

const CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, -1, 0, 1, 1, 1]); // 6頂点×(end,side)

export function createRenderer(canvas) {
	const gl = canvas.getContext("webgl2", { antialias: true, premultipliedAlpha: true });
	if (!gl) throw new Error("WebGL2 unavailable");

	const fillProg = program(gl, FILL_VS, FILL_FS);
	const lineProg = program(gl, LINE_VS, LINE_FS);
	const cornerBuf = buffer(gl, CORNERS);

	const tiles = new Map();   // key → draws[]（タイル毎の GL リソース）

	function uploadTile(key, { ops }) {
		if (tiles.has(key)) removeTile(key);
		const draws = [];
		for (const op of ops) {
			if (op.kind === "fill") {
				const vao = gl.createVertexArray();
				const bPos = buffer(gl, op.pos), bCol = buffer(gl, op.col);
				gl.bindVertexArray(vao);
				attrib(gl, fillProg, "a_delta", bPos, 2);
				attrib(gl, fillProg, "a_color", bCol, 4);
				gl.bindVertexArray(null);
				draws.push({ kind: "fill", vao, count: op.pos.length / 2, bufs: [bPos, bCol] });
			} else {
				const vao = gl.createVertexArray();
				const bP1 = buffer(gl, op.P1), bP2 = buffer(gl, op.P2), bCol = buffer(gl, op.col), bHalf = buffer(gl, op.half);
				gl.bindVertexArray(vao);
				attrib(gl, lineProg, "a_corner", cornerBuf, 2, 0);
				attrib(gl, lineProg, "a_p1", bP1, 2, 1);
				attrib(gl, lineProg, "a_p2", bP2, 2, 1);
				attrib(gl, lineProg, "a_color", bCol, 4, 1);
				attrib(gl, lineProg, "a_half", bHalf, 1, 1);
				gl.bindVertexArray(null);
				draws.push({ kind: "line", vao, count: op.half.length, bufs: [bP1, bP2, bCol, bHalf] });
			}
		}
		tiles.set(key, draws);
	}

	function removeTile(key) {
		const draws = tiles.get(key); if (!draws) return;
		for (const d of draws) { for (const b of d.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(d.vao); }
		tiles.delete(key);
	}
	function hasTile(key) { return tiles.has(key); }

	function setCommonUniforms(prog, cam, origin) {
		gl.useProgram(prog);
		gl.uniform2f(loc(gl, prog, "u_origin"), origin[0], origin[1]);
		gl.uniform2f(loc(gl, prog, "u_center"), cam.center[0], cam.center[1]);
		gl.uniform1f(loc(gl, prog, "u_scale"), cam.scale);
		gl.uniform2f(loc(gl, prog, "u_translate"), cam.translate[0], cam.translate[1]);
		gl.uniform2f(loc(gl, prog, "u_viewport"), canvas.width, canvas.height);
	}

	// order: [{ key, origin:[lon,lat] }] 描画するタイル（各自の原点で投影）。
	function draw(cam, order) {
		gl.viewport(0, 0, canvas.width, canvas.height);
		const c = cam.clear || [1, 1, 1, 1];
		gl.clearColor(c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.disable(gl.DEPTH_TEST);

		for (const { key, origin } of order) {
			const draws = tiles.get(key); if (!draws) continue;
			setCommonUniforms(fillProg, cam, origin);
			setCommonUniforms(lineProg, cam, origin);
			gl.uniform1f(loc(gl, lineProg, "u_dpr"), cam.dpr || 1);
			let curProg = null;
			for (const d of draws) {
				if (d.kind === "fill") {
					if (curProg !== fillProg) { gl.useProgram(fillProg); curProg = fillProg; }
					gl.bindVertexArray(d.vao);
					gl.drawArrays(gl.TRIANGLES, 0, d.count);
				} else {
					if (curProg !== lineProg) { gl.useProgram(lineProg); curProg = lineProg; }
					gl.bindVertexArray(d.vao);
					gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, d.count);
				}
			}
		}
		gl.bindVertexArray(null);
	}

	function dispose() { for (const key of [...tiles.keys()]) removeTile(key); }

	return { gl, uploadTile, removeTile, hasTile, draw, dispose };
}

// --- GL ヘルパ ---
function program(gl, vsSrc, fsSrc) {
	const p = gl.createProgram();
	gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vsSrc));
	gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fsSrc));
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
	return p;
}
function shader(gl, type, src) {
	const s = gl.createShader(type);
	gl.shaderSource(s, src); gl.compileShader(s);
	if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("compile: " + gl.getShaderInfoLog(s) + "\n" + src);
	return s;
}
function buffer(gl, data) {
	const b = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, b);
	gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
	return b;
}
const _locCache = new WeakMap();
function loc(gl, prog, name) {
	let m = _locCache.get(prog); if (!m) _locCache.set(prog, m = new Map());
	if (!m.has(name)) m.set(name, gl.getUniformLocation(prog, name));
	return m.get(name);
}
function attrib(gl, prog, name, buf, size, divisor) {
	const l = gl.getAttribLocation(prog, name);
	if (l < 0) return;
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	gl.enableVertexAttribArray(l);
	gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0);
	if (divisor != null) gl.vertexAttribDivisor(l, divisor);
}
