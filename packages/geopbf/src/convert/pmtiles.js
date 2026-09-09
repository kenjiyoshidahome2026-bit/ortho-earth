// convert/pmtiles.js ── PMTiles v3 のライタ（＋検定用の最小リーダ）。仕様: github.com/protomaps/PMTiles/blob/main/spec/v3
// 1 ファイル = ヘッダ 127B ＋ root ディレクトリ ＋ JSON メタ ＋ leaf ディレクトリ ＋ タイル本体。
// tileId は各ズームの Hilbert 曲線順（pmtiles の zxyToTileId と同式）。同一内容のタイルは 1 回だけ格納し、
// 連続 id の同一内容は runLength に畳む（海の空タイル等）。内部圧縮・タイル圧縮は gzip（gzip.js＝Node は zlib・ブラウザは
// CompressionStream・pako 不使用）。
import { gzip, gunzip, gzipMany } from "./gzip.js";

const tzValues = [0, 1, 5, 21, 85, 341, 1365, 5461, 21845, 87381, 349525, 1398101, 5592405, 22369621, 89478485, 357913941, 1431655765, 5726623061, 22906492245, 91625968981, 366503875925, 1466015503701, 5864062014805, 23456248059221, 93824992236885, 375299968947541, 1501199875790165];
function rotate(n, xy, rx, ry) {
	if (ry === 0) { if (rx === 1) { xy[0] = n - 1 - xy[0]; xy[1] = n - 1 - xy[1]; } const t = xy[0]; xy[0] = xy[1]; xy[1] = t; }
}
export function zxyToTileId(z, x, y) {
	if (z > 26) throw new Error("pmtiles: zoom > 26");
	const n = 1 << z;
	if (x < 0 || y < 0 || x >= n || y >= n) throw new Error("pmtiles: tile out of range");
	// 配列を使わない整数版（575k タイルで 4.3 秒→0.1 秒）。d は 2^52 まで＝double で正確
	let d = 0, xx = x, yy = y;
	for (let s = n >>> 1; s > 0; s >>>= 1) {
		const rx = (xx & s) ? 1 : 0, ry = (yy & s) ? 1 : 0;
		d += s * s * ((3 * rx) ^ ry);
		if (ry === 0) { if (rx === 1) { xx = s - 1 - xx; yy = s - 1 - yy; } const t = xx; xx = yy; yy = t; }
	}
	return tzValues[z] + d;
}
export function tileIdToZxy(id) {
	let acc = 0;
	for (let z = 0; z < 27; z++) {
		const num = 2 ** z * 2 ** z;
		if (acc + num > id) {
			const n = 2 ** z, xy = [0, 0]; let t = id - acc;
			for (let s = 1; s < n; s *= 2) {
				const rx = 1 & Math.floor(t / 2), ry = 1 & (t ^ rx);
				rotate(s, xy, rx, ry); xy[0] += s * rx; xy[1] += s * ry; t = Math.floor(t / 4);
			}
			return [z, xy[0], xy[1]];
		}
		acc += num;
	}
	throw new Error("pmtiles: tileId out of range");
}

// ── varint ──
class Writer {
	constructor(cap = 1024) { this.buf = new Uint8Array(cap); this.pos = 0; }
	need(n) { if (this.pos + n > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n)); b.set(this.buf); this.buf = b; } }
	varint(v) {   // 64bit までを double のまま（2^53 未満）
		this.need(10);
		while (v >= 0x80) { this.buf[this.pos++] = (v % 128) | 0x80; v = Math.floor(v / 128); }
		this.buf[this.pos++] = v;
	}
	bytes(u8) { this.need(u8.length); this.buf.set(u8, this.pos); this.pos += u8.length; }
	finish() { return this.buf.subarray(0, this.pos); }
}
function readVarint(u8, p) {   // → [value, nextPos]
	let v = 0, m = 1, b;
	do { b = u8[p.i++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
	return v;
}

export function serializeDirectory(entries) {
	const w = new Writer(entries.length * 8 + 16);
	w.varint(entries.length);
	let last = 0;
	for (const e of entries) { w.varint(e.tileId - last); last = e.tileId; }
	for (const e of entries) w.varint(e.runLength);
	for (const e of entries) w.varint(e.length);
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length) w.varint(0); else w.varint(e.offset + 1);
	}
	return w.finish();
}
export function deserializeDirectory(u8) {
	const p = { i: 0 }, n = readVarint(u8, p), entries = [];
	let last = 0;
	for (let i = 0; i < n; i++) { last += readVarint(u8, p); entries.push({ tileId: last, offset: 0, length: 0, runLength: 0 }); }
	for (let i = 0; i < n; i++) entries[i].runLength = readVarint(u8, p);
	for (let i = 0; i < n; i++) entries[i].length = readVarint(u8, p);
	for (let i = 0; i < n; i++) { const v = readVarint(u8, p); entries[i].offset = v === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : v - 1; }
	return entries;
}

const COMP = { none: 1, gzip: 2 };
const decompress = (u8, code) => code === 2 ? gunzip(u8) : Promise.resolve(u8);
// 内容キー＝FNV-1a 32bit ×2（異なる種）＋長さ。同一キーで bytes が違えば呼び出し側が枝番を振る
export const contentKey = (u8) => {
	let a = 0x811c9dc5, b = 0x01000193;
	for (let i = 0; i < u8.length; i++) { a = Math.imul(a ^ u8[i], 0x01000193); b = Math.imul(b ^ u8[i], 0x1b873593) ^ (b >>> 13); }
	return (a >>> 0) + ":" + (b >>> 0) + ":" + u8.length;
};
export const sameBytes = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

// tiles: [{ z, x, y, data: Uint8Array（未圧縮の MVT）}]。metadata: JSON になるオブジェクト。
// opts: { tileCompression: "gzip"|"none", internalCompression: "gzip"|"none", tileType: 1(mvt), minZoom, maxZoom, bounds:[w,s,e,n], center:[lon,lat,zoom] }
export async function writePMTiles(tiles, metadata = {}, opts = {}) {
	const tc = opts.tileCompression ?? "gzip";
	// 圧縮前の内容でキーを取り、同じ内容は 1 回しか圧縮しない
	const contents = new Map(), items = new Array(tiles.length), raws = [];
	for (let i = 0; i < tiles.length; i++) {
		const t = tiles[i];
		let key = contentKey(t.data), rec = contents.get(key), n = 0;
		while (rec && !sameBytes(rec.raw, t.data)) { key = key + "#" + (++n); rec = contents.get(key); }
		if (!rec) { rec = { raw: t.data, comp: null }; contents.set(key, rec); raws.push(rec); }
		items[i] = { id: zxyToTileId(t.z, t.x, t.y), key };
	}
	const comps = tc === "gzip" ? await gzipMany(raws.map(r => r.raw)) : raws.map(r => r.raw);
	raws.forEach((r, i) => { r.comp = comps[i]; });
	const map = new Map(); for (const [k, r] of contents) map.set(k, r.comp);
	return assemblePMTiles(items, map, metadata, opts);
}

// items: [{ id: tileId, key }]・contents: Map key → 圧縮済み（tileCompression 適用済み）バイト列。tiler / worker 経路の入口。
export async function assemblePMTiles(items, contents, metadata = {}, opts = {}) {
	const tc = opts.tileCompression ?? "gzip", ic = opts.internalCompression ?? "gzip";
	const tileType = opts.tileType ?? 1;
	const compress = (u8, kind) => kind === "gzip" ? gzip(u8) : Promise.resolve(u8);
	// 1) id 順に整列・格納位置の割当・runLength 畳み込み
	items.sort((a, b) => a.id - b.id);
	const place = new Map(), chunks = [], entries = [];
	let dataLen = 0;
	for (const it of items) {
		let rec = place.get(it.key);
		if (!rec) { const bytes = contents.get(it.key); rec = { offset: dataLen, length: bytes.length }; dataLen += bytes.length; chunks.push(bytes); place.set(it.key, rec); }
		const prev = entries[entries.length - 1];
		if (prev && prev.offset === rec.offset && prev.length === rec.length && prev.tileId + prev.runLength === it.id) prev.runLength++;
		else entries.push({ tileId: it.id, offset: rec.offset, length: rec.length, runLength: 1 });
	}
	// 2) root / leaf
	let root, leaves = new Uint8Array(0), rootBytes;
	const ROOT_MAX = 16384 - 127;
	const rootOnly = await compress(serializeDirectory(entries), ic);
	if (rootOnly.length <= ROOT_MAX) { root = entries; rootBytes = rootOnly; }
	else {
		for (let leafSize = 4096; ; leafSize *= 2) {
			const rootEntries = [], parts = [];
			let off = 0;
			const raw = [];
			for (let i = 0; i < entries.length; i += leafSize) raw.push(serializeDirectory(entries.slice(i, i + leafSize)));
			const leafBytes = ic === "gzip" ? await gzipMany(raw) : raw;
			for (let i = 0, j = 0; i < entries.length; i += leafSize, j++) {
				rootEntries.push({ tileId: entries[i].tileId, offset: off, length: leafBytes[j].length, runLength: 0 });
				parts.push(leafBytes[j]); off += leafBytes[j].length;
			}
			const rb = await compress(serializeDirectory(rootEntries), ic);
			if (rb.length <= ROOT_MAX) {
				root = rootEntries; rootBytes = rb;
				leaves = new Uint8Array(off); let p = 0; for (const l of parts) { leaves.set(l, p); p += l.length; }
				break;
			}
		}
	}
	// 3) メタ・ヘッダ
	const metaBytes = await compress(new TextEncoder().encode(JSON.stringify(metadata)), ic);
	const rootOff = 127, metaOff = rootOff + rootBytes.length, leafOff = metaOff + metaBytes.length, dataOff = leafOff + leaves.length;
	const header = new Uint8Array(127), dv = new DataView(header.buffer);
	header.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73], 0);   // "PMTiles"
	header[7] = 3;
	const u64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);
	u64(8, rootOff); u64(16, rootBytes.length); u64(24, metaOff); u64(32, metaBytes.length); u64(40, leafOff); u64(48, leaves.length); u64(56, dataOff); u64(64, dataLen);
	u64(72, entries.reduce((s, e) => s + e.runLength, 0)); u64(80, entries.length); u64(88, chunks.length);
	header[96] = 1;   // clustered（tileId 順に格納）
	header[97] = COMP[ic]; header[98] = COMP[tc]; header[99] = tileType;
	let zmin = 0, zmax = 0;
	if (opts.minZoom === undefined || opts.maxZoom === undefined) { zmin = 30; for (const it of items) { const z = tileIdToZxy(it.id)[0]; if (z < zmin) zmin = z; if (z > zmax) zmax = z; } if (!items.length) zmin = 0; }
	header[100] = opts.minZoom ?? zmin;
	header[101] = opts.maxZoom ?? zmax;
	const b = opts.bounds ?? [-180, -85.051129, 180, 85.051129];
	const e7 = (v) => Math.round(v * 1e7);
	dv.setInt32(102, e7(b[0]), true); dv.setInt32(106, e7(b[1]), true); dv.setInt32(110, e7(b[2]), true); dv.setInt32(114, e7(b[3]), true);
	const c = opts.center ?? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, header[100]];
	header[118] = c[2]; dv.setInt32(119, e7(c[0]), true); dv.setInt32(123, e7(c[1]), true);
	// 4) 連結
	const out = new Uint8Array(dataOff + dataLen);
	out.set(header, 0); out.set(rootBytes, rootOff); out.set(metaBytes, metaOff); out.set(leaves, leafOff);
	let p = dataOff; for (const ch of chunks) { out.set(ch, p); p += ch.length; }
	return out;
}

// ── 検定用リーダ（同期・全量メモリ） ──
export async function readPMTiles(u8) {
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (String.fromCharCode(...u8.subarray(0, 7)) !== "PMTiles" || u8[7] !== 3) throw new Error("not PMTiles v3");
	const g = (o) => Number(dv.getBigUint64(o, true));
	const h = { rootOff: g(8), rootLen: g(16), metaOff: g(24), metaLen: g(32), leafOff: g(40), leafLen: g(48), dataOff: g(56), dataLen: g(64),
		addressed: g(72), entries: g(80), contents: g(88), clustered: u8[96], ic: u8[97], tc: u8[98], tileType: u8[99], minZoom: u8[100], maxZoom: u8[101],
		bounds: [dv.getInt32(102, true) / 1e7, dv.getInt32(106, true) / 1e7, dv.getInt32(110, true) / 1e7, dv.getInt32(114, true) / 1e7],
		center: [dv.getInt32(119, true) / 1e7, dv.getInt32(123, true) / 1e7, u8[118]] };
	const root = deserializeDirectory(await decompress(u8.subarray(h.rootOff, h.rootOff + h.rootLen), h.ic));
	const metadata = JSON.parse(new TextDecoder().decode(await decompress(u8.subarray(h.metaOff, h.metaOff + h.metaLen), h.ic)));
	const find = (entries, id) => {
		let lo = 0, hi = entries.length - 1;
		while (lo <= hi) { const m = (lo + hi) >> 1; if (entries[m].tileId <= id) lo = m + 1; else hi = m - 1; }
		if (hi < 0) return null;
		const e = entries[hi];
		if (e.runLength === 0) return e;                       // leaf
		return id < e.tileId + e.runLength ? e : null;
	};
	const getTile = async (z, x, y) => {
		const id = zxyToTileId(z, x, y);
		let e = find(root, id);
		if (e && e.runLength === 0) { const leaf = deserializeDirectory(await decompress(u8.subarray(h.leafOff + e.offset, h.leafOff + e.offset + e.length), h.ic)); e = find(leaf, id); if (e && e.runLength === 0) return null; }
		if (!e) return null;
		return decompress(u8.subarray(h.dataOff + e.offset, h.dataOff + e.offset + e.length), h.tc);
	};
	return { header: h, root, metadata, getTile };
}
