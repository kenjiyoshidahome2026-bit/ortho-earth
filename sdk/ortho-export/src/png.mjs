// PNG の読み書き（8bit RGB/RGBA・非インターレース＝地理院 dem_png はこれ）。node:zlib だけ。
//   decodePng＝apps/japan-map/scripts/bake-dem10b.mjs の復号を Uint8Array に書き直した物。encodePng は検定の見本づくり用。
import { inflateSync, deflateSync, crc32 } from "node:zlib";

const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
export function decodePng(buf) {
	const d = dv(buf);
	if (d.getUint32(0) !== 0x89504e47) throw new Error("not png");
	let pos = 8, w = 0, h = 0, colorType = 0; const idat = [];
	while (pos < buf.length) {
		const len = d.getUint32(pos), type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
		const body = buf.subarray(pos + 8, pos + 8 + len);
		if (type === "IHDR") { const b = dv(body); w = b.getUint32(0); h = b.getUint32(4); colorType = body[9];
			if (body[8] !== 8 || (colorType !== 2 && colorType !== 6) || body[12]) throw new Error(`png: unsupported depth=${body[8]} color=${colorType}`); }
		else if (type === "IDAT") idat.push(body);
		else if (type === "IEND") break;
		pos += 12 + len;
	}
	const bpp = colorType === 6 ? 4 : 3, stride = w * bpp;
	const raw = inflateSync(Buffer.concat(idat.map(b => Buffer.from(b.buffer, b.byteOffset, b.byteLength))));
	const px = new Uint8Array(h * stride);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const out = px.subarray(y * stride), prev = y ? px.subarray((y - 1) * stride) : null;
		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? out[x - bpp] : 0, b = prev ? prev[x] : 0, c = (prev && x >= bpp) ? prev[x - bpp] : 0;
			let v = row[x];
			if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
			else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc) ? b : c; }
			out[x] = v;
		}
	}
	return { w, h, px, bpp };
}

/** RGB（w×h×3）→ PNG（filter 0・zlib） */
export function encodePng(w, h, rgb) {
	const raw = new Uint8Array(h * (w * 3 + 1));
	for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1); }
	const chunk = (type, body) => {
		const out = new Uint8Array(12 + body.length), d = dv(out);
		d.setUint32(0, body.length); out.set([...type].map(c => c.charCodeAt(0)), 4); out.set(body, 8);
		d.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
		return out;
	};
	const ihdr = new Uint8Array(13), id = dv(ihdr); id.setUint32(0, w); id.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
	const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}
