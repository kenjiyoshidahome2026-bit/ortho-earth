// LAZ（LASzip で縮めた LAS の点の記録）の 1 チャンクを解く（#178・COPC の節＝1 チャンク）。laz-perf の実体は呼び手が渡す（web／node で起こし方が違う）。
//   decodeLazChunk(lp, bytes, { format, recordLength, count }) → Uint8Array（recordLength × count の平たい点の記録＝LAS の形式 6/7/8 のまま）
export function decodeLazChunk(lp, bytes, { format, recordLength: L, count: n }) {
	const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const cp = lp._malloc(src.byteLength), pp = lp._malloc(L), rec = new Uint8Array(n * L);
	try {
		lp.HEAPU8.set(src, cp);
		const dec = new lp.ChunkDecoder();
		try { dec.open(format, L, cp); for (let i = 0; i < n; i++) { dec.getPoint(pp); rec.set(lp.HEAPU8.subarray(pp, pp + L), i * L); } }
		finally { dec.delete(); }
	} finally { lp._free(cp); lp._free(pp); }
	return rec;
}
