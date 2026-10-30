// scene.postProcessStages → the globe's post chain (map.setPostChain) · 順 4 (2026-10-28).
//   The facade keeps Cesium's real PostProcessStageCollection (the examples add PostProcessStage / PostProcessStageLibrary stages to it and flip
//   `enabled` and `uniforms` every frame); this module reads it each frame and turns it into the globe's passes:
//     fxaa.enabled                      → { type: "fxaa" }
//     bloom.enabled (contrast/brightness/delta/sigma/stepSize/glowOnly) → { type: "cesiumBloom", … }   (Cesium's own passes: contrast-bias, Gaussian x/y, added to the scene)
//     ambientOcclusion.enabled          → ao: true (the WebGPU renderer's fx.ao; GL2 has none)
//     czm_silhouette                    → { type: "silhouette", color, length }
//     czm_black_and_white / czm_brightness / czm_night_vision → grey / brightness / nightVision
//     a PostProcessStage with fragmentShader → { type: "glsl", src, uniforms } (numbers, booleans, Cartesian2/3/4, Color; textures are not carried) — GL2 only
//     czm_lens_flare                    → { type: "lensFlare", … } with the sun and the earth projected on the screen here (the frame's camera, PostFrame)
//     czm_depth_of_field                → { type: "depthOfField", focalDistance, delta, sigma, stepSize, near, far }
//     stages with `selected` (per-feature) → not drawn (an empty selection draws nothing in Cesium either; a non-empty one is reported unsupported)
//   Pure: no DOM, no engine import (tests: sdk/cesium/tests/t-cesium.mjs "post:").
type Any = any;
export type PostPass = Record<string, unknown> & { type: string };
export interface PostChainOut { chain: PostPass[]; ao: boolean; skipped: string[] }

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
/** Color → [r,g,b,a] (0..1); arrays pass through */
export function colorOf(c: Any, d: number[] = [1, 1, 0, 1]): number[] {
	if (Array.isArray(c)) return [num(c[0], d[0]), num(c[1], d[1]), num(c[2], d[2]), num(c[3], d[3])];
	if (c && typeof c === "object" && "red" in c) return [num(c.red, d[0]), num(c.green, d[1]), num(c.blue, d[2]), num(c.alpha, d[3])];
	return d.slice();
}
/** a uniform value for a glsl stage: number · boolean · Cartesian2/3/4 · Color → number | number[] | boolean; anything else (textures, strings) = undefined */
export function uniformValue(v: Any): number | number[] | boolean | undefined {
	if (typeof v === "number") return Number.isFinite(v) ? v : 0;
	if (typeof v === "boolean") return v;
	if (typeof v === "function") return uniformValue(v());   // Cesium accepts a function returning the value
	if (Array.isArray(v)) return v.length >= 1 && v.length <= 4 && v.every(x => typeof x === "number") ? v.map(x => Number.isFinite(x) ? x : 0) : undefined;
	if (v && typeof v === "object") {
		if ("red" in v) return colorOf(v);
		if ("x" in v && typeof v.x === "number") { const a = [v.x, v.y]; if ("z" in v) a.push(v.z); if ("w" in v) a.push(v.w); return a.map(x => num(x, 0)); }
	}
	return undefined;
}
/** Cesium's bloom uniforms → the globe's "cesiumBloom" stage, the same passes as createBloomStage: contrast-bias (HSB brightness += brightness, then factor 259(c+255)/(255(259−c))),
 *  a Gaussian blur in x and y (delta, sigma, stepSize px) and the composite (scene + blur, or the blur alone with glowOnly). The fixed chain's threshold bloom was too weak (bloom 46%, 2026-10-30). */
export function bloomOf(u: Any): PostPass {
	return { type: "cesiumBloom", contrast: Math.min(255, Math.max(-255, num(u?.contrast, 128))), brightness: num(u?.brightness, -0.3), delta: num(u?.delta, 1), sigma: num(u?.sigma, 2), stepSize: num(u?.stepSize, 1), glowOnly: u?.glowOnly === true };
}
const SKIP: Record<string, string> = { czm_ambient_occlusion: "postProcessStages ambient occlusion (GL2)" };
/** the frame the stages are drawn for: view / proj = Cesium's czm_view / czm_projection (column-major 16), eye = czm_viewerPositionWC, sun = czm_sunPositionWC (m, fixed frame),
 *  near / far = czm_currentFrustum (depth of field), radius = the ground's distance from the earth's centre under the eye (the depth of field's ground where the globe left no depth) */
export interface PostFrame { view: ArrayLike<number>; proj: ArrayLike<number>; eye: number[]; sun: number[] | null; near: number; far: number; radius?: number }
const mulV = (m: ArrayLike<number>, x: number, y: number, z: number, w: number): number[] => [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w, m[3] * x + m[7] * y + m[11] * z + m[15] * w];
/** an eye-space point → NDC x,y (czm_eyeToWindowCoordinates then czm_viewportOrthographic: the perspective divide, behind the eye included) */
function ndcOfEye(f: PostFrame, ec: number[]): number[] { const q = mulV(f.proj, ec[0], ec[1], ec[2], 1); return [q[0] / q[3], q[1] / q[3]]; }
/** LensFlare.glsl's per-frame inputs: the sun on the screen, the earth's centre and its widened edge (getNDCFromWC), in space or not, the star's turn */
export function lensFlareFrame(f: PostFrame, earthRadius: number): { sun: number[]; earth: number[]; space: boolean; camrot: number } {
	const v = f.view, s = f.sun ?? [0, 0, 0];
	const sunEC = mulV(v, s[0], s[1], s[2], 1), earthEC = mulV(v, 0, 0, 0, 1);
	const sun = ndcOfEye(f, sunEC), earth = ndcOfEye(f, earthEC), edge = ndcOfEye(f, [earthEC[0] + earthRadius * 1.5, earthEC[1], earthEC[2]]);
	const space = Math.hypot(f.eye[0], f.eye[1], f.eye[2]) > 6500000.0;
	return { sun: f.sun ? sun : [9, 9], earth: [earth[0], earth[1], edge[0]], space, camrot: v[2] + v[5] };
}
const urlOf = (v: Any): string | undefined => (typeof v === "string" && v ? v : v && typeof v === "object" && typeof v.url === "string" ? v.url : undefined);   // a uniform texture: a URL or a Resource
const EDGE_STAGE = /^czm_edge_detection(?!_(combine|composite|multiple)$)/;   // createEdgeDetectionStage's czm_edge_detection_<guid>, not createSilhouetteStage's composite passes
function stagePasses(s: Any, out: PostChainOut, depth: number, f?: PostFrame | null): void {
	if (!s || s.enabled === false || depth > 4) return;
	const sel = s.selected; if (Array.isArray(sel)) { if (sel.length) out.skipped.push("postProcessStages per-feature (selected)"); return; }   // a stage with a selection applies to the selected features only: none selected = nothing drawn
	const name = String(s.name || ""), u = s.uniforms || {};
	if (name === "czm_silhouette" || /^czm_edge_detection/.test(name)) {   // createSilhouetteStage(edgeStages) = a composite of the edge detection stages (each with its own colour, length and selection) and the colouring
		const edges: Any[] = [], walk = (x: Any, d: number) => { if (!x || x.enabled === false || d > 4) return; if (typeof x.length === "number" && typeof x.get === "function") { for (let i = 0; i < x.length; i++) walk(x.get(i), d + 1); } else if (EDGE_STAGE.test(String(x.name || ""))) edges.push(x); };   // the edge detection stages themselves, not the composite's combine pass (it has no selection of its own)
		walk(s, 0);
		if (!edges.length) edges.push(s);
		for (const e of edges) {
			const es = e.selected;
			if (Array.isArray(es)) { if (es.length) out.skipped.push("postProcessStages per-feature (selected)"); continue; }   // none selected = nothing drawn
			const eu = e.uniforms || {};
			out.chain.push({ type: "silhouette", color: colorOf(eu.color, [0, 0, 0, 1]), length: num(eu.length, 0.25) });
		}
		return;
	}
	if (name === "czm_black_and_white") { out.chain.push({ type: "grey", gradations: num(u.gradations, 5) }); return; }
	if (name === "czm_brightness") { out.chain.push({ type: "brightness", value: num(u.brightness, 0.5) }); return; }
	if (name === "czm_night_vision") { out.chain.push({ type: "nightVision" }); return; }
	if (name === "czm_bloom") { out.chain.push(bloomOf(u)); return; }
	if (name === "czm_FXAA") { out.chain.push({ type: "fxaa" }); return; }
	if (name === "czm_ambient_occlusion") { out.ao = true; return; }
	if (name === "czm_lens_flare") {
		if (!f) { out.skipped.push("postProcessStages lens flare (no camera)"); return; }
		out.chain.push({ type: "lensFlare", intensity: num(u.intensity, 2), distortion: num(u.distortion, 10), ghostDispersal: num(u.ghostDispersal, 0.4), haloWidth: num(u.haloWidth, 0.4), dirtAmount: num(u.dirtAmount, 0.4),
			...lensFlareFrame(f, num(u.earthRadius, 6378137)), dirt: urlOf(u.dirtTexture), star: urlOf(u.starTexture) });
		return;
	}
	if (name === "czm_depth_of_field") {
		const pass: PostPass = { type: "depthOfField", focalDistance: num(u.focalDistance, 5), delta: num(u.delta, 1), sigma: num(u.sigma, 2), stepSize: num(u.stepSize, 1), near: f?.near ?? 1, far: f?.far ?? 5e8 };
		if (f && f.radius) { const e = mulV(f.view, 0, 0, 0, 1); pass.earth = [e[0], e[1], e[2], f.radius]; pass.tan = [1 / f.proj[0], 1 / f.proj[5]]; }
		out.chain.push(pass);
		return;
	}
	if (SKIP[name]) { out.skipped.push(SKIP[name]); return; }
	if (typeof s.fragmentShader === "string" && s.fragmentShader) {   // a user PostProcessStage
		const uniforms: Record<string, number | number[] | boolean> = {};
		let tex = false;
		for (const k of Object.keys(u)) { const v = uniformValue(u[k]); if (v === undefined) tex = true; else uniforms[k] = v; }
		if (tex) out.skipped.push("postProcessStages texture uniforms");
		out.chain.push({ type: "glsl", src: s.fragmentShader, uniforms });
		return;
	}
	if (typeof s.length === "number" && typeof s.get === "function") { for (let i = 0; i < s.length; i++) stagePasses(s.get(i), out, depth + 1, f); return; }   // a composite of user stages
	out.skipped.push(`postProcessStages ${name || "stage"}`);
}
/** the collection (Cesium's PostProcessStageCollection or anything shaped like it) → the globe's chain + the AO flag + what was not drawn (f＝the frame, for lens flare and depth of field) */
export function postChainOf(coll: Any, f?: PostFrame | null): PostChainOut {
	const out: PostChainOut = { chain: [], ao: false, skipped: [] };
	if (!coll) return out;
	if (coll.ambientOcclusion?.enabled) out.ao = true;
	if (coll.bloom?.enabled) out.chain.push(bloomOf(coll.bloom.uniforms));
	const n = typeof coll.length === "number" ? coll.length : 0;
	for (let i = 0; i < n; i++) { let s: Any = null; try { s = coll.get(i); } catch { s = null; } stagePasses(s, out, 0, f); }
	if (coll.fxaa?.enabled) out.chain.push({ type: "fxaa" });
	return out;
}
