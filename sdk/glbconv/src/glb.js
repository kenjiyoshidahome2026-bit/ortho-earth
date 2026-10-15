// GLB（glTF バイナリ）の入口と出口。仕様は glTF 2.0：12 byte のヘッダ＋チャンク列（JSON→BIN）。
// チャンク長は 4 byte 境界まで詰めた長さが入る（詰め物は JSON が空白・BIN がゼロ）。
const enc = new TextEncoder(), dec = new TextDecoder();

export function parseGlb(bytes) {
	if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (dec.decode(bytes.subarray(0, 4)) !== "glTF") throw new Error("not a GLB (magic)");
	const total = Math.min(dv.getUint32(8, true), bytes.length);
	let off = 12, json = null, bin = new Uint8Array(0);
	while (off + 8 <= total) {
		const len = dv.getUint32(off, true), type = dec.decode(bytes.subarray(off + 4, off + 8));
		const body = bytes.subarray(off + 8, off + 8 + len);
		if (type.startsWith("JSON")) json = JSON.parse(dec.decode(body).replace(/\0+$/, ""));
		else if (type.startsWith("BIN")) bin = body;
		off += 8 + len;
	}
	if (!json) throw new Error("GLB has no JSON chunk");
	return { json, bin };
}

const pad4 = (n) => (4 - (n % 4)) % 4;

export function buildGlb(json, bin = new Uint8Array(0)) {
	let jb = enc.encode(JSON.stringify(json));
	if (pad4(jb.length)) { const t = new Uint8Array(jb.length + pad4(jb.length)); t.set(jb); t.fill(0x20, jb.length); jb = t; }
	const bp = pad4(bin.length);
	const total = 12 + 8 + jb.length + (bin.length ? 8 + bin.length + bp : 0);
	const out = new Uint8Array(total), dv = new DataView(out.buffer);
	out.set(enc.encode("glTF"), 0); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
	dv.setUint32(12, jb.length, true); out.set(enc.encode("JSON"), 16); out.set(jb, 20);
	if (bin.length) {
		const o = 20 + jb.length;
		dv.setUint32(o, bin.length + bp, true); out.set(enc.encode("BIN\0"), o + 4); out.set(bin, o + 8);
	}
	return out;
}

// bufferView の実体（GLB の BIN か、data: URI の buffer）を取り出す
export function viewBytes(json, bin, index) {
	const bv = json.bufferViews?.[index];
	if (!bv) return null;
	const off = bv.byteOffset || 0;
	return bin.subarray(off, off + bv.byteLength);
}
