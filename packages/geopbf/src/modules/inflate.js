// modules/inflate.js ── 圧縮/伸長の一本化（pako 不使用）。Node（main / worker_threads）は node:zlib、ブラウザ/worker は
// CompressionStream / DecompressionStream を writer/reader で直接叩く（Blob→Response 経由の約 1/4 の固定費）。
// format: "gzip" | "deflate"（zlib 包み）| "deflate-raw" | "zstd"（Node 22.15+ の node:zlib だけ・ブラウザには無い＝hasZstd() で確認）。
// どれも非同期の同じ契約 → Promise<Uint8Array>。
//
// ⚠ Node の zlib は Chromium 版（4 バイトハッシュ）で、double 列のような「3 バイトの短い一致」が多いデータでは素の zlib より
// 1 割強大きくなる（WKB 実測: Node 0.73 / CPython 0.64）。MVT タイルではむしろ良い（0.656 / 0.673）。大きな数値列は zstd が
// 同じ時間で半分以下（level 9 で 0.38）＝GeoParquet は Node では zstd を既定にする。
let zlib = null, probed = null;
const probe = () => probed ??= (async () => {
	if (typeof process !== "undefined" && process.versions?.node) { try { zlib = await import("node:zlib"); } catch { zlib = null; } }
})();
const pipe = async (u8, ts) => {
	const w = ts.writable.getWriter(); w.write(u8); w.close();
	const r = ts.readable.getReader(), chunks = []; let n = 0;
	for (;;) { const { value, done } = await r.read(); if (done) break; chunks.push(value); n += value.length; }
	if (chunks.length === 1) return chunks[0];
	const out = new Uint8Array(n); let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
	return out;
};
const Z = { gzip: ["gzipSync", "gunzipSync"], deflate: ["deflateSync", "inflateSync"], "deflate-raw": ["deflateRawSync", "inflateRawSync"] };

export async function hasZstd() { await probe(); return !!(zlib && typeof zlib.zstdCompressSync === "function"); }
export async function inflate(u8, format = "deflate") {
	await probe();
	if (format === "zstd") { if (!zlib?.zstdDecompressSync) throw new Error("zstd はこの環境では使えない（Node 22.15+ の node:zlib のみ）"); return new Uint8Array(zlib.zstdDecompressSync(u8)); }
	if (zlib) return new Uint8Array(zlib[Z[format][1]](u8));
	return pipe(u8, new DecompressionStream(format));
}
// level: zstd の圧縮レベル（既定 9＝gzip と同程度の時間で半分以下）。gzip/deflate は zlib 既定
export async function deflate(u8, format = "gzip", level) {
	await probe();
	if (format === "zstd") { if (!zlib?.zstdCompressSync) throw new Error("zstd はこの環境では使えない（Node 22.15+ の node:zlib のみ）"); return new Uint8Array(zlib.zstdCompressSync(u8, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level ?? 9 } })); }
	if (zlib) return new Uint8Array(zlib[Z[format][0]](u8));
	return pipe(u8, new CompressionStream(format));
}
// 多数の小片を並列に（ストリーム毎の固定費を重ねる。zlib は同期なので順に）
export async function deflateMany(list, format = "gzip", concurrency = 64) {
	await probe();
	const out = new Array(list.length);
	if (zlib) { const f = zlib[Z[format][0]]; for (let i = 0; i < list.length; i++) out[i] = new Uint8Array(f(list[i])); return out; }
	for (let i = 0; i < list.length; i += concurrency) {
		const part = await Promise.all(list.slice(i, i + concurrency).map(u8 => pipe(u8, new CompressionStream(format))));
		for (let j = 0; j < part.length; j++) out[i + j] = part[j];
	}
	return out;
}
