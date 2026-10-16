// "geopbf/gzip"＝gzip の判定・伸長・圧縮と deflate-raw（altpbf・native-bucket が読む）。名簿は実行時の export と 1:1（tests/t-dts.mjs が照合）
import {fname2mime} from "./fname2mime.ts";
/** 先頭 2 バイトが gzip の印（1f 8b）か。Blob でない・10 バイト未満＝false */
export async function isGzip(file: unknown): Promise<boolean> {
	if (!(file instanceof Blob) || file.size < 10) return false;
	const buf = new Uint8Array(await file.slice(0, 2).arrayBuffer());
	return (buf[0] === 0x1f && buf[1] === 0x8b);
}
/** gzip なら伸ばす（File なら .gz／.gzip を外した名前の File・それ以外は Blob）。gzip でなければそのまま返す */
export async function gunzip(file: Blob): Promise<Blob> {
	if (!(file instanceof Blob) || !(await isGzip(file))) return file;
	const fname = (file as File).name;
	const name = fname? fname.replace(/\.(gz|gzip)$/i, ""): null;
	const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
	try { const blob = await new Response(stream).blob();
		return name? new File([blob], name, { type: fname2mime(name) }): blob;
	} catch (e) {
		console.error("decompression error: possibly out of memory", e);
		throw e;
	}
}
/** gzip で縮める（名前＋".gz" の File）。既に gzip ならそのまま返す */
export async function gzip(file: Blob): Promise<Blob> {
	if (!(file instanceof Blob) || (await isGzip(file))) return file;
	const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
	try { const blob = await new Response(stream).blob();
		return new File([blob], (file as File).name + ".gz", { type: "application/gzip" });
	} catch (e) {
		console.error("compression error: possibly out of memory", e);
		throw e;
	}
}
async function raw(data: ArrayBuffer | ArrayBufferView, flag: boolean): Promise<Uint8Array> {
	const streamType = flag ? CompressionStream : DecompressionStream;
	const ds = new streamType('deflate-raw');
	const sourceStream = new Blob([data as BlobPart]).stream();
	const decompressedStream = sourceStream.pipeThrough(ds);
	const response = new Response(decompressedStream);
	return new Uint8Array(await response.arrayBuffer());
}
/** deflate-raw で縮める（altpbf の本体） */
export async function deflateRaw(data: ArrayBuffer | ArrayBufferView): Promise<Uint8Array> { return raw(data, true); }
/** deflate-raw を伸ばす */
export async function inflateRaw(data: ArrayBuffer | ArrayBufferView): Promise<Uint8Array> { return raw(data, false); }
