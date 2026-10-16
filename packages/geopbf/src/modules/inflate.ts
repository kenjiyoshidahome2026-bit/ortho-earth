// modules/inflate.ts ── 圧縮/伸長の一本化（pako 不使用）。Node（main / worker_threads）は node:zlib、ブラウザ/worker は
// CompressionStream / DecompressionStream を writer/reader で直接叩く（Blob→Response 経由の約 1/4 の固定費）。
// format: "gzip" | "deflate"（zlib 包み）| "deflate-raw" | "zstd"（Node 22.15+ の node:zlib だけ・ブラウザには無い＝hasZstd() で確認）。
// どれも非同期の同じ契約 → Promise<Uint8Array>。
//
// ⚠ Node の zlib は Chromium 版（4 バイトハッシュ）で、double 列のような「3 バイトの短い一致」が多いデータでは素の zlib より
// 1 割強大きくなる（WKB 実測: Node 0.73 / CPython 0.64）。MVT タイルではむしろ良い（0.656 / 0.673）。大きな数値列は zstd が
// 同じ時間で半分以下（level 9 で 0.38）＝GeoParquet は Node では zstd を既定にする。
export type InflateFormat = "gzip" | "deflate" | "deflate-raw" | "zstd";
type StreamFormat = Exclude<InflateFormat, "zstd">;
/** node:zlib のうちここが呼ぶ分（@types/node は入れない＝tsconfig の types: []・2026-10 TS 化） */
interface ZlibLike {
	gzipSync(u8: Uint8Array): ArrayBufferView; gunzipSync(u8: Uint8Array): ArrayBufferView;
	deflateSync(u8: Uint8Array): ArrayBufferView; inflateSync(u8: Uint8Array): ArrayBufferView;
	deflateRawSync(u8: Uint8Array): ArrayBufferView; inflateRawSync(u8: Uint8Array): ArrayBufferView;
	zstdCompressSync?(u8: Uint8Array, opts?: { params: Record<number, number> }): ArrayBufferView;
	zstdDecompressSync?(u8: Uint8Array): ArrayBufferView;
	constants: Record<string, number>;
}
type ZlibSyncName = "gzipSync" | "gunzipSync" | "deflateSync" | "inflateSync" | "deflateRawSync" | "inflateRawSync";
/** zstd の解凍器（fzstd の decompress など・同期でも非同期でも可） */
export type ZstdDecoder = (u8: Uint8Array) => Uint8Array | ArrayBufferView | Promise<Uint8Array | ArrayBufferView>;

let zlib: ZlibLike | null = null, probed: Promise<void> | null = null;
const probe = (): Promise<void> => probed ??= (async () => {
	// 指定子を組み立て式＋@vite-ignore にする＝バンドラ（vite）に "node:zlib" を解決させない。リテラルだと Node 判定の内側でも
	// 静的に拾われ「Module "node:zlib" has been externalized for browser compatibility」を全 worker ビルドで吐く（2026-09-14）。
	const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
	if (typeof proc !== "undefined" && proc.versions?.node) { try { zlib = await import(/* @vite-ignore */ "node:" + "zlib") as ZlibLike; } catch { zlib = null; } }
})();
const pipe = async (u8: Uint8Array, ts: ReadableWritablePair<Uint8Array<ArrayBuffer>, BufferSource>): Promise<Uint8Array> => {
	const w = ts.writable.getWriter(); w.write(u8 as Uint8Array<ArrayBuffer>); w.close();
	const r = ts.readable.getReader(), chunks: Uint8Array[] = []; let n = 0;
	for (;;) { const { value, done } = await r.read(); if (done) break; chunks.push(value); n += value.length; }
	if (chunks.length === 1) return chunks[0];
	const out = new Uint8Array(n); let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
	return out;
};
const Z: Record<StreamFormat, [ZlibSyncName, ZlibSyncName]> = { gzip: ["gzipSync", "gunzipSync"], deflate: ["deflateSync", "inflateSync"], "deflate-raw": ["deflateRawSync", "inflateRawSync"] };
// Node の Buffer（Uint8Array の派生）を素の Uint8Array へ写す（旧＝new Uint8Array(buffer)＝複製・同じ）
const u8of = (v: ArrayBufferView): Uint8Array => new Uint8Array(v as unknown as ArrayLike<number>);

// zstd の解凍器の注入口（2026-09-22）。ブラウザには zstd が無い（DecompressionStream("zstd") は仕様にあるが未実装）。
// geopbf は実行時依存ゼロを守る＝解凍器は持たず、呼び手が渡す（fzstd の decompress など・同期でも非同期でも可）。
// 注入は「その解凍が走るスレッド」で行う（worker の中で読むなら worker の中で setZstdDecoder を呼ぶ）。Node は node:zlib が優先。
let zstdDecoder: ZstdDecoder | null = null;
export function setZstdDecoder(fn: ZstdDecoder | null | undefined): void { zstdDecoder = typeof fn === "function" ? fn : null; }
export async function hasZstd(): Promise<boolean> { await probe(); return !!(zlib && typeof zlib.zstdCompressSync === "function"); }
export async function inflate(u8: Uint8Array, format: InflateFormat = "deflate"): Promise<Uint8Array> {
	await probe();
	if (format === "zstd") {
		if (zlib?.zstdDecompressSync) return u8of(zlib.zstdDecompressSync(u8));
		if (zstdDecoder) return u8of(await zstdDecoder(u8));
		throw new Error("zstd is not available in this environment (node:zlib on Node 22.15+, or inject a decoder with setZstdDecoder)");
	}
	if (zlib) return u8of(zlib[Z[format][1]](u8));
	return pipe(u8, new DecompressionStream(format));
}
// level: zstd の圧縮レベル（既定 9＝gzip と同程度の時間で半分以下）。gzip/deflate は zlib 既定
export async function deflate(u8: Uint8Array, format: InflateFormat = "gzip", level?: number): Promise<Uint8Array> {
	await probe();
	if (format === "zstd") { if (!zlib?.zstdCompressSync) throw new Error("zstd is not available in this environment (node:zlib on Node 22.15+ only)"); return u8of(zlib.zstdCompressSync(u8, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level ?? 9 } })); }
	if (zlib) return u8of(zlib[Z[format][0]](u8));
	return pipe(u8, new CompressionStream(format));
}
// 多数の小片を並列に（ストリーム毎の固定費を重ねる。zlib は同期なので順に）
export async function deflateMany(list: Uint8Array[], format: StreamFormat = "gzip", concurrency = 64): Promise<Uint8Array[]> {
	await probe();
	const out: Uint8Array[] = new Array(list.length);
	if (zlib) { const f = zlib[Z[format][0]]; for (let i = 0; i < list.length; i++) out[i] = u8of(f(list[i])); return out; }
	for (let i = 0; i < list.length; i += concurrency) {
		const part = await Promise.all(list.slice(i, i + concurrency).map(u8 => pipe(u8, new CompressionStream(format))));
		for (let j = 0; j < part.length; j++) out[i + j] = part[j];
	}
	return out;
}
