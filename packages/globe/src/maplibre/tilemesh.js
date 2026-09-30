// MapLibre 同名の道具（custom 層の例「Add a custom layer with tiles to a globe」が使う）：
//   createTileMesh(options, forceIndicesSize)＝タイル 1 枚を覆う格子の頂点（Int16・0..EXTENT）と索引（MapLibre GL JS 6.11.2 src/render/mesh_utils.ts の写し・BSD-3-Clause）
//   SubdivisionGranularityExpression／SubdivisionGranularitySetting＝球で描く時の細分の粒度（src/render/subdivision_granularity_settings.ts の写し）
// 極の頂点＝y が NORTH_POLE_Y（-32768）／SOUTH_POLE_Y（32767）＝球の prelude（customgl.js）が rawPos.y で見分けて極へ置く（MapLibre と同じ約束）
export const EXTENT = 8192, EXTENT_STENCIL_BORDER = EXTENT / 128, NORTH_POLE_Y = -32768, SOUTH_POLE_Y = 32767;

export function createTileMesh(options = {}, forceIndicesSize) {
	const granularity = options.granularity !== undefined ? Math.max(options.granularity, 1) : 1;
	const quadsPerAxisX = granularity + (options.generateBorders ? 2 : 0);
	const quadsPerAxisY = granularity + (options.extendToNorthPole || options.generateBorders ? 1 : 0) + (options.extendToSouthPole || options.generateBorders ? 1 : 0);
	const verticesPerAxisX = quadsPerAxisX + 1, verticesPerAxisY = quadsPerAxisY + 1;
	const offsetX = options.generateBorders ? -1 : 0, offsetY = options.generateBorders || options.extendToNorthPole ? -1 : 0;
	const endX = granularity + (options.generateBorders ? 1 : 0), endY = granularity + (options.generateBorders || options.extendToSouthPole ? 1 : 0);
	const vertexCount = verticesPerAxisX * verticesPerAxisY, indexCount = quadsPerAxisX * quadsPerAxisY * 6;
	const overflows16 = vertexCount > 65536;
	if (overflows16 && forceIndicesSize === "16bit") throw new Error("Granularity is too large and meshes would not fit inside 16 bit vertex indices.");
	const use32 = overflows16 || forceIndicesSize === "32bit";
	const vertices = new Int16Array(vertexCount * 2);
	let vi = 0;
	for (let y = offsetY; y <= endY; y++) for (let x = offsetX; x <= endX; x++) {
		let vx = x / granularity * EXTENT;
		if (x === -1) vx = -EXTENT_STENCIL_BORDER;
		if (x === granularity + 1) vx = EXTENT + EXTENT_STENCIL_BORDER;
		let vy = y / granularity * EXTENT;
		if (y === -1) vy = options.extendToNorthPole ? NORTH_POLE_Y : -EXTENT_STENCIL_BORDER;
		if (y === granularity + 1) vy = options.extendToSouthPole ? SOUTH_POLE_Y : EXTENT + EXTENT_STENCIL_BORDER;
		vertices[vi++] = vx; vertices[vi++] = vy;
	}
	const indices = use32 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
	let ii = 0;
	for (let y = 0; y < quadsPerAxisY; y++) for (let x = 0; x < quadsPerAxisX; x++) {
		const v0 = x + y * verticesPerAxisX, v1 = v0 + 1, v2 = x + (y + 1) * verticesPerAxisX, v3 = v2 + 1;
		indices[ii++] = v0; indices[ii++] = v2; indices[ii++] = v1;
		indices[ii++] = v1; indices[ii++] = v2; indices[ii++] = v3;
	}
	return { vertices: vertices.buffer.slice(0), indices: indices.buffer.slice(0), uses32bitIndices: use32 };
}

export class SubdivisionGranularityExpression {
	constructor(baseZoomGranularity, minGranularity) {
		if (minGranularity > baseZoomGranularity) throw new Error("Min granularity must not be greater than base granularity.");
		this._baseZoomGranularity = baseZoomGranularity; this._minGranularity = minGranularity;
	}
	getGranularityForZoomLevel(zoomLevel) { return Math.max(Math.floor(this._baseZoomGranularity / (1 << zoomLevel)), this._minGranularity, 1); }
}
export class SubdivisionGranularitySetting {
	constructor({ fill, line, tile, stencil, circle }) { this.fill = fill; this.line = line; this.tile = tile; this.stencil = stencil; this.circle = circle; }
}
// 球の既定（MapLibre の granularitySettingsGlobe）
export const GRANULARITY_GLOBE = new SubdivisionGranularitySetting({
	fill: new SubdivisionGranularityExpression(128, 2), line: new SubdivisionGranularityExpression(512, 0),
	tile: new SubdivisionGranularityExpression(128, 32), stencil: new SubdivisionGranularityExpression(128, 1), circle: 3,
});
