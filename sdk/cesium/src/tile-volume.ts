// Tile bounding volumes the way Cesium picks them (3D Tiles metadata semantics).
type Any = any;

/** a tile's bounding volume as Cesium3DTile.createBoundingVolume picks it: tile metadata with the semantic TILE_BOUNDING_BOX / _REGION /
 *  _SPHERE (3D Tiles 1.1 metadata, or the 3DTILES_metadata extension) overrides header.boundingVolume. Cesium ion's Reality Tiler writes
 *  a loose cube as the implicit root's volume and the tight box as metadata (tightBoundingBox): zoomTo frames by the tight one. */
export function tileVolume(json: Any, tile: Any): Any {
	const md = tile?.metadata ?? tile?.extensions?.["3DTILES_metadata"], schema = json?.schema ?? json?.extensions?.["3DTILES_metadata"]?.schema;
	const cls = md && schema?.classes?.[md.class];
	if (cls?.properties) for (const [sem, key] of [["TILE_BOUNDING_BOX", "box"], ["TILE_BOUNDING_REGION", "region"], ["TILE_BOUNDING_SPHERE", "sphere"]] as const) {
		const name = Object.keys(cls.properties).find(k => cls.properties[k]?.semantic === sem);
		const v = name != null ? (md.properties?.[name] ?? cls.properties[name].default) : undefined;
		if (Array.isArray(v) && v.length === { box: 12, region: 6, sphere: 4 }[key] && v.every(x => typeof x === "number")) return { [key]: v };
	}
	return tile?.boundingVolume;
}
