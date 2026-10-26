// Cesium's sky box (scene.skyBox: the Tycho star map of SkyBox.createEarthSkyBox by default) and scene.backgroundColor.
//   Drawn on a canvas under the globe's: the globe clears to transparent and its own stars stay off, so space is Cesium's star map.
//   The same sampling as Cesium's SkyBox shaders: the cube's frame is TEME, turned into the fixed frame by czm_temeToPseudoFixed at the
//   scene's time, and seen through the camera's view rotation (faces fetched flipped, as loadCubeMap does). Drawn again only when the
//   view, the time step, the size or the sources change.
import { Matrix3, Matrix4 } from "@cesium/core";
import * as engine from "@cesium/engine";

type Any = any;
const { CelestialFrameTransforms } = engine as Any;   // a runtime export the d.ts leaves out
const FACES = ["positiveX", "negativeX", "positiveY", "negativeY", "positiveZ", "negativeZ"] as const;
const VS = `#version 300 es
in vec2 a_p; out vec2 v_p;
void main() { v_p = a_p; gl_Position = vec4(a_p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
uniform samplerCube u_cube; uniform mat3 u_m; uniform vec2 u_tan;
in vec2 v_p; out vec4 o;
void main() { o = vec4(texture(u_cube, u_m * normalize(vec3(v_p * u_tan, -1.0))).rgb, 1.0); }`;

const teme = new Matrix3(), rot = new Matrix3(), m = new Matrix3(), arr = new Float32Array(9);

export function skyBoxLayer(scene: Any, under: HTMLCanvasElement): () => void {
	const canvas = document.createElement("canvas");
	canvas.className = "cesium-ortho-skybox";
	Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", zIndex: "-1", pointerEvents: "none" });
	under.parentElement!.style.isolation = "isolate";   // the canvas below the globe's, inside the widget
	under.insertAdjacentElement("beforebegin", canvas);
	const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, premultipliedAlpha: false });
	let prog: WebGLProgram | null = null, uM: WebGLUniformLocation | null = null, uTan: WebGLUniformLocation | null = null;
	if (gl) {
		const sh = (t: number, s: string) => { const o = gl.createShader(t)!; gl.shaderSource(o, s); gl.compileShader(o); return o; };
		prog = gl.createProgram()!;
		gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
		gl.bindAttribLocation(prog, 0, "a_p"); gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn("[csshim] sky box", gl.getProgramInfoLog(prog)); prog = null; }
		else {
			uM = gl.getUniformLocation(prog, "u_m"); uTan = gl.getUniformLocation(prog, "u_tan");
			gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
			gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		}
	}
	let tex: WebGLTexture | null = null, srcOf: unknown = null, gen = 0, last = "";
	const load = (sources: Any) => {
		const my = ++gen;
		if (tex) { gl!.deleteTexture(tex); tex = null; }
		last = "";
		const get = (s: Any): Promise<Any> => typeof s === "string"
			? fetch(s).then(r => { if (!r.ok) throw new Error(`${r.status} ${s}`); return r.blob(); }).then(b => createImageBitmap(b, { imageOrientation: "flipY" }))
			: Promise.resolve(s);
		Promise.all(FACES.map(f => get(sources[f]))).then(imgs => {
			if (my !== gen || !gl) return;
			const t = gl.createTexture()!;
			gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
			imgs.forEach((img, i) => {
				gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !(img instanceof ImageBitmap));   // CubeMap's flipY (an ImageBitmap comes flipped already)
				gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
			});
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
			gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			tex = t; last = ""; scene.requestRender?.();
		}, (e: unknown) => { if (my === gen) console.warn("[csshim] sky box images", (e as Error)?.message ?? e); });
	};
	const draw = (_s: unknown, time: Any) => {
		if (!gl) return;
		const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
		const box = scene.skyBox, sources = box?.sources;
		if (sources !== srcOf) { srcOf = sources; if (sources && FACES.every(f => sources[f])) load(sources); else { gen++; if (tex) gl.deleteTexture(tex); tex = null; last = ""; } }
		const show = !!(tex && prog && box && box.show !== false), cam = scene.camera, f = cam.frustum;
		const bg = scene.backgroundColor ?? { red: 0, green: 0, blue: 0 };
		const fovy = f.fovy ?? Math.PI / 3, aspect = f.aspectRatio ?? w / h;
		if (show) { CelestialFrameTransforms.computeTemeToPseudoFixedMatrix(time ?? scene.frameState?.time, teme); Matrix4.getMatrix3(cam.viewMatrix, rot); }
		const key = `${w}x${h}|${show}|${bg.red},${bg.green},${bg.blue}|${show ? [...Matrix3.toArray(rot), ...Matrix3.toArray(teme)].map(v => v.toFixed(6)).join(",") : ""}|${fovy}|${aspect}`;
		if (key === last) return;
		last = key;
		if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
		gl.viewport(0, 0, w, h);
		gl.clearColor(bg.red, bg.green, bg.blue, 1); gl.clear(gl.COLOR_BUFFER_BIT);
		if (!show) return;
		// texture coordinate = TEMEᵀ · (view rotation)ᵀ · eye direction
		Matrix3.multiply(Matrix3.transpose(teme, m), Matrix3.transpose(rot, rot), m);
		arr.set(Matrix3.toArray(m));
		gl.useProgram(prog); gl.uniformMatrix3fv(uM, false, arr);
		const ty = Math.tan(fovy / 2); gl.uniform2f(uTan, ty * aspect, ty);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	};
	const off = scene.postRender.addEventListener(draw);
	return () => { off?.(); canvas.remove(); gen++; };
}
