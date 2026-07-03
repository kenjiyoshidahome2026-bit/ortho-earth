// WebGL2 レンダラ：可視タイルを跨いで同一 style層を1バッファに結合した「シーン」を描く。
// draw call は「タイル数×層数」から「層数」へ激減し、uniform も1フレーム1回。共通のシーン原点で投影。
// fill = earcut三角形、line = capsule(SDF)。scene.layers は style層順（painter's algorithm）。
import { FILL_VS, FILL_FS, LINE_VS, LINE_FS } from "./glsl.js";

const CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, -1, 0, 1, 1, 1]); // 6頂点×(end,side)

export function createRenderer(canvas) {
	const gl = canvas.getContext("webgl2", { antialias: true, premultipliedAlpha: true });
	if (!gl) throw new Error("WebGL2 unavailable");

	const fillProg = program(gl, FILL_VS, FILL_FS);
	const lineProg = program(gl, LINE_VS, LINE_FS);
	const cornerBuf = buffer(gl, CORNERS);
	// base=粗い下書き（underlay）、main=現ズーム。draw で base→main の順に描く。
	const scenes = { base: { origin: [0, 0], draws: [] }, main: { origin: [0, 0], draws: [] } };

	// s: { origin:[lon,lat], layers:[{kind:'fill'|'line', ...typed arrays}] }（style層順）。slot: 'base'|'main'
	function setScene(s, slot = "main") {
		disposeSlot(slot);
		const draws = [];
		for (const L of s.layers) {
			if (!L) continue;
			if (L.kind === "fill") {
				if (!L.pos.length) continue;
				const vao = gl.createVertexArray();
				const bPos = buffer(gl, L.pos), bCol = buffer(gl, L.col);
				gl.bindVertexArray(vao);
				attrib(gl, fillProg, "a_delta", bPos, 2);
				attrib(gl, fillProg, "a_color", bCol, 4);
				gl.bindVertexArray(null);
				draws.push({ kind: "fill", vao, count: L.pos.length / 2, bufs: [bPos, bCol] });
			} else {
				if (!L.half.length) continue;
				const vao = gl.createVertexArray();
				const bP1 = buffer(gl, L.P1), bP2 = buffer(gl, L.P2), bCol = buffer(gl, L.col), bHalf = buffer(gl, L.half);
				gl.bindVertexArray(vao);
				attrib(gl, lineProg, "a_corner", cornerBuf, 2, 0);
				attrib(gl, lineProg, "a_p1", bP1, 2, 1);
				attrib(gl, lineProg, "a_p2", bP2, 2, 1);
				attrib(gl, lineProg, "a_color", bCol, 4, 1);
				attrib(gl, lineProg, "a_half", bHalf, 1, 1);
				gl.bindVertexArray(null);
				draws.push({ kind: "line", vao, count: L.half.length, bufs: [bP1, bP2, bCol, bHalf] });
			}
		}
		scenes[slot] = { origin: s.origin, draws };
	}

	function setCommonUniforms(prog, cam, origin) {
		gl.useProgram(prog);
		gl.uniform2f(loc(gl, prog, "u_origin"), origin[0], origin[1]);
		gl.uniform2f(loc(gl, prog, "u_center"), cam.center[0], cam.center[1]);
		gl.uniform1f(loc(gl, prog, "u_scale"), cam.scale);
		gl.uniform2f(loc(gl, prog, "u_translate"), cam.translate[0], cam.translate[1]);
		gl.uniform2f(loc(gl, prog, "u_viewport"), canvas.width, canvas.height);
	}

	function draw(cam) {
		gl.viewport(0, 0, canvas.width, canvas.height);
		const c = cam.clear || [1, 1, 1, 1];
		gl.clearColor(c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.disable(gl.DEPTH_TEST);
		gl.uniform1f(loc(gl, lineProg, "u_dpr"), cam.dpr || 1);

		for (const slot of ["base", "main"]) {   // 粗い下書き→現ズームの順
			const scene = scenes[slot];
			if (!scene.draws.length) continue;
			setCommonUniforms(fillProg, cam, scene.origin);
			setCommonUniforms(lineProg, cam, scene.origin);
			let curProg = null;
			for (const d of scene.draws) {
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

	function disposeSlot(slot) {
		for (const d of scenes[slot].draws) { for (const b of d.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(d.vao); }
		scenes[slot] = { origin: scenes[slot].origin, draws: [] };
	}
	function dispose() { disposeSlot("base"); disposeSlot("main"); }

	return { gl, setScene, draw, dispose };
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
