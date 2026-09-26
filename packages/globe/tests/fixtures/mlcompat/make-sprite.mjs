// 互換の爪車の試料：小さな sprite（MapLibre の base.json＋base.png）を 2 組（default と "alt"）作る。node make-sprite.mjs
import fs from "node:fs";
import zlib from "node:zlib";
const crc = b => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
function png(w, h, rgba) {
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) raw[y * (w * 4 + 1) + 1 + x * 4 + k] = rgba(x, y)[k]; }
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const write = (name, color) => {
	fs.writeFileSync(`${name}.png`, png(16, 16, () => color));
	fs.writeFileSync(`${name}.json`, JSON.stringify({ sq: { x: 0, y: 0, width: 16, height: 16, pixelRatio: 1 } }));
};
write("sprite-a", [255, 0, 0, 255]);   // default＝赤い四角 "sq"
write("sprite-b", [0, 0, 255, 255]);   // "alt"＝青い四角 "alt:sq"
console.log("sprite fixtures written");
