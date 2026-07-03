// SDFテキスト・レンダラ：グリフアトラス(R8)をテクスチャ化し、各ラベルを球面アンカー上の
// スクリーン空間ビルボードとして描く。ハロー付き。描画毎に投影→簡易スクリーン衝突→可視ラベルのみ頂点生成。
import { PROJECT } from "./glsl.js";
import { layoutText } from "../labels.js";
import { projectDelta } from "../project.js";

const VS = `#version 300 es
precision highp float;
in vec2 a_anchor;   // lonlat delta（アンカー）
in vec2 a_offset;   // アンカーからのオフセット（CSS px, y下向き）
in vec2 a_uv;       // アトラス画素座標
in vec4 a_fill;
in vec4 a_halo;
in float a_halow;   // ハロー幅(px)
uniform float u_dpr;
uniform vec2 u_atlas;
${PROJECT}
out vec2 v_uv;
out vec4 v_fill;
out vec4 v_halo;
out float v_halow;
out float v_front;
void main() {
	vec3 p = projectDelta(a_anchor);
	vec2 anchorPx = floor(p.xy + 0.5);          // アンカーを整数devピクセルにスナップ＝滲み防止
	vec2 screen = anchorPx + a_offset * u_dpr;
	v_uv = a_uv / u_atlas;
	v_fill = a_fill; v_halo = a_halo; v_halow = a_halow; v_front = p.z;
	gl_Position = toNDC(screen);
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
in vec4 v_fill;
in vec4 v_halo;
in float v_halow;
in float v_front;
out vec4 fragColor;
const float EDGE = 0.75;          // SDF エッジ（MapLibre準拠）
void main() {
	if (v_front < 0.0) discard;
	float d = texture(u_tex, v_uv).r;
	float aa = clamp(0.6 * fwidth(d), 0.008, 0.25);          // AA幅を締めてシャープに
	float fillA = smoothstep(EDGE - aa, EDGE + aa, d) * v_fill.a;
	float haloEdge = EDGE - clamp(v_halow, 0.0, 3.0) / 6.0;   // ハロー幅ぶん外へ
	float haloA = smoothstep(haloEdge - aa, haloEdge + aa, d) * v_halo.a;
	float outA = fillA + haloA * (1.0 - fillA);
	if (outA <= 0.0) discard;
	vec3 rgb = (v_fill.rgb * fillA + v_halo.rgb * haloA * (1.0 - fillA)) / outA;
	fragColor = vec4(rgb * outA, outA);   // premultiplied
}`;

export function createTextRenderer(gl) {
	const prog = program(gl, VS, FS);
	const tex = gl.createTexture();
	let atlasVersion = -1, atlasSize = 0;
	let labels = [];         // { anchor, quads, bbox:[minX,minY,maxX,maxY], fill, halo, haloW, sort }
	const vao = gl.createVertexArray();
	const buffers = {};
	let capacity = 0;

	function uploadAtlas(atlas) {
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, atlas.size, atlas.size, 0, gl.RED, gl.UNSIGNED_BYTE, atlas.data);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		atlasVersion = atlas.version; atlasSize = atlas.size;
	}

	// labels: buildLabels の出力配列。atlas: 梱包済み GlyphAtlas。
	function setLabels(list, font, atlas) {
		if (atlas.version !== atlasVersion) uploadAtlas(atlas);
		labels = [];
		for (const L of list) {
			const lay = layoutText(atlas, font, L.text, L.size);
			if (!lay.quads.length) continue;
			let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
			for (const q of lay.quads) { minX = Math.min(minX, q.x0); minY = Math.min(minY, q.y0); maxX = Math.max(maxX, q.x1); maxY = Math.max(maxY, q.y1); }
			labels.push({ anchor: L.anchor, quads: lay.quads, bbox: [minX, minY, maxX, maxY], fill: L.color, halo: L.halo, haloW: L.haloW, sort: L.sort });
		}
		labels.sort((a, b) => a.sort - b.sort);   // sort-key 昇順＝優先度高い順に配置
	}

	function draw(cam) {
		if (!labels.length) return;
		const dpr = cam.dpr || 1, W = gl.canvas.width, H = gl.canvas.height;
		const pad = 7 * dpr;               // ラベル間の最小余白（詰まり防止）
		const lcam = { origin: [0, 0], center: cam.center, scale: cam.scale, translate: cam.translate };  // ラベルは絶対座標
		const placed = [];                 // 衝突用に確保済みのボックス（device px）
		const visible = [];
		for (const L of labels) {
			const [sx, sy, front] = projectDelta(lcam, L.anchor[0], L.anchor[1]);
			if (front < 0) continue;
			const box = [sx + L.bbox[0] * dpr - pad, sy + L.bbox[1] * dpr - pad, sx + L.bbox[2] * dpr + pad, sy + L.bbox[3] * dpr + pad];
			if (box[2] < 0 || box[0] > W || box[3] < 0 || box[1] > H) continue;    // 画面外
			if (placed.some(b => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue; // 衝突
			placed.push(box); visible.push({ L, sx, sy });
		}
		if (!visible.length) return;

		// 頂点生成（可視ラベルの各グリフ矩形 → 2三角形）
		let n = 0; for (const v of visible) n += v.L.quads.length * 6;
		ensure(n);
		const A = buffers.anchor.arr, O = buffers.offset.arr, U = buffers.uv.arr, F = buffers.fill.arr, Hc = buffers.halo.arr, Hw = buffers.halow.arr;
		let i = 0;
		for (const { L } of visible) {
			for (const q of L.quads) {
				const corners = [[q.x0, q.y0, q.u0, q.v0], [q.x1, q.y0, q.u1, q.v0], [q.x0, q.y1, q.u0, q.v1], [q.x1, q.y0, q.u1, q.v0], [q.x1, q.y1, q.u1, q.v1], [q.x0, q.y1, q.u0, q.v1]];
				for (const [ox, oy, u, v] of corners) {
					A[i * 2] = L.anchor[0]; A[i * 2 + 1] = L.anchor[1];
					O[i * 2] = ox; O[i * 2 + 1] = oy;
					U[i * 2] = u; U[i * 2 + 1] = v;
					F[i * 4] = L.fill[0]; F[i * 4 + 1] = L.fill[1]; F[i * 4 + 2] = L.fill[2]; F[i * 4 + 3] = L.fill[3];
					Hc[i * 4] = L.halo[0]; Hc[i * 4 + 1] = L.halo[1]; Hc[i * 4 + 2] = L.halo[2]; Hc[i * 4 + 3] = L.halo[3];
					Hw[i] = L.haloW;
					i++;
				}
			}
		}
		upload();

		gl.useProgram(prog);
		gl.uniform1f(loc(gl, prog, "u_dpr"), dpr);
		gl.uniform2f(loc(gl, prog, "u_atlas"), atlasSize, atlasSize);
		gl.uniform2f(loc(gl, prog, "u_origin"), 0, 0);
		gl.uniform2f(loc(gl, prog, "u_center"), cam.center[0], cam.center[1]);
		gl.uniform1f(loc(gl, prog, "u_scale"), cam.scale);
		gl.uniform2f(loc(gl, prog, "u_translate"), cam.translate[0], cam.translate[1]);
		gl.uniform2f(loc(gl, prog, "u_viewport"), W, H);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.uniform1i(loc(gl, prog, "u_tex"), 0);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.bindVertexArray(vao);
		gl.drawArrays(gl.TRIANGLES, 0, i);
		gl.bindVertexArray(null);
	}

	function ensure(n) {
		if (n <= capacity) return;
		capacity = Math.max(n, capacity * 2, 1024);
		const defs = [["anchor", 2], ["offset", 2], ["uv", 2], ["fill", 4], ["halo", 4], ["halow", 1]];
		gl.bindVertexArray(vao);
		for (const [name, size] of defs) {
			const b = buffers[name] || (buffers[name] = { buf: gl.createBuffer() });
			b.arr = new Float32Array(capacity * size); b.size = size;
			gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
			gl.bufferData(gl.ARRAY_BUFFER, b.arr.byteLength, gl.DYNAMIC_DRAW);
			const l = gl.getAttribLocation(prog, "a_" + name);
			if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); }
		}
		gl.bindVertexArray(null);
	}
	function upload() {
		for (const name of ["anchor", "offset", "uv", "fill", "halo", "halow"]) {
			const b = buffers[name];
			gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.arr);
		}
	}

	return { setLabels, draw };
}

// --- GL ヘルパ（renderer.js と同型） ---
function program(gl, vs, fs) {
	const p = gl.createProgram();
	gl.attachShader(p, sh(gl, gl.VERTEX_SHADER, vs));
	gl.attachShader(p, sh(gl, gl.FRAGMENT_SHADER, fs));
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("text link: " + gl.getProgramInfoLog(p));
	return p;
}
function sh(gl, t, src) {
	const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
	if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("text compile: " + gl.getShaderInfoLog(s) + "\n" + src);
	return s;
}
const _lc = new WeakMap();
function loc(gl, p, n) { let m = _lc.get(p); if (!m) _lc.set(p, m = new Map()); if (!m.has(n)) m.set(n, gl.getUniformLocation(p, n)); return m.get(n); }
