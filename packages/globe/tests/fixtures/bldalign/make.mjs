// 深いチルトで基図の線と建物の足元が揃うかの検定試料（2026-11-11 本人報告「チルトを深くすると、基図と建物がズレる？」）＝node tests/fixtures/bldalign/make.mjs
// 太平洋の上（150.5E, 30.5N）。標高＝一様 40m の台地（terrarium・z12）。MVT（z16・1 枚）：
//   bld＝40m 四方の建物 1 棟（中心）・road＝建物の南 20m を東西に走る線と、建物の外周（足元の輪郭）
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
const here = new URL(".", import.meta.url).pathname;
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
function png(rgb, w, h) {
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const C = [150.5, 30.5], H0 = 40;
const lon2x = (lon, z) => (lon + 180) / 360 * (1 << z), lat2y = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * (1 << z); };
// DEM z12：中心の周り 3×3 枚・一様 H0
{ const Z = 12, N = 256, tx0 = Math.floor(lon2x(C[0], Z)), ty0 = Math.floor(lat2y(C[1], Z));
	const v = H0 + 32768, rgb = Buffer.alloc(N * N * 3); for (let i = 0; i < N * N; i++) { rgb[i * 3] = v >> 8; rgb[i * 3 + 1] = v & 255; rgb[i * 3 + 2] = 0; }
	const p = png(rgb, N, N);
	for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const d = `${here}dem/${Z}/${tx0 + dx}`; mkdirSync(d, { recursive: true }); writeFileSync(`${d}/${ty0 + dy}.png`, p); } }
// MVT z16
const Z = 16, E = 4096, tx = Math.floor(lon2x(C[0], Z)), ty = Math.floor(lat2y(C[1], Z));
const MY = 111320, MX = MY * Math.cos(C[1] * Math.PI / 180);
const at = (eM, nM) => [C[0] + eM / MX, C[1] + nM / MY];
const tp = ([lon, lat]) => [Math.round((lon2x(lon, Z) - tx) * E), Math.round((lat2y(lat, Z) - ty) * E)];
const varint = n => { const o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const zz = n => (n << 1) ^ (n >> 31);
const fld = (no, wt) => varint((no << 3) | wt);
const bytes = (no, b) => [...fld(no, 2), ...varint(b.length), ...b];
const str = (no, s) => bytes(no, [...Buffer.from(s)]);
function geom(rings, close) {   // rings＝[[x,y],...] の列
	const g = []; let cx = 0, cy = 0;
	for (const r of rings) {
		const pts = close ? r.slice(0, -1) : r;
		g.push(1 | (1 << 3), zz(pts[0][0] - cx), zz(pts[0][1] - cy)); cx = pts[0][0]; cy = pts[0][1];
		g.push(2 | ((pts.length - 1) << 3)); for (const [x, y] of pts.slice(1)) { g.push(zz(x - cx), zz(y - cy)); cx = x; cy = y; }
		if (close) g.push(7 | (1 << 3));
	}
	return g;
}
const feature = (type, g) => { const pg = g.flatMap(varint); return bytes(2, [...fld(3, 0), type, ...bytes(4, pg)]); };
const layer = (name, feats) => bytes(3, [...fld(15, 0), 2, ...str(1, name), ...feats.flat(), ...fld(5, 0), ...varint(E)]);
const sq = [at(-20, -20), at(20, -20), at(20, 20), at(-20, 20), at(-20, -20)].map(tp);   // 時計回り（MVT の外周＝画面座標で y 下向き）は下で反転
const ringCW = sq.slice().reverse();
const road = [at(-200, -40), at(200, -40)].map(tp);   // 建物の南面（−20m）から 20m 南
const tile = [...layer("bld", [feature(3, geom([ringCW], true))]), ...layer("road", [feature(2, geom([road], false)), feature(2, geom([sq], false))])];
mkdirSync(`${here}mvt/${Z}/${tx}`, { recursive: true });
writeFileSync(`${here}mvt/${Z}/${tx}/${ty}.pbf`, Buffer.from(tile));
console.log("ok", { tx, ty });
