// 面の貼り付け（分類・classification・2026-10-25）＝Cesium の ClassificationPrimitive／GroundPrimitive（classificationType）。
// 多角形を上下に伸ばした閉じた柱（体積）を、描き終えた深度（地形・建物・3D Tiles・模型）に当てて、柱の内側にある面の画素だけを塗る。
// 手順＝影の体積（z-fail）：①色を書かずに柱の面を描き、深度で負けた裏面 +1・表面 −1（巻き数＝stencil の 0-6 ビット）
// ②（地形だけ）建物 bit7 が立つ画素の巻き数を 0 へ ③巻き数≠0 の画素を塗って 0 へ戻す（「3D だけ」は bit7 が立つ画素だけ）④残りを 0 へ。
// bit7（0x80）＝renderer が建物・メッシュ（3D Tiles・模型を含む）の見えている画素に刻む印＝gint の面ドレープと同じ物を読むだけで書かない。
// 柱の面は大きい三角形＝対数深度を頂点だけで焼くと内側が撓む＝画素ごとに書く（WebGPU の fragDepthOf と同じ式）。
// 柱の頂点は β 単位球の原点相対（メッシュと同じ RTE）＝gl_Position＝clip(origin)＋mvp·delta。
import * as mat from "../mat.ts";
import type { ClassifyIn, ClassifyStyle } from "../classify.ts";

interface Vol { vao: WebGLVertexArrayObject; bufs: WebGLBuffer[]; count: number; origin: number[]; color: number[]; type: number }

const VS = `#version 300 es
precision highp float;
in vec3 a_pos;
uniform mat4 u_mvp;
uniform vec4 u_clip;
uniform float u_logCoef;
out float v_w;
void main() {
	gl_Position = u_clip + u_mvp * vec4(a_pos, 0.0);
	v_w = gl_Position.w;
	gl_Position.z = (log2(max(1.0 + gl_Position.w, 1e-6)) * u_logCoef - 1.0) * gl_Position.w;
}`;
const FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
uniform float u_logCoef;
in float v_w;
out vec4 o;
float log1pS(float w) { if (w < 0.1) return w * (1.0 - w * (0.5 - w * (0.33333334 - w * (0.25 - w * (0.2 - w * (0.16666667 - w * 0.14285715)))))); return log(1.0 + w); }
void main() {
	gl_FragDepth = clamp(log1pS(max(v_w, 1e-30)) * 1.4426950 * u_logCoef * 0.5, 0.0, 1.0);
	o = vec4(u_color.rgb * u_color.a, u_color.a);
}`;

export function createClassifyGL(gl: WebGL2RenderingContext) {
	const vols = new Map<string, Vol>();
	let prog: WebGLProgram | null = null;
	let U: Record<string, WebGLUniformLocation | null> = {};
	const compile = (): WebGLProgram => {
		const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("[classify] " + gl.getShaderInfoLog(s)); return s; };
		const p = gl.createProgram()!, v = sh(gl.VERTEX_SHADER, VS), f = sh(gl.FRAGMENT_SHADER, FS);
		gl.attachShader(p, v); gl.attachShader(p, f); gl.bindAttribLocation(p, 0, "a_pos"); gl.linkProgram(p);
		gl.deleteShader(v); gl.deleteShader(f);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("[classify] " + gl.getProgramInfoLog(p));
		U = Object.fromEntries(["u_mvp", "u_clip", "u_logCoef", "u_color"].map(n => [n, gl.getUniformLocation(p, n)]));
		return p;
	};
	const free = (v: Vol) => { gl.deleteVertexArray(v.vao); for (const b of v.bufs) gl.deleteBuffer(b); };
	function set(key: string, data: ClassifyIn | null | undefined): void {
		const old = vols.get(key);
		if (old) { free(old); vols.delete(key); }
		if (!data || !data.pos?.length || !data.idx?.length) return;
		const vao = gl.createVertexArray()!, vbo = gl.createBuffer()!, ibo = gl.createBuffer()!;
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, data.pos, gl.STATIC_DRAW);
		gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.idx, gl.STATIC_DRAW);
		gl.bindVertexArray(null);
		gl.bindBuffer(gl.ARRAY_BUFFER, null);
		vols.set(key, { vao, bufs: [vbo, ibo], count: data.idx.length, origin: Array.from(data.origin).slice(0, 3), color: Array.from(data.color).slice(0, 4), type: data.type ?? 0 });
	}
	function style(key: string, s: ClassifyStyle | null | undefined): void {
		const v = vols.get(key); if (!v || !s) return;
		if (s.color) v.color = Array.from(s.color).slice(0, 4);
		if (s.type != null) v.type = s.type;
	}
	// 描き終えた深度の上で（建物・メッシュの後・深度テストの状態は問わない）。戻すのは既定の状態（深度テスト有・書込み有・stencil 無効・色全部）
	function draw(st: { mvp: ArrayLike<number>; mvp32: Float32Array }, logCoef: number): void {
		if (!vols.size) return;
		prog ??= compile();
		gl.useProgram(prog);
		gl.uniformMatrix4fv(U.u_mvp, false, st.mvp32);
		gl.uniform1f(U.u_logCoef, logCoef);
		gl.enable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE);
		gl.depthMask(false);
		for (const v of vols.values()) {
			if (!(v.color[3] > 0)) continue;
			const c = mat.transform(st.mvp as number[], [v.origin[0], v.origin[1], v.origin[2], 1]);
			gl.uniform4f(U.u_clip, c[0], c[1], c[2], c[3]);
			gl.uniform4f(U.u_color, v.color[0], v.color[1], v.color[2], v.color[3]);
			gl.bindVertexArray(v.vao);
			// ① z-fail：深度で負けた裏面 +1・表面 −1（巻き数＝0-6 ビット・bit7 は触らない）
			gl.colorMask(false, false, false, false);
			gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
			gl.stencilMask(0x7F); gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
			gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.INCR_WRAP, gl.KEEP);
			gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.DECR_WRAP, gl.KEEP);
			gl.drawElements(gl.TRIANGLES, v.count, gl.UNSIGNED_INT, 0);
			gl.disable(gl.DEPTH_TEST);
			// ② 地形だけ＝建物 bit7 の画素の巻き数を 0 へ（REPLACE は ref 0x80 を stencilMask 0x7F で書く＝0）
			if (v.type === 1) {
				gl.stencilFunc(gl.EQUAL, 0x80, 0x80); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
				gl.drawElements(gl.TRIANGLES, v.count, gl.UNSIGNED_INT, 0);
			}
			// ③ 塗り（柱の全部の面＝最初に通った面が 0 へ戻す＝一画素一回）。3D だけ＝0x80 < s（bit7 が立ち巻き数≠0）
			gl.colorMask(true, true, true, true);
			if (v.type === 2) gl.stencilFunc(gl.LESS, 0x80, 0xFF); else gl.stencilFunc(gl.NOTEQUAL, 0, 0x7F);
			gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
			gl.drawElements(gl.TRIANGLES, v.count, gl.UNSIGNED_INT, 0);
			// ④ 3D だけ＝塗らなかった巻き数（bit7 の無い画素）を 0 へ（次の柱・gint の winding へ持ち越さない）
			if (v.type === 2) {
				gl.colorMask(false, false, false, false);
				gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
				gl.drawElements(gl.TRIANGLES, v.count, gl.UNSIGNED_INT, 0);
				gl.colorMask(true, true, true, true);
			}
		}
		gl.bindVertexArray(null);
		gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP); gl.stencilFunc(gl.ALWAYS, 0, 0xFF); gl.stencilMask(0xFF);
		gl.disable(gl.STENCIL_TEST);
		gl.depthMask(true); gl.depthFunc(gl.LESS); gl.enable(gl.DEPTH_TEST);
	}
	function dispose(): void { for (const v of vols.values()) free(v); vols.clear(); if (prog) gl.deleteProgram(prog); prog = null; }
	return { set, style, draw, dispose, get size() { return vols.size; } };
}
