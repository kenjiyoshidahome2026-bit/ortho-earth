// 外来の標高タイル（raster-dem・#36）の検定試料＝node tests/fixtures/dem/make.mjs
// 太平洋の上（150.5E, 30.5N・既定の標高は海＝0）に高さ 3000m・半径 0.3° の円錐の山。terrarium 形式・z10・256px・{z}/{x}/{y}.png
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
function png(rgb, w, h) {
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const Z = 10, N = 256, C = [150.5, 30.5], R = 0.3, PEAK = 3000;
const x2lon = x => x / (1 << Z) * 360 - 180, y2lat = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (1 << Z)))) * 180 / Math.PI;
const lon2x = lon => (lon + 180) / 360 * (1 << Z), lat2y = lat => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * (1 << Z); };
for (let ty = Math.floor(lat2y(31)); ty <= Math.floor(lat2y(30)); ty++) for (let tx = Math.floor(lon2x(150)); tx <= Math.floor(lon2x(151 - 1e-9)); tx++) {
	const rgb = Buffer.alloc(N * N * 3);
	for (let py = 0; py < N; py++) for (let px = 0; px < N; px++) {
		const lon = x2lon(tx + (px + 0.5) / N), lat = y2lat(ty + (py + 0.5) / N);
		const d = Math.hypot((lon - C[0]) * Math.cos(lat * Math.PI / 180), lat - C[1]);
		const h = PEAK * Math.max(0, 1 - d / R), v = h + 32768, i = (py * N + px) * 3;
		rgb[i] = Math.floor(v / 256); rgb[i + 1] = Math.floor(v % 256); rgb[i + 2] = Math.floor((v % 1) * 256);
	}
	mkdirSync(`${Z}/${tx}`, { recursive: true });
	writeFileSync(`${Z}/${tx}/${ty}.png`, png(rgb, N, N));
}
console.log("ok");
