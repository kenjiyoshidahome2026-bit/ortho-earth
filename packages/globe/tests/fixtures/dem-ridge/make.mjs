// 地形が落とす影（#112 段 2）の検定試料＝node tests/fixtures/dem-ridge/make.mjs（このフォルダで）
// 太平洋の上（既定の標高は海＝0）に標高 200m の台地（150.4〜150.6E・30.44〜30.62N）と、その上に高さ 1000m の尾根 2 本：
//   東西の尾根＝緯度 30.50・経度 150.45〜150.55（南北方向の断面：中心 ±300m が頂上・±700m で台地へ＝68° の急斜面）
//   南北の尾根＝経度 150.50・緯度 30.545〜30.59（東西方向の断面・同じ形）
// terrarium 形式・z12・256px・{z}/{x}/{y}.png（raster-dem の試料 tests/fixtures/dem と同じ作り）
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
const Z = 12, N = 256, B = [150.4, 30.44, 150.6, 30.62], PLATEAU = 200, RIDGE = 1000;
const x2lon = x => x / (1 << Z) * 360 - 180, y2lat = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (1 << Z)))) * 180 / Math.PI;
const lon2x = lon => (lon + 180) / 360 * (1 << Z), lat2y = lat => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * (1 << Z); };
const prof = d => d < 300 ? RIDGE : d < 700 ? RIDGE * (700 - d) / 400 : 0;   // 尾根の断面（中心からの距離 m）
const height = (lon, lat) => {
	if (lon < B[0] || lon > B[2] || lat < B[1] || lat > B[3]) return 0;
	const mx = 111320 * Math.cos(lat * Math.PI / 180), my = 111320;
	const ew = lon >= 150.45 && lon <= 150.55 ? prof(Math.abs(lat - 30.50) * my) : 0;
	const ns = lat >= 30.545 && lat <= 30.59 ? prof(Math.abs(lon - 150.50) * mx) : 0;
	return PLATEAU + Math.max(ew, ns);
};
let n = 0;
for (let ty = Math.floor(lat2y(B[3])); ty <= Math.floor(lat2y(B[1])); ty++) for (let tx = Math.floor(lon2x(B[0])); tx <= Math.floor(lon2x(B[2] - 1e-9)); tx++) {
	const rgb = Buffer.alloc(N * N * 3);
	for (let py = 0; py < N; py++) for (let px = 0; px < N; px++) {
		const v = height(x2lon(tx + (px + 0.5) / N), y2lat(ty + (py + 0.5) / N)) + 32768, i = (py * N + px) * 3;
		rgb[i] = Math.floor(v / 256); rgb[i + 1] = Math.floor(v % 256); rgb[i + 2] = Math.floor((v % 1) * 256);
	}
	mkdirSync(`${Z}/${tx}`, { recursive: true });
	writeFileSync(`${Z}/${tx}/${ty}.png`, png(rgb, N, N));
	n++;
}
console.log("ok", n, "tiles");
