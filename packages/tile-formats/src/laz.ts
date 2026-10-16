// LAZ（LASzip で縮めた LAS の点の記録）の 1 チャンクを解く（#178・COPC の節＝1 チャンク）。laz-perf の実体は呼び手が渡す（web／node で起こし方が違う）。
//   decodeLazChunk(lp, bytes, { format, recordLength, count }) → Uint8Array（recordLength × count の平たい点の記録＝LAS の形式 6/7/8 のまま）
//   decodeLazFile(lp, bytes, onBatch)＝ファイル丸ごと（普通の LAZ）
import type { LazPerf } from "laz-perf";
export type { LazPerf };

/** 1 チャンクの形（COPC の節＝ヘッダの形式・記録長と節の点の数） */
export interface LazChunkSpec { format: number; recordLength: number; count: number }
/** 丸ごと解いた時の要約 */
export interface LazFileInfo { count: number; recordLength: number; format: number }
export type LazBatchFn = (rec: Uint8Array, count: number) => void;

export function decodeLazChunk(lp: LazPerf, bytes: Uint8Array | ArrayBuffer, { format, recordLength: L, count: n }: LazChunkSpec): Uint8Array {
	const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	// 点は WASM の heap の 1 本の領域へ順に解かせ、最後に 1 回だけ写す（旧＝点ごとに subarray を作って rec へ写す＝10 万点で 10 万回の往復）。
	// heap は解読の途中で伸び得る（HEAPU8 が付け替わる）＝写す時に読み直す
	const cp = lp._malloc(src.byteLength), pp = lp._malloc(Math.max(1, n * L));
	if (!cp || !pp) { if (cp) lp._free(cp); if (pp) lp._free(pp); throw new Error("laz: out of memory for the chunk"); }
	try {
		lp.HEAPU8.set(src, cp);
		const dec = new lp.ChunkDecoder();
		try { dec.open(format, L, cp); for (let i = 0; i < n; i++) dec.getPoint(pp + i * L); }
		finally { dec.delete(); }
		return lp.HEAPU8.slice(pp, pp + n * L);
	} finally { lp._free(cp); lp._free(pp); }
}

/**
 * LAZ のファイルを丸ごと解く（点群計画 段 3-3・普通の LAZ＝COPC でない物）。laz-perf の LASZip（ファイル全体を WASM の heap に置く）。
 *   onBatch(rec, count)＝recordLength × count の平たい点の記録を batch 点ずつ渡す（全点の記録を一度に持たない）。返り＝{ count, recordLength, format }
 */
export function decodeLazFile(lp: LazPerf, bytes: Uint8Array | ArrayBuffer, onBatch: LazBatchFn, { batch = 1 << 18 }: { batch?: number } = {}): LazFileInfo {
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
			pp = lp._malloc(Math.max(1, rec.length));   // batch 点ぶんの領域へ順に解かせ、batch ごとに 1 回だけ写す（decodeLazChunk と同じ）
			if (!pp) throw new Error("laz: out of memory for a batch");
			for (let done = 0; done < count;) {
				const k = Math.min(batch, count - done);
				for (let i = 0; i < k; i++) z.getPoint(pp + i * L);
				rec.set(lp.HEAPU8.subarray(pp, pp + k * L));
				onBatch(k === rec.length / L ? rec : rec.subarray(0, k * L), k);
				done += k;
			}
			return { count, recordLength: L, format };
		} finally { z.delete(); }
	} finally { lp._free(fp); if (pp) lp._free(pp); }
}
