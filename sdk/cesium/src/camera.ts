// Cesium's Camera ⇄ the globe's camera.
//   The Cesium side is the real @cesium/engine Camera (flyTo, setView, lookAt, viewBoundingSphere, EntityView all run unchanged).
//   The globe's camera is a look-at camera: { lng, lat, height } of the target, distance (m) to it, heading, pitch (0 = straight down), roll.
//   push: Cesium → globe. The target is where the view ray meets the ellipsoid (or a point along the ray when it looks at the sky).
//   pull: globe → Cesium (the user dragged the globe). Written into the camera's own reference frame, so a lookAtTransform (trackedEntity) survives.
import { Cartesian3, Cartographic, Ellipsoid, FixedFrameTransforms, IntersectionTests, Matrix3, Matrix4, Ray } from "@cesium/core";

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const enu = new Matrix4(), rot = new Matrix3(), inv = new Matrix3(), ray = new Ray(), carto = new Cartographic();
const v1 = new Cartesian3(), v2 = new Cartesian3(), v3 = new Cartesian3(), E = new Cartesian3(), N = new Cartesian3(), U = new Cartesian3();

export interface GlobeCam { lng: number; lat: number; height: number; distance: number; heading: number; pitch: number; roll: number; pending?: boolean; near?: number }

/** the east, north and up axes at a point (ECEF) */
function axesAt(p: Cartesian3): void {
	FixedFrameTransforms.eastNorthUpToFixedFrame(p, Ellipsoid.WGS84, enu);
	Matrix4.getMatrix3(enu, rot);
	Matrix3.getColumn(rot, 0, E); Matrix3.getColumn(rot, 1, N); Matrix3.getColumn(rot, 2, U);
}

/** the globe camera that shows what a Cesium camera at (pos, dir, up) shows (all ECEF, world frame) */
//   focus: the point the camera looks at (camera.lookAt / trackedEntity): when it is on the view ray and nearer than the ground, it is the target,
//   so the globe's near plane follows the distance to it (a model seen from a few metres at 100 km up is not cut away)
//   terrainAt: the drawn terrain's height (m, Cesium's heights) at a lng/lat, null while unknown. With it the target is where the view ray meets the
//   terrain, not the ellipsoid (a camera looking at a mountain 2 km away had its target 7 km away on the ellipsoid behind it: the globe took a low
//   zoom and coarse windows, 2026-10-28). The ray is sampled from the eye outwards and the first crossing refined; a sample without an answer
//   yet marks the result `pending` (the caller asks again on a later frame) and the march goes on with the ellipsoid
export function globeCamOf(pos: Cartesian3, dir: Cartesian3, up: Cartesian3, focus?: Cartesian3 | null, terrainAt?: ((lng: number, lat: number) => number | null | undefined) | null): GlobeCam | null {
	Cartesian3.clone(pos, ray.origin); Cartesian3.normalize(dir, ray.direction);
	const hit = IntersectionTests.rayEllipsoid(ray, Ellipsoid.WGS84);
	const c = Ellipsoid.WGS84.cartesianToCartographic(pos, carto);
	if (!c) return null;
	let t: number, pending = false;
	const ground = hit && hit.start > 0 ? hit.start : Infinity;
	const ft = focus ? Cartesian3.dot(Cartesian3.subtract(focus, pos, v2), ray.direction) : 0;
	if (focus && ft > 0 && ft < ground && Cartesian3.distance(Ray.getPoint(ray, ft, v3), focus) < ft * 1e-3 && (Ellipsoid.WGS84.cartesianToCartographic(focus, new Cartographic())?.height ?? 0) > 0) t = ft;
	else if (hit && hit.start > 0) t = hit.start;
	else if (hit && hit.stop > 0) t = hit.stop;   // inside the ellipsoid (below sea level)
	else t = Math.max(1000, c.height);   // sky: a target along the ray as far as the camera is high
	if (terrainAt && !(focus && t === ft)) {
		const m = terrainHit(terrainAt, hit && hit.start > 0 ? hit.start : horizonDistance(c.height));
		if (m.t != null) t = m.t;
		pending = m.pending;
	}
	const target = Ray.getPoint(ray, t, v1);
	const tc = Ellipsoid.WGS84.cartesianToCartographic(target, new Cartographic());
	if (!tc) return null;
	axesAt(target);
	const d = ray.direction;
	const de = Cartesian3.dot(d, E), dn = Cartesian3.dot(d, N), du = Cartesian3.dot(d, U);
	// straight down the ray has no horizontal part: the heading is where the camera's up points
	const heading = (Math.hypot(de, dn) < 1e-6 ? Math.atan2(Cartesian3.dot(up, E), Cartesian3.dot(up, N)) : Math.atan2(de, dn)) * R2D;
	const pitch = Math.max(0, Math.min(90, 90 + Math.asin(Math.max(-1, Math.min(1, du))) * R2D));   // 0 = straight down (MapLibre)
	// roll: the angle from the level "up" (the up a camera with this heading and pitch has without roll) to the camera's up, about the view ray
	// straight down (the heading came from up): no roll is left. Measuring it from levelUp turned a pitch just past -90° (the ray tipped back) into roll 180 = the picture upside down (3d-tiles-formats)
	const level = Math.hypot(de, dn) < 1e-6 ? null : levelUp(d, v2);
	let roll = 0;
	if (level) {
		const cr = Cartesian3.cross(level, Cartesian3.normalize(up, v3), new Cartesian3());
		roll = Math.atan2(Cartesian3.dot(cr, d), Cartesian3.dot(level, v3)) * R2D;
	}
	const out: GlobeCam = { lng: tc.longitude * R2D, lat: tc.latitude * R2D, height: tc.height, distance: t, heading: ((heading % 360) + 360) % 360, pitch, roll: Math.abs(roll) < 1e-3 ? 0 : roll };
	if (pending) out.pending = true;
	return out;
}
/** how far the view ray (ray.origin / ray.direction) goes before it meets the terrain: null = no crossing before tMax. pending = a sample had no height yet */
const TERRAIN_SAMPLES = 48;
function terrainHit(terrainAt: (lng: number, lat: number) => number | null | undefined, tMax: number): { t: number | null; pending: boolean } {
	let pending = false;
	const above = (t: number): boolean | null => {   // is the ray point above the terrain at t? null = unknown
		const p = Ray.getPoint(ray, t, v3), pc = Ellipsoid.WGS84.cartesianToCartographic(p, scratchCarto);
		if (!pc) return true;
		const h = terrainAt(pc.longitude * R2D, pc.latitude * R2D);
		if (h == null || !Number.isFinite(h)) { pending = true; return null; }
		return pc.height > h;
	};
	if (!(tMax > 0) || !Number.isFinite(tMax)) return { t: null, pending };
	const t0 = Math.max(0.5, tMax * 1e-4);
	let prev = -1;   // the last sample known to be above the terrain (−1 = none yet)
	for (let i = 0; i <= TERRAIN_SAMPLES; i++) {
		const ti = i === TERRAIN_SAMPLES ? tMax : t0 * Math.pow(tMax / t0, i / TERRAIN_SAMPLES);
		const a = above(ti);
		if (a === false) {
			if (prev < 0) return { t: ti, pending };   // no sample above before this one: the eye is in the ground (or the heights before are unknown yet)
			let lo = prev, hi = ti;   // refine the crossing between the last point above and this one below
			for (let k = 0; k < 12; k++) {
				let mid = (lo + hi) / 2, am = above(mid);
				if (am === null) { mid = lo + (hi - lo) * 0.37; am = above(mid); }   // no height at that point yet: a nearby one may be known
				if (am === null) { mid = lo + (hi - lo) * 0.63; am = above(mid); }
				if (am === null) break;   // stop refining: the next frame (pending) tries again
				if (am === false) hi = mid; else lo = mid;
			}
			return { t: hi, pending };
		}
		if (a === true) prev = ti;
	}
	return { t: null, pending };
}
const scratchCarto = new Cartographic();
/** distance (m) from a camera h m up to the sea horizon, and a little beyond for the terrain above it */
const horizonDistance = (h: number): number => Math.sqrt(Math.max(0, h) * (2 * 6378137 + Math.max(0, h))) * 1.2 + 10000;
// the up vector without roll for view direction d at the current axes (E, N, U): perpendicular to d, in the plane of d and U
function levelUp(d: Cartesian3, out: Cartesian3): Cartesian3 | null {
	const du = Cartesian3.dot(d, U);
	Cartesian3.subtract(U, Cartesian3.multiplyByScalar(d, du, v3), out);
	if (Cartesian3.magnitude(out) < 1e-9) {   // straight down: up = forward-horizontal of the heading. Without one, north
		Cartesian3.clone(N, out);
	}
	return Cartesian3.normalize(out, out);
}

/** the Cesium camera pose (world frame) of a globe camera */
export function poseOfGlobeCam(g: GlobeCam): { position: Cartesian3; direction: Cartesian3; up: Cartesian3 } {
	const target = Cartesian3.fromDegrees(g.lng, g.lat, g.height || 0);
	axesAt(target);
	const h = g.heading * D2R, t = g.pitch * D2R;
	const fwd = Cartesian3.add(Cartesian3.multiplyByScalar(E, Math.sin(h), new Cartesian3()), Cartesian3.multiplyByScalar(N, Math.cos(h), new Cartesian3()), new Cartesian3());
	const direction = Cartesian3.subtract(Cartesian3.multiplyByScalar(fwd, Math.sin(t), new Cartesian3()), Cartesian3.multiplyByScalar(U, Math.cos(t), new Cartesian3()), new Cartesian3());
	let up = Cartesian3.add(Cartesian3.multiplyByScalar(fwd, Math.cos(t), new Cartesian3()), Cartesian3.multiplyByScalar(U, Math.sin(t), new Cartesian3()), new Cartesian3());
	if (g.roll) up = Matrix3.multiplyByVector(Matrix3.fromQuaternion(quatAxisAngle(direction, g.roll * D2R), new Matrix3()), up, new Cartesian3());   // about the view ray, the same sense as globeCamOf
	const position = Cartesian3.subtract(target, Cartesian3.multiplyByScalar(direction, g.distance, new Cartesian3()), new Cartesian3());
	return { position, direction: Cartesian3.normalize(direction, direction), up: Cartesian3.normalize(up, up) };
}
function quatAxisAngle(axis: Cartesian3, a: number) {
	const n = Cartesian3.normalize(axis, new Cartesian3()), s = Math.sin(a / 2);
	return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(a / 2) } as any;
}

/** write a world-frame pose into a Cesium camera, keeping its reference frame (camera.transform) */
export function setCameraWorldPose(camera: any, p: { position: Cartesian3; direction: Cartesian3; up: Cartesian3 }): void {
	const T = camera.transform as Matrix4;
	if (Matrix4.equals(T, Matrix4.IDENTITY)) {
		Cartesian3.clone(p.position, camera.position); Cartesian3.clone(p.direction, camera.direction); Cartesian3.clone(p.up, camera.up);
	} else {
		const it = camera.inverseTransform as Matrix4;
		Matrix4.multiplyByPoint(it, p.position, camera.position);
		Matrix4.getMatrix3(it, inv);
		Matrix3.multiplyByVector(inv, p.direction, camera.direction); Matrix3.multiplyByVector(inv, p.up, camera.up);
		Cartesian3.normalize(camera.direction, camera.direction); Cartesian3.normalize(camera.up, camera.up);
	}
	Cartesian3.cross(camera.direction, camera.up, camera.right);
	Cartesian3.normalize(camera.right, camera.right);
	Cartesian3.cross(camera.right, camera.direction, camera.up);   // re-orthogonalize
	Cartesian3.normalize(camera.up, camera.up);
}

/** a cheap fingerprint of a Cesium camera (world frame) to see whether code moved it */
export function poseKey(camera: any): number[] {
	const p = camera.positionWC, d = camera.directionWC, u = camera.upWC;
	return [p.x, p.y, p.z, d.x, d.y, d.z, u.x, u.y, u.z];
}
export function sameKey(a: number[] | null, b: number[]): boolean {
	if (!a) return false;
	const s = Math.max(1, Math.hypot(b[0], b[1], b[2]));
	for (let i = 0; i < 3; i++) if (Math.abs(a[i] - b[i]) > s * 1e-9 + 1e-3) return false;
	for (let i = 3; i < 9; i++) if (Math.abs(a[i] - b[i]) > 1e-7) return false;
	return true;
}
export function sameGlobeCam(a: GlobeCam | null, b: GlobeCam): boolean {
	if (!a) return false;
	return Math.abs(a.lng - b.lng) < 1e-9 && Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.height - b.height) < 1e-3 && Math.abs(a.distance - b.distance) < Math.max(1e-3, b.distance * 1e-9)
		&& Math.abs(a.heading - b.heading) < 1e-7 && Math.abs(a.pitch - b.pitch) < 1e-7 && Math.abs(a.roll - b.roll) < 1e-7;
}
