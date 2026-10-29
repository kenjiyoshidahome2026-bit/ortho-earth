// Cesium3DTileset.clippingPlanes → the globe's clipping (map.setClipping, target "models" = models, 3D Tiles, I3S). Cesium keeps n·P + d ≥ 0
// of every plane (unionClippingRegions false) in the frame clippingPlanesOriginMatrix × collection.modelMatrix; the planes are moved into the
// Earth-fixed frame here (the globe's spec.ecef) each frame the collection or its planes change (the examples drag a plane's distance).
import { Cartesian3, Cartographic, Ellipsoid, FixedFrameTransforms, Matrix4, Plane } from "@cesium/core";
import { sphereOfVolume } from "./tileset.ts";

type Any = any;
const MIN_TERRAIN_HEIGHT = -100000;   // ApproximateTerrainHeights._defaultMinTerrainHeight

/**
 * Cesium3DTileset.clippingPlanesOriginMatrix: root.computedTransform (modelMatrix × root transform) × an ENU frame at the root volume's own centre
 * when that centre is above the ground (an Earth-fixed volume); otherwise the root's frame alone
 */
export function clippingOriginOf(json: Any, modelMatrix: Matrix4): Matrix4 {
	const rt = json?.root?.transform?.length === 16 ? Matrix4.unpack(json.root.transform) : Matrix4.IDENTITY;
	const computed = Matrix4.multiply(modelMatrix, rt, new Matrix4());
	const c = sphereOfVolume(json?.root?.boundingVolume)?.center;
	const carto = c && !Cartesian3.equals(c, Cartesian3.ZERO) ? Ellipsoid.WGS84.cartesianToCartographic(c, new Cartographic()) : undefined;
	const initial = carto && carto.height > MIN_TERRAIN_HEIGHT ? FixedFrameTransforms.eastNorthUpToFixedFrame(c!) : Matrix4.IDENTITY;
	return Matrix4.multiply(computed, initial, new Matrix4());
}

/** a ClippingPlaneCollection on a tileset → the globe's clip spec (null: nothing clipped) and what it cannot draw */
export function clipSpecOf(coll: Any, origin: Matrix4): { spec: Any | null; skipped: string[] } {
	const skipped: string[] = [];
	if (!coll || coll.enabled === false || !(coll.length > 0)) return { spec: null, skipped };
	const M = Matrix4.multiply(origin, coll.modelMatrix ?? Matrix4.IDENTITY, new Matrix4());
	const ecef: number[][] = [];
	for (let i = 0; i < coll.length; i++) {
		const p = coll.get(i);
		if (!p?.normal) continue;
		const w = Plane.transform(new Plane(Cartesian3.normalize(p.normal, new Cartesian3()), p.distance), M, new Plane(Cartesian3.UNIT_X, 0));
		ecef.push([w.normal.x, w.normal.y, w.normal.z, w.distance]);
	}
	if (!ecef.length) return { spec: null, skipped };
	if (coll.unionClippingRegions && ecef.length > 1) skipped.push("ClippingPlaneCollection unionClippingRegions (drawn as the intersection)");
	const ew = coll.edgeWidth ?? 0, ec = coll.edgeColor;
	return {
		spec: { ecef, targets: ["models"], cap: false, edge: ew > 0 ? { width: ew, color: ec ? [ec.red, ec.green, ec.blue] : [1, 1, 1] } : false },
		skipped,
	};
}
