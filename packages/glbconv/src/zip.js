// 無圧縮（store）の ZIP を書く小さな道具。依存ゼロ・ブラウザでも Node でも動く。
// なぜ store か：①USDZ は「無圧縮＋データ先頭を 64 byte 境界に揃える」が仕様 ②相手が展開するだけなら十分
//（テクスチャは jpeg/webp＝既に圧縮済み・メッシュ本体も GLB なら圧縮済み）。
// align＝データ先頭の境界（USDZ は 64）。ローカルヘッダの「拡張フィールド」を詰め物に使う＝どの展開器でも素直に開く。
const enc = new TextEncoder();
const CRC = (() => { const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
	return t; })();
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ CRC[(c ^ b[i]) & 255]; return (c ^ -1) >>> 0; };

// files＝[{ name, bytes }]。戻り＝Uint8Array
export function zipStore(files, { align = 0 } = {}) {
	const parts = [], cd = [];
	let off = 0;
	const dosTime = (d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)))(new Date());
	const dosDate = (d => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()))(new Date());
	for (const f of files) {
		const name = enc.encode(f.name), bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
		let extra = 0;
		if (align > 1) { const head = off + 30 + name.length; extra = (align - (head % align)) % align; }
		const lfh = new Uint8Array(30 + name.length + extra), dv = new DataView(lfh.buffer);
		dv.setUint32(0, 0x04034B50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true); dv.setUint16(8, 0, true);
		dv.setUint16(10, dosTime, true); dv.setUint16(12, dosDate, true);
		const crc = crc32(bytes);
		dv.setUint32(14, crc, true); dv.setUint32(18, bytes.length, true); dv.setUint32(22, bytes.length, true);
		dv.setUint16(26, name.length, true); dv.setUint16(28, extra, true);
		lfh.set(name, 30);
		parts.push(lfh, bytes);
		cd.push({ name, crc, size: bytes.length, off, dosTime, dosDate });
		off += lfh.length + bytes.length;
	}
	const cdStart = off;
	for (const e of cd) {
		const h = new Uint8Array(46 + e.name.length), dv = new DataView(h.buffer);
		dv.setUint32(0, 0x02014B50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
		dv.setUint16(12, e.dosTime, true); dv.setUint16(14, e.dosDate, true);
		dv.setUint32(16, e.crc, true); dv.setUint32(20, e.size, true); dv.setUint32(24, e.size, true);
		dv.setUint16(28, e.name.length, true); dv.setUint32(42, e.off, true);
		h.set(e.name, 46);
		parts.push(h); off += h.length;
	}
	const eocd = new Uint8Array(22), dv = new DataView(eocd.buffer);
	dv.setUint32(0, 0x06054B50, true); dv.setUint16(8, cd.length, true); dv.setUint16(10, cd.length, true);
	dv.setUint32(12, off - cdStart, true); dv.setUint32(16, cdStart, true);
	parts.push(eocd);
	const total = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(total);
	let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}
