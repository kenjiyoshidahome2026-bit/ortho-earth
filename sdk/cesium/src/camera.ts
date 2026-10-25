// Cesium's Camera ⇄ the globe's camera.
//   The Cesium side is the real @cesium/engine Camera (flyTo, setView, lookAt, viewBoundingSphere, EntityView all run unchanged).
//   The globe's camera is a look-at camera: { lng, lat, height } of the target, distance (m) to it, heading, pitch (0 = straight down), roll.
//   push: Cesium → globe. The target is where the view ray meets the ellipsoid (or a point along the ray when it looks at the sky).
//   pull: globe → Cesium (the user dragged the globe). Written into the camera's own reference frame, so a lookAtTransform (trackedEntity) survives.
import { Cartesian3, Cartographic, Ellipsoid, FixedFrameTransforms, IntersectionTests, Matrix3, Matrix4, Ray } from "@cesium/core";

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const enu = new Matrix4(), rot = new Matrix3(), inv = new Matrix3(), ray = new Ray(), carto = new Cartographic();
const v1 = new Cartesian3(), v2 = new Cartesian3(), v3 = new Cartesian3(), E = new Cartesian3(), N = new Cartesian3(), U = new Cartesian3();

export interface GlobeCam { lng: number; lat: number; height: number; distance: number; heading: number; pitch: number; roll: number }

/** the east, north and up axes at a point (ECEF) */
function axesAt(p: Cartesian3): void {
	FixedFrameTransforms.eastNorthUpToFixedFrame(p, Ellipsoid.WGS84, enu);
	Matrix4.getMatrix3(enu, rot);
	Matrix3.getColumn(rot, 0, E); Matrix3.getColumn(rot, 1, N); Matrix3.getColumn(rot, 2, U);
}

/** the globe camera that shows what a Cesium camera at (pos, dir, up) shows (all ECEF, world frame) */
export function globeCamOf(pos: Cartesian3, dir: Cartesian3, up: Cartesian3): GlobeCam | null {
	Cartesian3.clone(pos, ray.origin); Cartesian3.normalize(dir, ray.direction);
	const hit = IntersectionTests.rayEllipsoid(ray, Ellipsoid.WGS84);
	const c = Ellipsoid.WGS84.cartesianToCartographic(pos, carto);
	if (!c) return null;
	let t: number;
	if (hit && hit.start > 0) t = hit.start;
	else if (hit && hit.stop > 0) t = hit.stop;   // inside the ellipsoid (below sea level)
	else t = Math.max(1000, c.height);   // sky: a target along the ray as far as the camera is high
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
	const level = levelUp(d, v2);
	let roll = 0;
	if (level) {
		const cr = Cartesian3.cross(level, Cartesian3.normalize(up, v3), new Cartesian3());
		roll = Math.atan2(Cartesian3.dot(cr, d), Cartesian3.dot(level, v3)) * R2D;
	}
	return { lng: tc.longitude * R2D, lat: tc.latitude * R2D, height: tc.height, distance: t, heading: ((heading % 360) + 360) % 360, pitch, roll: Math.abs(roll) < 1e-3 ? 0 : roll };
}
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
