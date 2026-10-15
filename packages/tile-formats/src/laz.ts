// LAZ（LASzip で縮めた LAS の点の記録）の 1 チャンクを解く（#178・COPC の節＝1 チャンク）。laz-perf の実体は呼び手が渡す（web／node で起こし方が違う）。
//   decodeLazChunk(lp, bytes, { format, recordLength, count }) → Uint8Array（recordLength × count の平たい点の記録＝LAS の形式 6/7/8 のまま）
//   decodeLazFile(lp, bytes, onBatch)＝ファイル丸ごと（普通の LAZ）
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

/**
 * LAZ のファイルを丸ごと解く（点群計画 段 3-3・普通の LAZ＝COPC でない物）。laz-perf の LASZip（ファイル全体を WASM の heap に置く）。
 *   onBatch(rec, count)＝recordLength × count の平たい点の記録を batch 点ずつ渡す（全点の記録を一度に持たない）。返り＝{ count, recordLength, format }
 */
export function decodeLazFile(lp, bytes, onBatch, { batch = 1 << 18 } = {}) {
	const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const fp = lp._malloc(src.byteLength);
	if (!fp) throw new Error("laz: out of memory for the whole file");
	let pp = 0;
	try {
		lp.HEAPU8.set(src, fp);
		const z = new lp.LASZip();
		try {
			z.open(fp, src.byteLength);
			const count = z.getCount(), L = z.getPointLength(), format = z.getPointFormat(), rec = new Uint8Array(Math.min(batch, count) * L);
			pp = lp._malloc(L);
			for (let done = 0; done < count;) {
				const k = Math.min(batch, count - done);
				for (let i = 0; i < k; i++) { z.getPoint(pp); rec.set(lp.HEAPU8.subarray(pp, pp + L), i * L); }
				onBatch(k === rec.length / L ? rec : rec.subarray(0, k * L), k);
				done += k;
			}
			return { count, recordLength: L, format };
		} finally { z.delete(); }
	} finally { lp._free(fp); if (pp) lp._free(pp); }
}
