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

/** a ClippingPolygonCollection (Cesium3DTileset.clippingPolygons, Globe.clippingPolygons) → a globe clip group on those targets (null: none).
 *  Cesium cuts the inside of each polygon as a vertical prism (inverse: keeps only the inside); the globe's polygon clip does the same */
export function polygonClipOf(coll: Any, targets: string[]): Any | null {
	if (!coll || coll.enabled === false || !(coll.length > 0)) return null;
	const rings: number[][][] = [];
	for (let i = 0; i < coll.length; i++) {
		const ps: Cartesian3[] | undefined = coll.get(i)?.positions;
		if (!ps || ps.length < 3) continue;
		rings.push(ps.map(p => { const c = Cartographic.fromCartesian(p); return [+(c.longitude * 180 / Math.PI).toFixed(9), +(c.latitude * 180 / Math.PI).toFixed(9)]; }));
	}
	return rings.length ? { polygon: rings, inverse: !!coll.inverse, targets, cap: false, edge: false } : null;
}

/** Globe.clippingPlanes → a globe clip group on the terrain (null: none). The globe's planes are in collection.modelMatrix alone (no origin
 *  matrix). Cesium's default (unionClippingRegions false) cuts where every plane is behind (n·P + d ≤ 0 for all): planes upright at the
 *  collection's centre make that a vertical prism = the polygon clip (the box-shaped hole of terrain-clipping-planes); union true keeps
 *  the side in front of every plane = the plane clip */
export function globeClipOf(coll: Any): { spec: Any | null; skipped: string[] } {
	const skipped: string[] = [];
	if (!coll || coll.enabled === false || !(coll.length > 0)) return { spec: null, skipped };
	const M: Matrix4 = coll.modelMatrix ?? Matrix4.IDENTITY;
	const ew = coll.edgeWidth ?? 0, ec = coll.edgeColor, edge = ew > 0 ? { width: ew, color: ec ? [ec.red, ec.green, ec.blue] : [1, 1, 1] } : false;
	const planes: number[][] = [];
	for (let i = 0; i < coll.length; i++) {
		const p = coll.get(i);
		if (!p?.normal) continue;
		const w = Plane.transform(new Plane(Cartesian3.normalize(p.normal, new Cartesian3()), p.distance), M, new Plane(Cartesian3.UNIT_X, 0));
		planes.push([w.normal.x, w.normal.y, w.normal.z, w.distance]);
	}
	if (!planes.length) return { spec: null, skipped };
	if (coll.unionClippingRegions || planes.length === 1) return { spec: { ecef: planes, targets: ["terrain"], cap: false, edge }, skipped };
	const ring = cutPrismRing(planes, Matrix4.getTranslation(M, new Cartesian3()));
	if (!ring) { skipped.push("Globe.clippingPlanes that are not upright (drawn as the intersection)"); return { spec: { ecef: planes, targets: ["terrain"], cap: false, edge }, skipped }; }
	return { spec: { polygon: [ring], inverse: false, targets: ["terrain"], cap: false, edge }, skipped };
}

/** the region behind every plane (n·P + d ≤ 0), when each plane stands upright at C: the convex ring in [lon, lat] (null: not upright / empty) */
export function cutPrismRing(planes: number[][], C: Cartesian3): number[][] | null {
	if (!(Cartesian3.magnitude(C) > 1e5)) return null;
	const F = FixedFrameTransforms.eastNorthUpToFixedFrame(C);
	const E = new Cartesian3(F[0], F[1], F[2]), N = new Cartesian3(F[4], F[5], F[6]), U = new Cartesian3(F[8], F[9], F[10]);
	const S = 2e5;   // start from a 400 km square around C and cut it by each plane (Sutherland–Hodgman)
	let poly: number[][] = [[-S, -S], [S, -S], [S, S], [-S, S]];
	for (const p of planes) {
		const n = new Cartesian3(p[0], p[1], p[2]);
		if (Math.abs(Cartesian3.dot(n, U)) > 0.2) return null;   // a plane leaning more than ~12° from upright
		const a = Cartesian3.dot(n, E), b = Cartesian3.dot(n, N), c = Cartesian3.dot(n, C) + p[3];
		const f = (q: number[]) => a * q[0] + b * q[1] + c;   // ≤ 0 = behind the plane = cut
		const out: number[][] = [];
		for (let i = 0; i < poly.length; i++) {
			const A = poly[i], B = poly[(i + 1) % poly.length], fa = f(A), fb = f(B);
			if (fa <= 0) out.push(A);
			if ((fa <= 0) !== (fb <= 0)) { const t = fa / (fa - fb); out.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]); }
		}
		poly = out;
		if (poly.length < 3) return null;
	}
	const R2D = 180 / Math.PI;
	return poly.map(([x, y]) => {
		const P = new Cartesian3(C.x + E.x * x + N.x * y, C.y + E.y * x + N.y * y, C.z + E.z * x + N.z * y), c = Cartographic.fromCartesian(P);
		return [+(c.longitude * R2D).toFixed(9), +(c.latitude * R2D).toFixed(9)];
	});
}
