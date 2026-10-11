// modules/varint.js ── LEB128 の符号なし varint と zigzag（protobuf・Thrift compact・PMTiles の台帳・Parquet の DELTA 頭が同じ形）。
// 旧＝parquet-read / parquet / mvt / pmtiles に読み手・書き手が 6 本（改良点 15）。modules/pbf.js（GeoPBF 本体の protobuf・64 bit の
// 分岐つきの最適化版）だけは据え置き。値は Number（2^53 まで正確・それ以上は読み手が丸める）。
// 読み: cursor＝{ pos } を進める（TReader や { pos: 0 } をそのまま渡せる）。切れていれば例外。
export function readUvarint(u8, c) {
	let v = 0, m = 1, b;
	do { if (c.pos >= u8.length) throw new Error("varint: truncated"); b = u8[c.pos++]; v += (b & 127) * m; m *= 128; } while (b >= 128);
	return v;
}
export const zigzagDecode = (n) => n % 2 ? -(n + 1) / 2 : n / 2;
export function readSvarint(u8, c) { return zigzagDecode(readUvarint(u8, c)); }
// 書き: buf に pos から書いて次の位置を返す（呼び手が 10 バイトの余裕を確保する）
export function writeUvarint(buf, pos, v) {
	while (v >= 128) { buf[pos++] = (v % 128) | 128; v = Math.floor(v / 128); }
	buf[pos++] = v;
	return pos;
}
export const zigzagEncode = (v) => v >= 0 ? v * 2 : -v * 2 - 1;
export function writeSvarint(buf, pos, v) { return writeUvarint(buf, pos, zigzagEncode(v)); }
