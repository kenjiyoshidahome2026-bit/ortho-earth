// Entity bounding spheres as Cesium computes them (zoomTo / flyTo frame by these): each geometry graphic's own updater makes the fill and
// outline geometry instances, the geometry's createGeometry gives the bounding sphere, moved by the instance's model matrix. The spheres
// are merged with BoundingSphere.fromBoundingSpheres, as DataSourceDisplay does (the caller adds the marks' position, which may move).
// Dynamic (time-varying) geometry is measured at the time asked (and says so: the caller does not keep it).
import { BoundingSphere, Ellipsoid, Matrix4 } from "@cesium/core";
import * as engine from "@cesium/engine";

type Any = any;
const E = engine as Any, { ApproximateTerrainHeights } = E;
const UPDATERS: [string, Any][] = [
	["box", E.BoxGeometryUpdater], ["corridor", E.CorridorGeometryUpdater], ["cylinder", E.CylinderGeometryUpdater], ["ellipse", E.EllipseGeometryUpdater],
	["ellipsoid", E.EllipsoidGeometryUpdater], ["plane", E.PlaneGeometryUpdater], ["polygon", E.PolygonGeometryUpdater], ["polyline", E.PolylineGeometryUpdater],
	["polylineVolume", E.PolylineVolumeGeometryUpdater], ["rectangle", E.RectangleGeometryUpdater], ["wall", E.WallGeometryUpdater],
];

// ground (clamped) geometry is framed by its rectangle and the approximate terrain heights there, as GroundPrimitive does
let heightsReady = false;
const heights: Promise<void> = Promise.resolve().then(() => (ApproximateTerrainHeights as Any).initialize()).then(() => { heightsReady = true; }, () => {});
void heights;

const NO_PRIMITIVES = { add: (p: Any) => p, remove: () => true, removeAndDestroy: () => true, contains: () => false };

const sphereOfInstance = (inst: Any): BoundingSphere | null => {
	const g = inst?.geometry;
	if (!g) return null;
	const geom = g.constructor?.createGeometry ? g.constructor.createGeometry(g) : g;
	const bs = geom?.boundingSphere;
	if (!bs) return null;
	const out = inst.modelMatrix && !Matrix4.equals(inst.modelMatrix, Matrix4.IDENTITY) ? BoundingSphere.transform(bs, inst.modelMatrix, new BoundingSphere()) : BoundingSphere.clone(bs);
	// Primitive keeps the centre in single precision: so do we (fromBoundingSpheres over a regular grid of spheres turns on such ties)
	out.center.x = Math.fround(out.center.x); out.center.y = Math.fround(out.center.y); out.center.z = Math.fround(out.center.z);
	return out;
};

/** the entity's bounding sphere as Cesium frames it, or null (nothing static to measure: the caller's own sphere is used) */
export function cesiumSphereOf(entity: Any, scene: Any, time: Any): { bs: BoundingSphere; dynamic: boolean } | null | "pending" {
	const out: BoundingSphere[] = [];
	let dynamic = false;
	for (const [name, U] of UPDATERS) {
		if (!U || !entity[name]) continue;
		let u: Any;
		try { u = new U(entity, scene); } catch { return null; }
		try {
			if (!u.fillEnabled && !u.outlineEnabled) continue;
			if (u.isDynamic) {   // the dynamic updater sets the options for this time (what its primitive is built from)
				const d = u.createDynamicUpdater(NO_PRIMITIVES, NO_PRIMITIVES);
				d._setOptions(entity, entity[name], time);
				if (d._isHidden?.(entity, entity[name], time)) { d.destroy?.(); continue; }
				dynamic = true;
			}
			for (const [on, make] of [[u.fillEnabled, "createFillGeometryInstance"], [u.outlineEnabled, "createOutlineGeometryInstance"]] as const) {
				if (!on) continue;
				let s: BoundingSphere | null = null;
				try {
					const inst = u[make](time);
					if (u.onTerrain && make === "createFillGeometryInstance") {
						if (!heightsReady) return "pending";
						const rect = inst?.geometry?.rectangle;
						s = rect ? (ApproximateTerrainHeights as Any).getBoundingSphere(rect, Ellipsoid.WGS84) : null;
					} else s = sphereOfInstance(inst);
				} catch { s = null; }
				if (s) out.push(s);
			}
		} finally { u.destroy?.(); }
	}
	if (!out.length) return null;
	return { bs: out.length === 1 ? out[0] : BoundingSphere.fromBoundingSpheres(out), dynamic };
}
