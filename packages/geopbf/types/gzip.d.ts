// "geopbf/gzip"（src/modules/gzip.js）＝gzip の判定・伸長・圧縮と deflate-raw（altpbf・native-bucket が読む）。名簿は実行時の export と 1:1（tests/t-dts.mjs が照合）
/** 先頭 2 バイトが gzip の印（1f 8b）か。Blob でない・10 バイト未満＝false */
export function isGzip(file: unknown): Promise<boolean>;
/** gzip なら伸ばす（File なら .gz／.gzip を外した名前の File・それ以外は Blob）。gzip でなければそのまま返す */
export function gunzip(file: Blob): Promise<Blob>;
/** gzip で縮める（名前＋".gz" の File）。既に gzip ならそのまま返す */
export function gzip(file: Blob): Promise<Blob>;
/** deflate-raw で縮める（altpbf の本体） */
export function deflateRaw(data: ArrayBuffer | ArrayBufferView): Promise<Uint8Array>;
/** deflate-raw を伸ばす */
export function inflateRaw(data: ArrayBuffer | ArrayBufferView): Promise<Uint8Array>;
