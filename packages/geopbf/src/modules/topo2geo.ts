/** TopoJSON（ここが読む分だけ）＝arcs・transform・objects */
export interface TopoTransform { scale?: [number, number]; translate?: [number, number] }
export interface TopoGeometry { type: string; coordinates?: unknown; arcs?: unknown; geometries?: TopoGeometry[]; properties?: Record<string, unknown>; id?: unknown }
export interface Topology { arcs?: number[][][]; transform?: TopoTransform | null; objects: Record<string, TopoGeometry> }
export interface TopoFeature { type: "Feature"; geometry: GeoGeometry | undefined; properties: Record<string, unknown>; id?: unknown }
export interface GeoGeometry { type: string; coordinates?: unknown; geometries?: (GeoGeometry | undefined)[] }
type XY = number[];

export function topo2geo(topo: Topology): { type: "FeatureCollection"; features: TopoFeature[] } {
	const { arcs, transform, objects } = topo;
	const { scale = [1, 1], translate = [0, 0] } = transform || {};
	const tran = (c: XY): XY => [ c[0] * scale[0] + translate[0], c[1]* scale[1] + translate[1] ];
	const decodePoints = (coords: XY[]): XY[] => { let t = [0,0]; return transform? coords.map(c => [t[0] += c[0], t[1] += c[1]]).map(tran): coords; };
	const decodedArcs = (arcs||[]).map(decodePoints);
	const getCoords = (arcs: number[]): XY[] => { let coords: XY[] = [];
		arcs.forEach((idx, i) => {
			let arc = decodedArcs[idx < 0 ? ~idx : idx];
			if (idx < 0) arc = [...arc].reverse();
			if (i > 0) arc = arc.slice(1);
			coords = coords.concat(arc);
		});
		return coords;
	};
	const geom = (g: TopoGeometry): GeoGeometry | undefined => { const type = g.type;
		switch (type) {
			case "Point": return { type, coordinates: tran(g.coordinates as XY)};
			case "MultiPoint": return { type, coordinates: decodePoints(g.coordinates as XY[])};
			case "LineString": return { type, coordinates: getCoords(g.arcs as number[])};
			case "MultiLineString": return { type, coordinates: (g.arcs as number[][]).map(getCoords)};
			case "Polygon": return { type, coordinates: (g.arcs as number[][]).map(getCoords)};
			case "MultiPolygon": return { type, coordinates: (g.arcs as number[][][]).map(t => t.map(getCoords))};
			case "GeometryCollection": return { type, geometries: (g.geometries || []).map(geom)};
		}
		return undefined;
	}
	const toFeature = (g: TopoGeometry): TopoFeature => {
		const f: TopoFeature = { type: "Feature", geometry: geom(g), properties: g.properties || {} };
		(g.id === undefined) || (f.id = g.id);
		return f;
	};
	const features: TopoFeature[] = [];
	for (const key in objects) {
		const obj = objects[key];
		if (obj.type === "GeometryCollection") {
			(obj.geometries || []).forEach(t=> features.push(toFeature(t)));
		} else {
			features.push(toFeature(obj));
		}
	}
	return { type: "FeatureCollection", features };
}
