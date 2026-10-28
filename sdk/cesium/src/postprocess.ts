// scene.postProcessStages → the globe's post chain (map.setPostChain) · 順 4 (2026-10-28).
//   The facade keeps Cesium's real PostProcessStageCollection (the examples add PostProcessStage / PostProcessStageLibrary stages to it and flip
//   `enabled` and `uniforms` every frame); this module reads it each frame and turns it into the globe's passes:
//     fxaa.enabled                      → { type: "fxaa" }
//     bloom.enabled (contrast/brightness/sigma/stepSize) → { type: "bloom", threshold, strength, radius }   (Cesium's contrast-bias bright pass ≈ a luminance threshold)
//     ambientOcclusion.enabled          → ao: true (the WebGPU renderer's fx.ao; GL2 has none)
//     czm_silhouette                    → { type: "silhouette", color, length }
//     czm_black_and_white / czm_brightness / czm_night_vision → grey / brightness / nightVision
//     a PostProcessStage with fragmentShader → { type: "glsl", src, uniforms } (numbers, booleans, Cartesian2/3/4, Color; textures are not carried) — GL2 only
//     czm_depth_of_field / czm_lens_flare / stages with `selected` (per-feature) → not drawn (the unsupported report says so)
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
/** Cesium's bloom uniforms → the globe's bloom. contrast/brightness feed a contrast-bias pass (HSB brightness += b, then factor f = 259(c+255)/(255(259−c))): everything whose
 *  brightness is below 0.5 − 0.5/f − b goes black before the blur = our luminance threshold. sigma × stepSize (px, 8 taps) ≈ the blur radius; ours is a 9-tap at half resolution × radius. */
export function bloomOf(u: Any): PostPass {
	const contrast = Math.min(255, Math.max(-255, num(u?.contrast, 128))), brightness = num(u?.brightness, -0.3);
	const f = (259 * (contrast + 255)) / (255 * (259 - contrast));
	const threshold = Math.min(1, Math.max(0, 0.5 - 0.5 / Math.max(f, 1e-3) - brightness));
	const radius = Math.min(4, Math.max(0.25, num(u?.stepSize, 1) * num(u?.sigma, 2) / 4));
	return { type: "bloom", threshold, strength: 1, radius };
}
const SKIP: Record<string, string> = { czm_depth_of_field: "postProcessStages depth of field", czm_lens_flare: "postProcessStages lens flare", czm_ambient_occlusion: "postProcessStages ambient occlusion (GL2)" };
function stagePasses(s: Any, out: PostChainOut, depth: number): void {
	if (!s || s.enabled === false || depth > 4) return;
	const sel = s.selected; if (Array.isArray(sel) && sel.length) { out.skipped.push("postProcessStages per-feature (selected)"); return; }
	const name = String(s.name || ""), u = s.uniforms || {};
	if (name === "czm_silhouette" || /^czm_edge_detection/.test(name)) { out.chain.push({ type: "silhouette", color: colorOf(u.color, [0, 0, 0, 1]), length: num(u.length, 0.25) }); return; }
	if (name === "czm_black_and_white") { out.chain.push({ type: "grey", gradations: num(u.gradations, 5) }); return; }
	if (name === "czm_brightness") { out.chain.push({ type: "brightness", value: num(u.brightness, 0.5) }); return; }
	if (name === "czm_night_vision") { out.chain.push({ type: "nightVision" }); return; }
	if (name === "czm_bloom") { out.chain.push(bloomOf(u)); return; }
	if (name === "czm_FXAA") { out.chain.push({ type: "fxaa" }); return; }
	if (name === "czm_ambient_occlusion") { out.ao = true; return; }
	if (SKIP[name]) { out.skipped.push(SKIP[name]); return; }
	if (typeof s.fragmentShader === "string" && s.fragmentShader) {   // a user PostProcessStage
		const uniforms: Record<string, number | number[] | boolean> = {};
		let tex = false;
		for (const k of Object.keys(u)) { const v = uniformValue(u[k]); if (v === undefined) tex = true; else uniforms[k] = v; }
		if (tex) out.skipped.push("postProcessStages texture uniforms");
		out.chain.push({ type: "glsl", src: s.fragmentShader, uniforms });
		return;
	}
	if (typeof s.length === "number" && typeof s.get === "function") { for (let i = 0; i < s.length; i++) stagePasses(s.get(i), out, depth + 1); return; }   // a composite of user stages
	out.skipped.push(`postProcessStages ${name || "stage"}`);
}
/** the collection (Cesium's PostProcessStageCollection or anything shaped like it) → the globe's chain + the AO flag + what was not drawn */
export function postChainOf(coll: Any): PostChainOut {
	const out: PostChainOut = { chain: [], ao: false, skipped: [] };
	if (!coll) return out;
	if (coll.ambientOcclusion?.enabled) out.ao = true;
	if (coll.bloom?.enabled) out.chain.push(bloomOf(coll.bloom.uniforms));
	const n = typeof coll.length === "number" ? coll.length : 0;
	for (let i = 0; i < n; i++) { let s: Any = null; try { s = coll.get(i); } catch { s = null; } stagePasses(s, out, 0); }
	if (coll.fxaa?.enabled) out.chain.push({ type: "fxaa" });
	return out;
}
