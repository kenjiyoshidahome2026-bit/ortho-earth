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

export function syncLighting(scene: Any, map: Any): (time: Any) => void {
	let envKey = "", sh: Float32Array | null = null, sent = "";
	return (time: Any) => {
		if (typeof map.setMeshLighting !== "function") return;
		const t = time ?? scene.frameState?.time ?? scene.lastRenderTime;
		if (!t) return;
		// the light's direction in the fixed frame (UniformState.update): the sun, or the DirectionalLight turned around
		const light = scene.light ?? null, isSun = !light || light instanceof SunLight;
		Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(t, sunPos);
		const m = CelestialFrameTransforms.computeIcrfToCentralBodyFixedMatrix(t, icrf) ?? CelestialFrameTransforms.computeTemeToPseudoFixedMatrix(t, teme);   // the ICRF data may not be loaded yet: TEME is within a fraction of a degree
		const sun = Cartesian3.normalize(Matrix3.multiplyByVector(m, sunPos, sunPos), sunPos);
		const dir = isSun ? sun : Cartesian3.normalize(Cartesian3.negate(light.direction, neg), neg);
		const c = light?.color ?? { red: 1, green: 1, blue: 1 }, k = light?.intensity ?? 2;
		const color = [c.red * k, c.green * k, c.blue * k];
		// the environment around the point in view: where the view ray meets the ellipsoid, else the ground under the camera
		const cam = scene.camera, ell = scene.ellipsoid ?? scene.globe?.ellipsoid ?? Ellipsoid.WGS84;
		ray.origin = cam.positionWC; ray.direction = cam.directionWC;
		const iv = IntersectionTests.rayEllipsoid(ray, ell);
		const at = iv && iv.start >= 0 ? Ray.getPoint(ray, iv.start, hit) : (ell.scaleToGeodeticSurface(cam.positionWC, hit) ?? Cartesian3.clone(cam.positionWC, hit));
		const atmo = scene.atmosphere, dyn = atmo?.dynamicLighting ?? 0, bg = scene.backgroundColor;
		const key = `${Math.round(at.x / 1000)},${Math.round(at.y / 1000)},${Math.round(at.z / 1000)}|${dyn}${dyn ? `|${dir.x.toFixed(2)},${dir.y.toFixed(2)},${dir.z.toFixed(2)}` : ""}|${atmo?.lightIntensity ?? 10}|${bg ? `${bg.red},${bg.green},${bg.blue}` : ""}`;
		if (key !== envKey) {
			envKey = key;
			const s = ell.scaleToGeodeticSurface(at, surf);
			sh = cesiumEnvSH([at.x, at.y, at.z], {
				radius: s ? Cartesian3.magnitude(s) : ell.maximumRadius, dynamicLighting: dyn, lightDirWC: [dir.x, dir.y, dir.z], sunDirWC: [sun.x, sun.y, sun.z],
				lightIntensity: atmo?.lightIntensity, rayleighCoefficient: c3(atmo?.rayleighCoefficient), mieCoefficient: c3(atmo?.mieCoefficient),
				rayleighScaleHeight: atmo?.rayleighScaleHeight, mieScaleHeight: atmo?.mieScaleHeight, mieAnisotropy: atmo?.mieAnisotropy,
				backgroundColor: bg ? [bg.red, bg.green, bg.blue] : undefined,
			});
		}
		const custom = customIbl(scene.primitives);
		const sig = `${dir.x.toFixed(4)},${dir.y.toFixed(4)},${dir.z.toFixed(4)}|${color.map(v => v.toFixed(3)).join(",")}|${envKey}|${custom ? custom.sh.map(v => v.toFixed(4)).join(",") + custom.ibl.join(",") : ""}`;
		if (sig === sent) return;
		sent = sig;
		if (custom) map.setMeshLighting({ dir: [dir.x, dir.y, dir.z], color, sh: custom.sh, ibl: custom.ibl, invL00: 1 / (CESIUM_SH_UNIFORM_L00 * 2) });
		else map.setMeshLighting({ dir: [dir.x, dir.y, dir.z], color, sh: sh!, ibl: [1, 1], invL00: 1 / (CESIUM_SH_UNIFORM_L00 * 2) });   // the coefficients carry atmosphereScatteringIntensity (2): the specular lookup takes it back out
	};
}
