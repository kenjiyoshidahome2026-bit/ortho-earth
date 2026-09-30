#!/usr/bin/env node
// t-iiif の試料（#177）＝小さな IIIF Image API v2 level0 の静的タイル（PNG・256・段 1/2/4）＋基準点の注記（Allmaps の形）を焼く。依存なし（PNG は zlib で自前）。
// 画像 1024×768：地は薄茶・印の四角（48px）を既知の画素に置く＝赤(200,150)・緑(824,150)・青(824,618)・黄(200,618)・紫(512,384)。
// 基準点＝印の中心 → 東京付近の経緯度（中心の紫だけ少しずらす＝アフィンでは合わず TPS なら通る歪み）。枠（resourceMask）＝周り 20px を外す。
// 使い方: node scripts/bake-iiif-fixture.mjs  → tests/fixtures/iiif/{img/…, annotation.json}
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "tests/fixtures/iiif");
const W = 1024, H = 768, TS = 256, SCALES = [1, 2, 4];
export const MARKS = [[200, 150, [230, 30, 30], 139.700, 35.720], [824, 150, [30, 170, 60], 139.800, 35.721], [824, 618, [40, 60, 220], 139.802, 35.650], [200, 618, [240, 200, 20], 139.699, 35.651], [512, 384, [170, 40, 200], 139.7535, 35.6880]];
const px = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) px.set([240, 230, 210, 255], i * 4);
for (const [cx, cy, rgb] of MARKS) for (let y = cy - 24; y < cy + 24; y++) for (let x = cx - 24; x < cx + 24; x++) px.set([...rgb, 255], (y * W + x) * 4);

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const v of b) c = CRC[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
function png(w, h, rgba) {
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
	const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// 段 s の画素（箱で縮める）
function level(s) {
	const w = Math.ceil(W / s), h = Math.ceil(H / s), o = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
		let sum = 0, n = 0;
		for (let yy = y * s; yy < Math.min(H, (y + 1) * s); yy++) for (let xx = x * s; xx < Math.min(W, (x + 1) * s); xx++) { sum += px[(yy * W + xx) * 4 + c]; n++; }
		o[(y * w + x) * 4 + c] = Math.round(sum / n);
	}
	return { w, h, o };
}
rmSync(OUT, { recursive: true, force: true });
for (const s of SCALES) {
	const L = level(s);
	for (let y = 0; y < H; y += TS * s) for (let x = 0; x < W; x += TS * s) {
		const rw = Math.min(TS * s, W - x), rh = Math.min(TS * s, H - y), sw = Math.ceil(rw / s), sh = Math.ceil(rh / s);
		const t = new Uint8Array(sw * sh * 4);
		for (let j = 0; j < sh; j++) t.set(L.o.subarray(((y / s + j) * L.w + x / s) * 4, ((y / s + j) * L.w + x / s + sw) * 4), j * sw * 4);
		const dir = path.join(OUT, "img", `${x},${y},${rw},${rh}`, `${sw},`, "0");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "default.png"), png(sw, sh, t));
	}
}
writeFileSync(path.join(OUT, "img", "info.json"), JSON.stringify({ "@context": "http://iiif.io/api/image/2/context.json", "@id": "../img", protocol: "http://iiif.io/api/image", width: W, height: H,
	profile: ["http://iiif.io/api/image/2/level0.json", { formats: ["png"] }], tiles: [{ width: TS, scaleFactors: SCALES }], attribution: "Fixture map © Nobody (public domain)" }, null, 1));
const mask = [[20, 20], [W - 20, 20], [W - 20, H - 20], [20, H - 20]];
writeFileSync(path.join(OUT, "annotation.json"), JSON.stringify({
	"@context": ["http://iiif.io/api/extension/georef/1/context.json", "http://iiif.io/api/presentation/3/context.json"],
	type: "Annotation", id: "https://example.org/t-iiif/annotation", motivation: "georeferencing",
	target: { type: "SpecificResource", source: { id: "img", type: "ImageService2", width: W, height: H }, selector: { type: "SvgSelector", value: `<svg width="${W}" height="${H}"><polygon points="${mask.map(p => p.join(",")).join(" ")}" /></svg>` } },
	body: { type: "FeatureCollection", transformation: { type: "thinPlateSpline" }, features: MARKS.map(([x, y, , lon, lat]) => ({ type: "Feature", properties: { resourceCoords: [x, y] }, geometry: { type: "Point", coordinates: [lon, lat] } })) },
}, null, 1));
console.log("iiif fixture →", OUT);
