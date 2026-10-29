// Cesium's dynamic environment map on the CPU (Scene/DynamicEnvironmentMapManager + Shaders/ComputeRadianceMapFS + ComputeIrradianceFS).
//   Cesium lights every model with a procedural cube map: the sky atmosphere (czm_computeScattering / czm_computeAtmosphereColor, lit from the
//   zenith unless scene.atmosphere.dynamicLighting says otherwise) above the horizon and a flat ground colour below, rendered around the model's
//   position in its east-north-up frame, then projected to 9 spherical-harmonic coefficients by 256 Hammersley samples. The globe has no cube map,
//   so this does the same arithmetic in JavaScript, sample for sample: the same step counts, the same odd sample weights, the same cube
//   orientation (the cube is y-up: x = east, y = up, z = south, which is how GL's cube lookup reads the faces Cesium renders).
//   The coefficients come back in Cesium's order (L00, L1-1, L10, L11, L2-2, L2-1, L20, L21, L22), to be evaluated by czm_sphericalHarmonics
//   with a normal in that frame. Nothing here depends on the browser or on Cesium's classes.

export interface CesiumEnvOptions {
	/** scene.atmosphere.dynamicLighting: 0 = NONE (lit from the zenith), 1 = SCENE_LIGHT, 2 = SUNLIGHT */
	dynamicLighting?: number;
	/** the fixed-frame unit direction toward the scene light (dynamicLighting 1) */
	lightDirWC?: ArrayLike<number>;
	/** the fixed-frame unit direction toward the sun (dynamicLighting 2) */
	sunDirWC?: ArrayLike<number>;
	/** the ellipsoid's radius under the position (|scaleToGeodeticSurface|), m */
	radius?: number;
	/** the camera's eye-to-world rotation when the map is rendered (right, up, back: 9 numbers). ComputeRadianceMapFS's ground test,
	 *  czm_rayEllipsoidIntersectionInterval, passes the fixed-frame ray through czm_inverseModelView as if it were in eye coordinates, so the
	 *  ellipsoid it meets is turned by this rotation: the horizon drops, the rays just below it see sky and the ground rays run longer */
	viewRotation?: ArrayLike<number>;
	/** DynamicEnvironmentMapManager: atmosphereScatteringIntensity 2, groundColor #717145, groundAlbedo 0.31, brightness/saturation/gamma 1 */
	atmosphereScatteringIntensity?: number; groundColor?: ArrayLike<number>; groundAlbedo?: number; brightness?: number; saturation?: number; gamma?: number;
	/** scene.atmosphere: lightIntensity 10, rayleighCoefficient, mieCoefficient, rayleighScaleHeight 10000, mieScaleHeight 3200, mieAnisotropy 0.9 */
	lightIntensity?: number; rayleighCoefficient?: ArrayLike<number>; mieCoefficient?: ArrayLike<number>; rayleighScaleHeight?: number; mieScaleHeight?: number; mieAnisotropy?: number;
}

type V3 = [number, number, number];
const ATMOSPHERE_THICKNESS = 111e3, PRIMARY_STEPS_MAX = 16, LIGHT_STEPS_MAX = 4, SAMPLES = 256;
const tanhApprox = (x: number): number => { if (!Number.isFinite(x)) return Math.sign(x) || 0; const x2 = x * x; return Math.max(-1, Math.min(1, x * (27 + x2) / (27 + 9 * x2))); };   // czm_approximateTanh (GLSL's min/max drop the NaN of ∞/∞ when a ray meets the ground at distance 0: a position on the surface)
const sphere = (o: V3, d: V3, r: number): [number, number] | null => {   // czm_raySphereIntersectionInterval about the origin
	const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2], b = 2 * (d[0] * o[0] + d[1] * o[1] + d[2] * o[2]), c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r;
	const det = b * b - 4 * a * c;
	if (det < 0) return null;
	const q = Math.sqrt(det);
	return [(-b - q) / (2 * a), (-b + q) / (2 * a)];
};
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** czm_computeScattering + czm_computeAtmosphereColor: the atmosphere's colour along a ray and its transmittance (alpha) */
function atmosphereColor(o: V3, d: V3, rayLength: number, L: V3, inner: number, p: Required<Pick<CesiumEnvOptions, "lightIntensity" | "rayleighCoefficient" | "mieCoefficient" | "rayleighScaleHeight" | "mieScaleHeight" | "mieAnisotropy">>): [number, number, number, number] {
	const outer = inner + ATMOSPHERE_THICKNESS;
	const seg = sphere(o, d, outer);
	if (!seg) return [0, 0, 0, 0];
	const x = 1e-7 * seg[1] / rayLength, wStop = 0.5 * (1 + tanhApprox(x));
	const start0 = seg[0], start = Math.max(seg[0], 0), stop = Math.min(seg[1], rayLength);
	const wInside = 1 - 0.5 * (1 + tanhApprox(start0 - ATMOSPHERE_THICKNESS));
	const PRIMARY = PRIMARY_STEPS_MAX - Math.trunc(wInside * 12), LIGHT = LIGHT_STEPS_MAX - Math.trunc(wInside * 2);
	let rayPos = start;
	const total = stop - rayPos;
	const inc = wInside * ((1 - wStop) * total / (PRIMARY * (PRIMARY + 1) / 2));
	let step = Math.max(1 - wInside, wStop) * total / Math.max(7 * wInside, PRIMARY);
	const R = p.rayleighCoefficient, M = p.mieCoefficient, hR = p.rayleighScaleHeight, hM = p.mieScaleHeight;
	let odR = 0, odM = 0; const accR: V3 = [0, 0, 0], accM: V3 = [0, 0, 0];
	for (let i = 0; i < PRIMARY; i++) {
		const t = rayPos + step, s: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
		const h = Math.hypot(s[0], s[1], s[2]) - inner;
		const dR = Math.exp(-h / hR) * step, dM = Math.exp(-h / hM) * step;
		odR += dR; odM += dM;
		const ls = sphere(s, L, outer), lStep = (ls ? ls[1] : 0) / LIGHT;
		let lPos = 0, lodR = 0, lodM = 0;
		for (let j = 0; j < LIGHT; j++) {
			const u = lPos + lStep * 0.5, lp: V3 = [s[0] + L[0] * u, s[1] + L[1] * u, s[2] + L[2] * u];
			const lh = Math.hypot(lp[0], lp[1], lp[2]) - inner;
			lodR += Math.exp(-lh / hR) * lStep; lodM += Math.exp(-lh / hM) * lStep;
			lPos += lStep;
		}
		for (let c = 0; c < 3; c++) { const att = Math.exp(-(M[c] * (odM + lodM) + R[c] * (odR + lodR))); accR[c] += dR * att; accM[c] += dM * att; }
		step += inc; rayPos += step;
	}
	const mu = d[0] * L[0] + d[1] * L[1] + d[2] * L[2], mu2 = mu * mu, G = p.mieAnisotropy, G2 = G * G;
	const phR = 3 / 50.2654824574 * (1 + mu2), phM = 3 / 25.1327412287 * ((1 - G2) * (mu2 + 1)) / (Math.pow(1 + G2 - 2 * mu * G, 1.5) * (2 + G2));
	const out: [number, number, number, number] = [0, 0, 0, 0];
	for (let c = 0; c < 3; c++) out[c] = (phR * R[c] * accR[c] + phM * M[c] * accM[c]) * p.lightIntensity;
	out[3] = Math.hypot(Math.exp(-(M[0] * odM + R[0] * odR)), Math.exp(-(M[1] * odM + R[1] * odR)), Math.exp(-(M[2] * odM + R[2] * odR)));
	return out;
}

/** czm_rayEllipsoidIntersectionInterval of a ray from the position (in its east-north-up frame) against the WGS84 ellipsoid turned by
 *  viewRotation (the translation of czm_inverseModelView cancels), or null without one. A turned position inside the ellipsoid gives every
 *  ray length 0, which czm_computeScattering divides by (NaN on some GPUs, a plain map on others): that case is left to the plain sphere */
function turnedEllipsoid(positionWC: ArrayLike<number>, o: CesiumEnvOptions): ((d: V3) => [number, number] | null) | null {
	const R = o.viewRotation;
	if (!R) return null;
	const height = Math.hypot(positionWC[0], positionWC[1], positionWC[2]) || 1, inner = o.radius ?? 6371e3;
	const k = (Math.max(height - inner, 0) + inner) / height;
	const up = norm([positionWC[0], positionWC[1], positionWC[2]]);
	const e0: V3 = [-up[1], up[0], 0], le = Math.hypot(e0[0], e0[1]), east: V3 = le > 1e-9 ? [e0[0] / le, e0[1] / le, 0] : [0, 1, 0];
	const north: V3 = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
	const inv = [1 / 6378137, 1 / 6378137, 1 / 6356752.314245179];
	const turn = (v: ArrayLike<number>): V3 => [0, 1, 2].map(i => (v[0] * R[i] + v[1] * R[3 + i] + v[2] * R[6 + i]) * inv[i]) as V3;
	const q = turn([positionWC[0] * k, positionWC[1] * k, positionWC[2] * k]), q2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2];
	if (q2 <= 1) return null;
	return (d: V3) => {
		const w = turn([east[0] * d[0] + north[0] * d[1] + up[0] * d[2], east[1] * d[0] + north[1] * d[1] + up[1] * d[2], east[2] * d[0] + north[2] * d[1] + up[2] * d[2]]);
		const qw = q[0] * w[0] + q[1] * w[1] + q[2] * w[2];
		if (qw >= 0) return null;   // looking outward
		const w2 = w[0] * w[0] + w[1] * w[1] + w[2] * w[2], diff = q2 - 1, product = w2 * diff;
		if (qw * qw < product) return null;
		const temp = -qw + Math.sqrt(qw * qw - product), r0 = temp / w2, r1 = diff / temp;
		return r0 < r1 ? [r0, r1] : [r1, r0];
	};
}

/** ComputeRadianceMapFS for one cube direction (in the east-north-up frame of the position): the colour Cesium stores in its environment map */
export function cesiumEnvRadiance(positionWC: ArrayLike<number>, dirENU: ArrayLike<number>, o: CesiumEnvOptions = {}, turned: ((d: V3) => [number, number] | null) | null = turnedEllipsoid(positionWC, o)): V3 {
	const height = Math.hypot(positionWC[0], positionWC[1], positionWC[2]);
	const inner = o.radius ?? 6371e3, outer = inner * 1.025, atmosphereHeight = outer - inner;
	const ellipsoidHeight = Math.max(height - inner, 0);
	const pos: V3 = [0, 0, ellipsoidHeight + inner];   // the local frame: x east, y north, z up; the position on the up axis
	const d = norm([dirENU[0], dirENU[1], dirENU[2]]);
	let hit = sphere(pos, d, inner);
	if (hit && hit[1] >= 0 && turned) hit = turned(d);   // !czm_isEmpty: the (turned) ellipsoid decides
	const onEllipsoid = !!hit && hit[0] >= 0;
	const rayLength = onEllipsoid ? hit![0] : outer;
	const skyPos: V3 = [pos[0] + d[0] * rayLength, pos[1] + d[1] * rayLength, pos[2] + d[2] * rayLength];
	let L: V3;
	const dyn = o.dynamicLighting ?? 0;
	if (dyn === 0) L = norm(skyPos);
	else {   // the light's fixed-frame direction, in the east-north-up frame of the position
		const w = dyn === 1 ? o.lightDirWC : o.sunDirWC;
		const up = norm([positionWC[0], positionWC[1], positionWC[2]]);
		const e0: V3 = [-up[1], up[0], 0], le = Math.hypot(e0[0], e0[1]), east: V3 = le > 1e-9 ? [e0[0] / le, e0[1] / le, 0] : [1, 0, 0];
		const north: V3 = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
		L = w ? norm([w[0] * east[0] + w[1] * east[1] + w[2] * east[2], w[0] * north[0] + w[1] * north[1] + w[2] * north[2], w[0] * up[0] + w[1] * up[1] + w[2] * up[2]]) : [0, 0, 1];
	}
	const atm = atmosphereColor(pos, d, rayLength, L, inner, {
		lightIntensity: o.lightIntensity ?? 10, rayleighCoefficient: o.rayleighCoefficient ?? [5.5e-6, 13e-6, 28.4e-6], mieCoefficient: o.mieCoefficient ?? [21e-6, 21e-6, 21e-6],
		rayleighScaleHeight: o.rayleighScaleHeight ?? 10000, mieScaleHeight: o.mieScaleHeight ?? 3200, mieAnisotropy: o.mieAnisotropy ?? 0.9,
	});
	const intensity = o.atmosphereScatteringIntensity ?? 2;
	let color: V3;
	if (onEllipsoid) {
		const g = o.groundColor ?? [113 / 255, 113 / 255, 69 / 255], albedo = o.groundAlbedo ?? 0.31;
		const occlusion = Math.max(L[2], 0.05);   // dot(lightDirection, up)
		const k = Math.max(0, Math.min(1, ellipsoidHeight / atmosphereHeight));
		color = [0, 1, 2].map(c => { const ground = g[c] * albedo * (intensity * occlusion + atm[c]); return ground + (atm[c] - ground) * k; }) as V3;
	} else {
		let skyAlpha = Math.max(0, Math.min(1, (1 - ellipsoidHeight / atmosphereHeight) * atm[3]));
		if (Math.hypot(atm[0], atm[1], atm[2]) <= 1e-7) skyAlpha = 0;
		// mix(czm_backgroundColor, sky box, its alpha): czm_environmentMap is frameState.environmentMap = scene.skyBox._cubeMap, which SkyBox no
		// longer has (it draws a CubeMapPanorama), so it is always the context's default cube: opaque white, whatever backgroundColor says
		color = [0, 1, 2].map(c => 1 + (atm[c] * intensity - 1) * skyAlpha) as V3;
	}
	const brightness = o.brightness ?? 1, saturation = o.saturation ?? 1, gamma = o.gamma ?? 1;
	if (brightness !== 1 || saturation !== 1) {   // ENVIRONMENT_COLOR_CORRECT: mix(0, c, brightness) then czm_saturation
		for (let c = 0; c < 3; c++) color[c] *= brightness;
		const lum = 0.2125 * color[0] + 0.7154 * color[1] + 0.0721 * color[2];
		for (let c = 0; c < 3; c++) color[c] = lum + (color[c] - lum) * saturation;
	}
	if (gamma !== 1) for (let c = 0; c < 3; c++) color[c] = Math.pow(Math.max(color[c], 0), gamma);
	return color;   // czm_gammaCorrect is the identity without HDR
}

// ComputeIrradianceFS: the SH basis in Cesium's order and sign, and its 256 Hammersley directions (the same for every coefficient)
const twoSqrtPi = 2 * Math.sqrt(Math.PI);
function shBasis(i: number, s: V3): number {
	switch (i) {
		case 0: return 1 / twoSqrtPi;
		case 1: return -Math.sqrt(3) * s[1] / twoSqrtPi;
		case 2: return Math.sqrt(3) * s[2] / twoSqrtPi;
		case 3: return -Math.sqrt(3) * s[0] / twoSqrtPi;
		case 4: return Math.sqrt(15) * s[1] * s[0] / twoSqrtPi;
		case 5: return -Math.sqrt(15) * s[1] * s[2] / twoSqrtPi;
		case 6: return Math.sqrt(5) * (3 * s[2] * s[2] - 1) / 2 / twoSqrtPi;
		case 7: return -Math.sqrt(15) * s[0] * s[2] / twoSqrtPi;
		default: return Math.sqrt(15) * (s[0] * s[0] - s[1] * s[1]) / 2 / twoSqrtPi;
	}
}
const radicalInverse = (i: number): number => { let v = 0, inv = 0.5; while (i > 0) { v += (i % 2) * inv; inv *= 0.5; i = Math.trunc(i / 2); } return v; };
const HAMMERSLEY: { d: V3; sinTheta: number }[] = (() => {
	const out = [];
	for (let i = 0; i < SAMPLES; i++) {
		const x = i / SAMPLES, y = radicalInverse(i), phi = 2 * Math.PI * x;
		const cosTheta = 1 - 2 * Math.sqrt(1 - y * y), sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
		out.push({ d: norm([sinTheta * Math.cos(phi), cosTheta, sinTheta * Math.sin(phi)]), sinTheta });
	}
	return out;
})();

/** the environment's 9 SH coefficients (27 floats, Cesium's order, the cube's y-up frame) for a model at positionWC, exactly as Cesium's irradiance pass sums them */
export function cesiumEnvSH(positionWC: ArrayLike<number>, o: CesiumEnvOptions = {}): Float32Array {
	const sh = new Float32Array(27), turned = turnedEllipsoid(positionWC, o);
	for (const { d, sinTheta } of HAMMERSLEY) {
		// the cube lookup (-d.x, -d.y, d.z); GL reads Cesium's faces so that a cube direction r returns the colour rendered for the ENU direction (r.x, -r.z, r.y)
		const r: V3 = [-d[0], -d[1], d[2]];
		const c = cesiumEnvRadiance(positionWC, [r[0], -r[2], r[1]], o, turned).map(v => Math.max(0, Math.min(1, v)));   // the radiance cube is RGBA8: the sun's glow clips at 1
		const w = sinTheta / SAMPLES;
		for (let i = 0; i < 9; i++) { const y = shBasis(i, d) * w; sh[i * 3] += y * c[0]; sh[i * 3 + 1] += y * c[1]; sh[i * 3 + 2] += y * c[2]; }
	}
	const k = o.atmosphereScatteringIntensity ?? 2;   // updateSphericalHarmonicCoefficients scales the read-back coefficients by the intensity once more
	for (let i = 0; i < 27; i++) sh[i] *= k;
	return sh;
}

/** czm_sphericalHarmonics: the irradiance for a normal in the cube's frame */
export function cesiumEvalSH(sh: ArrayLike<number>, n: ArrayLike<number>): V3 {
	const x = n[0], y = n[1], z = n[2], out: V3 = [0, 0, 0];
	const b = [1, y, z, x, y * x, y * z, 3 * z * z - 1, z * x, x * x - y * y];
	for (let i = 0; i < 9; i++) for (let c = 0; c < 3; c++) out[c] += sh[i * 3 + c] * b[i];
	return [Math.max(out[0], 0), Math.max(out[1], 0), Math.max(out[2], 0)];
}

/** what L00 comes to for a uniform environment of radiance 1 before the intensity scale: with it, the scale that turns the coefficients back into a radiance (the specular lookup) */
export const CESIUM_SH_UNIFORM_L00 = HAMMERSLEY.reduce((a, s) => a + shBasis(0, s.d) * s.sinTheta / SAMPLES, 0);
