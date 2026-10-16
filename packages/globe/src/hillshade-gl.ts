// 陰影（hillshade.ts の shadeTile）の GPU 版（高速化 段 2・2026-10-16）＝同じ式を WebGL2 の fragment で 1 画素 1 回。
// shadeTile はメインスレッドで 256² 1 枚 12〜30ms（512² は 33〜85ms）＝陰影の層を開くと地図の操作が引っかかる。ここは同じ画素を GPU で計算して
// readPixels で読み戻す＝port プロバイダの形（RGBA8・事前乗算なし → createImageBitmap）はそのまま＝render worker は無改修。
// 式は shadeTile の写し（MapLibre 6.11.2 の hillshade_prepare＋hillshade fragment）。GPU は f32＝JS（f64）と丸めが違う＝画素は ±数階調ずれ得る
// （tests/t-hillshade-gl.html が 5 つの method で差を測る）。WebGL2・R32F の読み・光の本数 ≤ 8 のどれかが叶わなければ null＝呼び手は CPU（shadeTile）で描く。
import { heightAt } from "./hillshade.ts";
import type { ShadeInput } from "./hillshade.ts";

const MAX_L = 8;   // multidirectional の光の本数の上限（uniform 配列の長さ）＝超える時は CPU
const METHOD_ID: Record<string, number> = { standard: 0, basic: 1, combined: 2, igor: 3, multidirectional: 4 };

const VS = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
// 画素 (x, y)＝出力の行 y（行 0＝北）。u_h＝縁 1 画素を足した (n+2)² の高さ（heightAt で詰めた物）。readPixels の行 0＝framebuffer の y 0＝配列の行 0（上下は返さない）
const FS = `#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D u_h;
uniform int u_n, u_method, u_L, u_nS, u_nH, u_nAz, u_nAlt;
uniform float u_k0, u_lat0, u_lat1, u_I, u_base, u_pb, u_k;
uniform vec4 u_A, u_S[${MAX_L}], u_H[${MAX_L}];
uniform float u_az[${MAX_L}], u_alt[${MAX_L}];
out vec4 o;
const float PI = 3.141592653589793, MID = 128.0 / 255.0, MAXV = 0.5 * PI;
float H(int x, int y) { return texelFetch(u_h, ivec2(x + 1, y + 1), 0).r; }
float pack(float d) { return floor(clamp(d / 8.0 + MID, 0.0, 1.0) * 255.0 + 0.5) / 255.0; }   // Math.round＝floor(x+0.5)（値は 0 以上）
float aspectOf(float dx, float dy) { return dx != 0.0 ? atan(dy, -dx) : PI / 2.0 * (dy > 0.0 ? 1.0 : -1.0); }
float modShade(float aspect, float az) { return abs(mod((aspect + az + PI) / PI + 0.5, 2.0) - 1.0); }
void main() {
	int x = int(gl_FragCoord.x), y = int(gl_FragCoord.y);
	float n = float(u_n), lat = u_lat0 + (u_lat1 - u_lat0) * (float(y) + 0.5) / n, scale = cos(lat * PI / 180.0);
	float a = H(x - 1, y - 1), b = H(x, y - 1), c = H(x + 1, y - 1), d = H(x - 1, y), f = H(x + 1, y), g = H(x - 1, y + 1), hh = H(x, y + 1), i = H(x + 1, y + 1);
	float dx = (pack(((c + f + f + i) - (a + d + d + g)) * u_k0) - MID) * 8.0 / scale, dy = (pack(((g + hh + hh + i) - (a + b + b + c)) * u_k0) - MID) * 8.0 / scale;
	vec4 o4 = vec4(0.0);
	float I = u_I;
	if (u_method == 0) {   // standard
		float slope = atan(0.625 * length(vec2(dx, dy))), aspect = aspectOf(dx, dy);
		float scaled = I != 0.5 ? ((pow(u_base, slope) - 1.0) / u_pb) * MAXV : slope;
		float accentK = (1.0 - cos(scaled)) * u_k, shade = modShade(aspect, u_az[0]), sk = sin(scaled) * u_k;
		vec4 sc = mix(u_S[0], u_H[0], shade) * sk;
		o4 = u_A * accentK * (1.0 - sc.a) + sc;
	} else if (u_method == 3) {   // igor
		dx *= I * 2.0; dy *= I * 2.0;
		float aspect = aspectOf(dx, dy), slopeS = atan(length(vec2(dx, dy))) * 2.0 / PI;
		float aspS = 1.0 - modShade(aspect, u_az[0]);
		o4 = u_S[0] * (slopeS * aspS) + u_H[0] * (slopeS * (1.0 - aspS));
	} else {   // basic・combined・multidirectional
		dx *= I * 2.0; dy *= I * 2.0;
		float nrm = sqrt(1.0 + dx * dx + dy * dy);
		if (u_method == 4) {
			for (int l = 0; l < ${MAX_L}; l++) {
				if (l >= u_L) break;
				float az = u_az[min(l, u_nAz - 1)], alt = u_alt[min(l, u_nAlt - 1)];
				float cosAz = -cos(az), sinAz = -sin(az), cosAlt = cos(alt), sinAlt = sin(alt);
				float sh = clamp((sinAlt - (dy * cosAz * cosAlt - dx * sinAz * cosAlt)) / nrm, 0.0, 1.0);
				if (sh > 0.5) o4 += u_H[min(l, u_nH - 1)] * ((2.0 * sh - 1.0) / float(u_L)); else o4 += u_S[min(l, u_nS - 1)] * ((1.0 - 2.0 * sh) / float(u_L));
			}
		} else {
			float az = u_az[0] + PI, cosAz = cos(az), sinAz = sin(az), cosAlt = cos(u_alt[0]), sinAlt = sin(u_alt[0]);
			float cang0 = (sinAlt - (dy * cosAz * cosAlt - dx * sinAz * cosAlt)) / nrm;
			if (u_method == 1) { float sh = clamp(cang0, 0.0, 1.0); if (sh > 0.5) o4 = u_H[0] * (2.0 * sh - 1.0); else o4 = u_S[0] * (1.0 - 2.0 * sh); }
			else {
				float cang = clamp(acos(clamp(cang0, -1.0, 1.0)), 0.0, PI / 2.0), sl = atan(length(vec2(dx, dy)));
				o4 = u_S[0] * (cang * sl * 4.0 / PI / PI) + u_H[0] * ((PI / 2.0 - cang) * sl * 4.0 / PI / PI);
			}
		}
	}
	float oa = clamp(o4.a, 0.0, 1.0);
	o = oa > 1e-6 ? vec4(o4.rgb / oa, oa) : vec4(0.0);   // 事前乗算を戻す（RGBA8 へ書く＝0..1 に詰まる）
}`;

export interface ShadeGL { shade(inp: ShadeInput): Uint8ClampedArray<ArrayBuffer> | null; close(): void }

// 1 つの WebGL2 の器（OffscreenCanvas・1×1・描き先は n×n の RGBA8 の framebuffer）。作れなければ null
export function createShadeGL(): ShadeGL | null {
	if (typeof OffscreenCanvas === "undefined") return null;
	let gl: WebGL2RenderingContext | null = null;
	try { gl = new OffscreenCanvas(1, 1).getContext("webgl2", { antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null; } catch { gl = null; }
	if (!gl) return null;
	const sh = (type: number, src: string): WebGLShader | null => { const s = gl!.createShader(type)!; gl!.shaderSource(s, src); gl!.compileShader(s); return gl!.getShaderParameter(s, gl!.COMPILE_STATUS) ? s : null; };
	const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
	if (!vs || !fs) return null;
	const prog = gl.createProgram()!; gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
	const U = (k: string) => gl!.getUniformLocation(prog, k);
	const loc = Object.fromEntries(["u_h", "u_n", "u_method", "u_L", "u_nS", "u_nH", "u_nAz", "u_nAlt", "u_k0", "u_lat0", "u_lat1", "u_I", "u_base", "u_pb", "u_k", "u_A", "u_S", "u_H", "u_az", "u_alt"].map(k => [k, U(k)]));
	const hTex = gl.createTexture()!, oTex = gl.createTexture()!, fb = gl.createFramebuffer()!, vao = gl.createVertexArray()!;
	for (const t of [hTex, oTex]) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); }
	let size = 0, pad = new Float32Array(0);
	const pm = (c: number[]) => [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];   // MapLibre の色は事前乗算（shadeTile と同じ）
	const vec4s = (cs: number[][]) => { const a = new Float32Array(MAX_L * 4); cs.slice(0, MAX_L).forEach((c, i) => a.set(pm(c), i * 4)); return a; };
	const floats = (v: number[]) => { const a = new Float32Array(MAX_L); a.set(v.slice(0, MAX_L)); return a; };
	return {
		shade(inp) {
			const g = gl!;
			if (g.isContextLost()) return null;
			const { n, z, lat0, lat1, p } = inp;
			// shadeTile と同じ定数（JS の f64 で計算して f32 の uniform へ）
			const ef = z < 2 ? 0.4 : z < 4.5 ? 0.35 : 0.3, ex = z < 15 ? (z - 15) * ef : 0, k0 = n / Math.pow(2, ex + (28.2562 - z));
			const I = p.exaggeration, method = p.method || "standard";
			const shadows = (p.shadows || [p.shadow]) as number[][], highlights = (p.highlights || [p.highlight]) as number[][];
			const azs = (p.directions || [p.direction] as number[]).map(d => d * Math.PI / 180), alts = (p.altitudes || [45]).map(d => d * Math.PI / 180);
			const L = Math.max(shadows.length, highlights.length, azs.length, alts.length);
			if (L > MAX_L || !(method in METHOD_ID)) return null;
			const base = 1.875 - I * 1.75, pb = Math.pow(base, 0.5 * Math.PI) - 1, k = Math.max(0, Math.min(1, I * 2));
			// 縁付きの高さ（(n+2)²・heightAt＝shadeTile と同じ隣の読み・NaN は 0）
			const W = n + 2, at = heightAt(inp);
			if (pad.length !== W * W) pad = new Float32Array(W * W);
			for (let y = -1; y <= n; y++) for (let x = -1; x <= n; x++) pad[(y + 1) * W + (x + 1)] = at(x, y);
			g.bindTexture(g.TEXTURE_2D, hTex); g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
			g.texImage2D(g.TEXTURE_2D, 0, g.R32F, W, W, 0, g.RED, g.FLOAT, pad);
			if (size !== n) {
				size = n;
				g.bindTexture(g.TEXTURE_2D, oTex); g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, n, n, 0, g.RGBA, g.UNSIGNED_BYTE, null);
				g.bindFramebuffer(g.FRAMEBUFFER, fb); g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, oTex, 0);
				if (g.checkFramebufferStatus(g.FRAMEBUFFER) !== g.FRAMEBUFFER_COMPLETE) { size = 0; return null; }
			}
			g.bindFramebuffer(g.FRAMEBUFFER, fb); g.viewport(0, 0, n, n);
			g.useProgram(prog); g.bindVertexArray(vao);
			g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, hTex); g.uniform1i(loc.u_h, 0);
			g.uniform1i(loc.u_n, n); g.uniform1i(loc.u_method, METHOD_ID[method]); g.uniform1i(loc.u_L, L);
			g.uniform1i(loc.u_nS, Math.min(MAX_L, shadows.length)); g.uniform1i(loc.u_nH, Math.min(MAX_L, highlights.length)); g.uniform1i(loc.u_nAz, Math.min(MAX_L, azs.length)); g.uniform1i(loc.u_nAlt, Math.min(MAX_L, alts.length));
			g.uniform1f(loc.u_k0, k0); g.uniform1f(loc.u_lat0, lat0); g.uniform1f(loc.u_lat1, lat1); g.uniform1f(loc.u_I, I); g.uniform1f(loc.u_base, base); g.uniform1f(loc.u_pb, pb); g.uniform1f(loc.u_k, k);
			g.uniform4fv(loc.u_A, pm(p.accent)); g.uniform4fv(loc.u_S, vec4s(shadows)); g.uniform4fv(loc.u_H, vec4s(highlights)); g.uniform1fv(loc.u_az, floats(azs)); g.uniform1fv(loc.u_alt, floats(alts));
			g.drawArrays(g.TRIANGLES, 0, 3);
			const out = new Uint8ClampedArray(n * n * 4);
			g.pixelStorei(g.PACK_ALIGNMENT, 1);
			g.readPixels(0, 0, n, n, g.RGBA, g.UNSIGNED_BYTE, out);
			g.bindFramebuffer(g.FRAMEBUFFER, null);
			return g.getError() === g.NO_ERROR ? out : null;
		},
		close() { const g = gl!; g.deleteTexture(hTex); g.deleteTexture(oTex); g.deleteFramebuffer(fb); g.deleteVertexArray(vao); g.deleteProgram(prog); g.getExtension("WEBGL_lose_context")?.loseContext(); },
	};
}
