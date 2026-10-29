// Cesium's lighting for the globe's meshes (models, 3D Tiles), handed to the globe through map.setMeshLighting each frame:
//   the scene's light as UniformState computes it (scene.light: a SunLight by default = the sun of Simon1994PlanetaryPositions in the ICRF,
//   turned into the fixed frame; a DirectionalLight = the negated direction), its HDR colour (colour × intensity), and Cesium's dynamic
//   environment map as 9 spherical-harmonic coefficients (envmap.ts: the CPU port of DynamicEnvironmentMapManager). Cesium builds that map
//   around each model's position and keeps it until the position moves by maximumPositionEpsilon (1 km); the globe gets one environment,
//   evaluated at the point the camera looks at (the models in view stand around it), refreshed on the same 1 km rule.
import { Cartesian3, Ellipsoid, IntersectionTests, Matrix3, Ray } from "@cesium/core";
import * as engine from "@cesium/engine";
import { cesiumEnvSH, CESIUM_SH_UNIFORM_L00 } from "./envmap.ts";

type Any = any;
const { CelestialFrameTransforms, Simon1994PlanetaryPositions, SunLight } = engine as Any;   // CelestialFrameTransforms: a runtime export the d.ts leaves out
const sunPos = new Cartesian3(), icrf = Matrix3.clone(Matrix3.IDENTITY), teme = new Matrix3(), ray = new Ray(), hit = new Cartesian3(), surf = new Cartesian3(), neg = new Cartesian3();
const c3 = (v: Any): number[] | undefined => (v ? [v.x, v.y, v.z] : undefined);

// A model or tileset with its own ImageBasedLighting coefficients (imageBasedLighting.sphericalHarmonicCoefficients: an HDR environment baked by
//   Cesium's IBL tool, as in the gltf-pbr-extensions example) replaces the procedural environment, with its imageBasedLightingFactor. Cesium applies
//   it per model; the globe lights every mesh alike, so the first one found (in scene.primitives, two levels deep) wins.
function customIbl(prims: Any, depth = 0): { sh: number[]; ibl: number[] } | null {
	const n = prims?.length ?? 0;
	for (let i = 0; i < n; i++) {
		const o = prims.get ? prims.get(i) : prims[i], ibl = o?.imageBasedLighting, c = ibl?.sphericalHarmonicCoefficients;
		if (c && c.length === 9 && o.show !== false) { const sh: number[] = []; for (const q of c) sh.push(q.x, q.y, q.z); const f = ibl.imageBasedLightingFactor; return { sh, ibl: f ? [f.x, f.y] : [1, 1] }; }
		if (depth < 2 && (o?._primitives || (o?.length != null && o.get))) { const r = customIbl(o._primitives ?? o, depth + 1); if (r) return r; }
	}
	return null;
}

const R_MIN = 6356752.3142451793;   // Ellipsoid.WGS84.minimumRadius: Globe's fade distances
let groundSent = "";
/** globe.enableLighting → the globe's ground lighting (GlobeFS): terrain with normals = lambert × 0.9 + 0.3 (ENABLE_VERTEX_LIGHTING), without = lambert × 5 + 0.3 faded in between
 *  lightingFadeOutDistance and lightingFadeInDistance (ENABLE_DAYNIGHT_SHADING); the ground atmosphere darkens on the night side between nightFadeOutDistance and nightFadeInDistance
 *  (dynamicAtmosphereLighting). czm_lightColor = the HDR colour scaled so that its largest component is 1. */
function groundLighting(scene: Any, map: Any, dir: Any, hdr: number[]) {
	if (typeof map.setGroundLighting !== "function") return;
	const globe = scene.globe, on = !!globe && globe.show !== false && !!globe.enableLighting;
	let sig = on ? "on" : "";
	let spec: Any = null;
	if (on) {
		const mx = Math.max(hdr[0], hdr[1], hdr[2], 1), color = [hdr[0] / mx, hdr[1] / mx, hdr[2] / mx];
		const normals = !!globe.terrainProvider?.hasVertexNormals;
		const rMin = globe.ellipsoid?.minimumRadius ?? R_MIN;
		spec = {
			dir: [dir.x, dir.y, dir.z], color,
			lambert: normals ? [globe.lambertDiffuseMultiplier ?? 0.9, globe.vertexShadowDarkness ?? 0.3] : [5, 0.3], normal: normals ? "terrain" : "up",
			fade: normals ? null : [globe.lightingFadeOutDistance ?? Math.PI / 2 * rMin, globe.lightingFadeInDistance ?? Math.PI * rMin],
			night: globe.dynamicAtmosphereLighting !== false ? [globe.nightFadeOutDistance ?? Math.PI / 2 * rMin, globe.nightFadeInDistance ?? 5 * Math.PI / 2 * rMin] : null,
		};
		sig = JSON.stringify([spec.dir.map((v: number) => v.toFixed(4)), spec.color.map((v: number) => v.toFixed(3)), spec.lambert, spec.normal, spec.fade, spec.night]);
	}
	if (sig === groundSent) return;
	groundSent = sig;
	map.setGroundLighting(spec);
}
/** viewer.shadows / scene.shadowMap.enabled → the globe's real-time shadows (map.setShadows): the shadow map of the sun of the shared clock
 *  (display.ts keeps it on the Cesium clock), darkness = ShadowMap.darkness (the light left in shadow, 0.3). Cesium casts from scene.light;
 *  the globe's shadows always come from the sun, so a DirectionalLight shadows as the sun of that time would. Per-object ShadowMode
 *  (terrainShadows RECEIVE_ONLY, model.shadows) has no counterpart: everything casts and receives while the map is on. */
function shadows(scene: Any, map: Any, last: { sig: string }) {
	if (typeof map.setShadows !== "function") return;
	const sm = scene.shadowMap, on = !!sm?.enabled && !sm.isDestroyed?.();
	const darkness = Math.max(0, Math.min(1, +(sm?.darkness ?? 0.3) || 0));
	const sig = on ? `1|${darkness.toFixed(3)}` : "0";
	if (sig === last.sig) return;
	last.sig = sig;
	map.setShadows(on ? { on: true, darkness } : false);
}

/** czm_sunPositionWC: the sun in the fixed frame (m) at time t, as UniformState computes it */
const sunWC = new Cartesian3(), icrf2 = Matrix3.clone(Matrix3.IDENTITY), teme2 = new Matrix3();
export function sunPositionWC(t: Any): number[] {
	Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(t, sunWC);
	const m = CelestialFrameTransforms.computeIcrfToCentralBodyFixedMatrix(t, icrf2) ?? CelestialFrameTransforms.computeTemeToPseudoFixedMatrix(t, teme2);
	Matrix3.multiplyByVector(m, sunWC, sunWC);
	return [sunWC.x, sunWC.y, sunWC.z];
}

/** cesiumEnvSH's options from the scene's atmosphere (dir = the light, sun = the sun, both unit vectors in the fixed frame) */
function envOptions(scene: Any, at: Cartesian3, dir: Any, sun: Any): Parameters<typeof cesiumEnvSH>[1] {
	const atmo = scene.atmosphere, dyn = atmo?.dynamicLighting ?? 0, bg = scene.backgroundColor, ell = scene.ellipsoid ?? scene.globe?.ellipsoid ?? Ellipsoid.WGS84;
	const s = ell.scaleToGeodeticSurface(at, surf);
	return {
		radius: s ? Cartesian3.magnitude(s) : ell.maximumRadius, dynamicLighting: dyn, lightDirWC: [dir.x, dir.y, dir.z], sunDirWC: [sun.x, sun.y, sun.z],
		lightIntensity: atmo?.lightIntensity, rayleighCoefficient: c3(atmo?.rayleighCoefficient), mieCoefficient: c3(atmo?.mieCoefficient),
		rayleighScaleHeight: atmo?.rayleighScaleHeight, mieScaleHeight: atmo?.mieScaleHeight, mieAnisotropy: atmo?.mieAnisotropy,
		backgroundColor: bg ? [bg.red, bg.green, bg.blue] : undefined,
	};
}
const envKeyOf = (scene: Any, at: ArrayLike<number>, dir: Any): string => {
	const atmo = scene.atmosphere, dyn = atmo?.dynamicLighting ?? 0, bg = scene.backgroundColor;
	return `${Math.round(at[0] / 1000)},${Math.round(at[1] / 1000)},${Math.round(at[2] / 1000)}|${dyn}${dyn ? `|${dir.x.toFixed(2)},${dir.y.toFixed(2)},${dir.z.toFixed(2)}` : ""}|${atmo?.lightIntensity ?? 10}|${bg ? `${bg.red},${bg.green},${bg.blue}` : ""}`;
};
/** the light and sun directions (fixed frame) at time t, as UniformState computes them */
function lightDirs(scene: Any, t: Any): { dir: Cartesian3; sun: Cartesian3 } {
	const light = scene.light ?? null, isSun = !light || light instanceof SunLight;
	Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(t, sunPos);
	const m = CelestialFrameTransforms.computeIcrfToCentralBodyFixedMatrix(t, icrf) ?? CelestialFrameTransforms.computeTemeToPseudoFixedMatrix(t, teme);   // the ICRF data may not be loaded yet: TEME is within a fraction of a degree
	const sun = Cartesian3.normalize(Matrix3.multiplyByVector(m, sunPos, sunPos), sunPos);
	return { dir: isSun ? sun : Cartesian3.normalize(Cartesian3.negate(light.direction, neg), neg), sun };
}
const modelEnvCache = new Map<string, Float32Array>();
const modelPos = new Cartesian3();
/** Cesium's environment of a model at posWC (its DynamicEnvironmentMapManager builds the map around the model's own position, kept within
 *  1 km): the SH9 for ModelHandle.setEnvironment, or null when a custom ImageBasedLighting replaces the procedural environment */
export function modelEnvSH(scene: Any, posWC: ArrayLike<number>): Float32Array | null {
	if (customIbl(scene.primitives)) return null;
	const t = scene.frameState?.time ?? scene.lastRenderTime;
	if (!t) return null;
	const { dir, sun } = lightDirs(scene, t);
	const key = envKeyOf(scene, posWC, dir);
	let sh = modelEnvCache.get(key);
	if (!sh) {
		if (modelEnvCache.size > 64) modelEnvCache.clear();
		sh = cesiumEnvSH(posWC, envOptions(scene, Cartesian3.fromArray(posWC as number[], 0, modelPos), dir, sun));
		modelEnvCache.set(key, sh);
	}
	return sh;
}

export function syncLighting(scene: Any, map: Any): (time: Any) => void {
	let envKey = "", sh: Float32Array | null = null, sent = "";
	const shadowLast = { sig: "" };
	return (time: Any) => {
		shadows(scene, map, shadowLast);
		if (typeof map.setMeshLighting !== "function") return;
		const t = time ?? scene.frameState?.time ?? scene.lastRenderTime;
		if (!t) return;
		// the light's direction in the fixed frame (UniformState.update): the sun, or the DirectionalLight turned around
		const light = scene.light ?? null, { dir, sun } = lightDirs(scene, t);
		const c = light?.color ?? { red: 1, green: 1, blue: 1 }, k = light?.intensity ?? 2;
		const color = [c.red * k, c.green * k, c.blue * k];
		// the environment around the point in view: where the view ray meets the ellipsoid, else the ground under the camera
		const cam = scene.camera, ell = scene.ellipsoid ?? scene.globe?.ellipsoid ?? Ellipsoid.WGS84;
		ray.origin = cam.positionWC; ray.direction = cam.directionWC;
		const iv = IntersectionTests.rayEllipsoid(ray, ell);
		const at = iv && iv.start >= 0 ? Ray.getPoint(ray, iv.start, hit) : (ell.scaleToGeodeticSurface(cam.positionWC, hit) ?? Cartesian3.clone(cam.positionWC, hit));
		const key = envKeyOf(scene, [at.x, at.y, at.z], dir);
		if (key !== envKey) {
			envKey = key;
			sh = cesiumEnvSH([at.x, at.y, at.z], envOptions(scene, at, dir, sun));
		}
		groundLighting(scene, map, dir, color);
		const custom = customIbl(scene.primitives);
		const sig = `${dir.x.toFixed(4)},${dir.y.toFixed(4)},${dir.z.toFixed(4)}|${color.map(v => v.toFixed(3)).join(",")}|${envKey}|${custom ? custom.sh.map(v => v.toFixed(4)).join(",") + custom.ibl.join(",") : ""}`;
		if (sig === sent) return;
		sent = sig;
		if (custom) map.setMeshLighting({ dir: [dir.x, dir.y, dir.z], color, sh: custom.sh, ibl: custom.ibl, invL00: 1 / (CESIUM_SH_UNIFORM_L00 * 2) });
		else map.setMeshLighting({ dir: [dir.x, dir.y, dir.z], color, sh: sh!, ibl: [1, 1], invL00: 1 / (CESIUM_SH_UNIFORM_L00 * 2) });   // the coefficients carry atmosphereScatteringIntensity (2): the specular lookup takes it back out
	};
}
