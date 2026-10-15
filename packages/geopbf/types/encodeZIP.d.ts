// "geopbf/encodeZIP"（src/modules/encodeZIP.js）＝File の列 → zip（deflate-raw・data descriptor 付き）。name を渡せば File、無ければ Blob（type＝application/zip）
export function encodeZIP(files: Iterable<File>, name: string): Promise<File>;
export function encodeZIP(files: Iterable<File>, name?: null): Promise<Blob>;
