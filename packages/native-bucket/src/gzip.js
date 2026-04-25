import {fname2mime} from "./fname2mime.js";
export async function isGzip(file) {
    if (!(file instanceof Blob) || file.size < 10) return false;
    const buf = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    return (buf[0] === 0x1f && buf[1] === 0x8b);
}
export async function gunzip(file) {
    if (!(file instanceof Blob) || !(await isGzip(file))) return file;
    const name = file.name? file.name.replace(/\.(gz|gzip)$/i, ""): null;
    const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
    try { const blob = await new Response(stream).blob();
        return name? new File([blob], name, { type: fname2mime(name) }): blob;
    } catch (e) {
        console.error("解凍エラー: メモリ不足の可能性があります", e);
        throw e;
    }
}
export async function gzip(file) { //console.log("gzip");
    if (!(file instanceof Blob) || (await isGzip(file))) return file;
    const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
    try { const blob = await new Response(stream).blob();
        return new File([blob], file.name + ".gz", { type: "application/gzip" });
    } catch (e) {
        console.error("圧縮エラー: メモリ不足の可能性があります", e);
        throw e;
    }
}
async function raw(data, flag) {
    const streamType = flag ? CompressionStream : DecompressionStream;
    const ds = new streamType('deflate-raw');
    const sourceStream = new Blob([data]).stream();
    const decompressedStream = sourceStream.pipeThrough(ds);
    const response = new Response(decompressedStream);
    return new Uint8Array(await response.arrayBuffer());
}
export async function deflateRaw(data) { return raw(data, true); }
export async function inflateRaw(data) { return raw(data, false); }