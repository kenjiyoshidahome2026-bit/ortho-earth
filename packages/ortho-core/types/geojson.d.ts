// @ortho-earth/core/geojson — GeoJSON の overlay 組み立てと点在判定。
export function buildGeoJSONOverlay(features: unknown[], origin: number[], opts?: Record<string, unknown>): unknown;
export function pointInFeature(lon: number, lat: number, geom: { type: string; coordinates: unknown }): boolean;
