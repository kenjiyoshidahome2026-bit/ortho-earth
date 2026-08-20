export async function encodeZIP(files, name = null) {
	const enc = new TextEncoder(), tbl = new Uint32Array(256).map((_, i) => {
		let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c;
	});
	const crc32 = (bin, c = -1) => { for (let b of bin) c = (c >>> 8) ^ tbl[(c ^ b) & 255]; return c ^ -1; };
	let off = 0, cd = [], parts = [];
	for (let f of files) {
		const d = f.lastModified ? new Date(f.lastModified) : new Date();
		const ts = (d.getHours() << 11 | d.getMinutes() << 5 | d.getSeconds() >> 1);
		const ds = (Math.max(0, d.getFullYear() - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate());
		const fn = enc.encode(f.name);
		const fm = 0x00080808;
		const lfh = new Uint8Array(30 + fn.length), v = new DataView(lfh.buffer);
		v.setUint32(0, 0x04034B50, true);
		v.setUint16(4, 20, true); v.setUint32(6, fm, true);
		v.setUint16(10, ts, true); v.setUint16(12, ds, true);
		v.setUint16(26, fn.length, true);
		lfh.set(fn, 30);
		parts.push(lfh);
		let cSiz = 0, uSiz = 0, crc = -1;
		const cs = new CompressionStream('deflate-raw'), w = cs.writable.getWriter();
		const src = f.stream();
		const process = (async () => {
			for await (const chunk of src) { crc = crc32(chunk, crc); uSiz += chunk.length; await w.write(chunk); }
			await w.close();
		})();
		for await (const chunk of cs.readable) { parts.push(chunk); cSiz += chunk.length; }
		await process;
		crc >>>= 0;
		const dd = new Uint8Array(16), dv = new DataView(dd.buffer);
		dv.setUint32(0, 0x08074B50, true); dv.setUint32(4, crc, true);
		dv.setUint32(8, cSiz, true); dv.setUint32(12, uSiz, true);
		parts.push(dd);
		cd.push({ fn, crc, cSiz, uSiz, off, ds, ts, fm });
		off += lfh.length + cSiz + 16;
	}
	const cdStart = off;
	for (let f of cd) {
		const h = new Uint8Array(46 + f.fn.length), v = new DataView(h.buffer);
		v.setUint32(0, 0x02014B50, true);
		v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint32(8, f.fm, true);
		v.setUint16(12, f.ts, true); v.setUint16(14, f.ds, true);
		v.setUint32(16, f.crc, true); v.setUint32(20, f.cSiz, true); v.setUint32(24, f.uSiz, true);
		v.setUint16(28, f.fn.length, true);
		v.setUint32(42, f.off, true); h.set(f.fn, 46);
		parts.push(h);
		off += h.length;
	}
	const eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054B50, true);
	ev.setUint16(8, cd.length, true); ev.setUint16(10, cd.length, true);
	ev.setUint32(12, off - cdStart, true); ev.setUint32(16, cdStart, true);
	parts.push(eocd);
	const type = 'application/zip';
	return name? new File(parts, name, { type }): new Blob(parts, { type });
}