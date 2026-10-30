// lerc (Esri's LERC decoder, the one @cesium/engine's createVerticesFromHeightmap uses) ships no types: the part the terrain bridge reads
declare module "lerc" {
	interface LercResult { width: number; height: number; pixels: ArrayLike<number>[]; statistics: Array<{ minValue: number; maxValue: number }> }
	const Lerc: { decode(input: ArrayBuffer, options?: Record<string, unknown>): LercResult };
	export default Lerc;
}
