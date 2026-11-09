// LevelDB を「ログだけ」で書く（統合版のワールドの db/・docs/notes/minecraft.md §5.3）。
//   CURRENT → MANIFEST-000002（比較器・ログの番号）＋ 000003.log（WriteBatch の列）。LevelDB は開く時にログを読み直して表に焼く＝
//   SSTable（圧縮・索引）を自前で書かなくてよい。統合版（Mojang の LevelDB）も同じ手順で開く。
import { inflateRawSync, inflateSync } from "node:zlib";

const BLOCK = 32768;
let CRC_T = null;
/** CRC32C（Castagnoli） */
export function crc32c(bytes, crc = 0) {
	if (!CRC_T) { CRC_T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
	crc = ~crc >>> 0;
	for (let i = 0; i < bytes.length; i++) crc = CRC_T[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
	return ~crc >>> 0;
}
const mask = (c) => ((((c >>> 15) | (c << 17)) >>> 0) + 0xa282ead8) >>> 0;

/** ログの書式（32 KiB の区画に記録を割る） */
export class LogWriter {
	constructor() { this.parts = []; this.off = 0; }
	add(data) {
		let p = 0, first = true;
		do {
			const left = BLOCK - this.off;
			if (left < 7) { if (left) this.parts.push(new Uint8Array(left)); this.off = 0; continue; }
			const n = Math.min(data.length - p, left - 7), end = p + n === data.length;
			const type = first && end ? 1 : first ? 2 : end ? 4 : 3;
			const rec = new Uint8Array(7 + n), dv = new DataView(rec.buffer);
			rec[6] = type; rec.set(data.subarray(p, p + n), 7);
			dv.setUint32(0, mask(crc32c(rec.subarray(6))), true); dv.setUint16(4, n, true);
			this.parts.push(rec); this.off += 7 + n; p += n; first = false;
			if (end) break;
		} while (true);
	}
	bytes() { return Buffer.concat(this.parts); }
}

const varint = (v, out) => { while (v > 127) { out.push((v & 127) | 128); v = Math.floor(v / 128); } out.push(v); };

/** WriteBatch：entries＝[[key, value]]・seq＝最初の番号 */
export function writeBatch(entries, seq) {
	let size = 12; for (const [k, v] of entries) size += 1 + 5 + k.length + 5 + v.length;
	const b = new Uint8Array(size), dv = new DataView(b.buffer); let o = 12;
	dv.setBigUint64(0, BigInt(seq), true); dv.setUint32(8, entries.length, true);
	const tmp = [];
	for (const [k, v] of entries) {
		b[o++] = 1;
		tmp.length = 0; varint(k.length, tmp); b.set(tmp, o); o += tmp.length; b.set(k, o); o += k.length;
		tmp.length = 0; varint(v.length, tmp); b.set(tmp, o); o += tmp.length; b.set(v, o); o += v.length;
	}
	return b.subarray(0, o);
}

/** db フォルダの中身：[{ name, bytes }]。entries＝[[key, value]]（Uint8Array） */
export function levelDbFiles(entries, { batchBytes = 1 << 20 } = {}) {
	const log = new LogWriter(); let seq = 1, batch = [], size = 0;
	const flush = () => { if (!batch.length) return; log.add(writeBatch(batch, seq)); seq += batch.length; batch = []; size = 0; };
	for (const e of entries) { batch.push(e); size += e[0].length + e[1].length; if (size >= batchBytes) flush(); }
	flush();
	const edit = [], name = new TextEncoder().encode("leveldb.BytewiseComparator");
	edit.push(1); varint(name.length, edit); edit.push(...name);
	edit.push(2); varint(3, edit);          // log number
	edit.push(9); varint(0, edit);          // prev log number
	edit.push(3); varint(4, edit);          // next file number
	edit.push(4); varint(seq - 1, edit);    // last sequence
	const man = new LogWriter(); man.add(Uint8Array.from(edit));
	return [
		{ name: "CURRENT", bytes: new TextEncoder().encode("MANIFEST-000002\n") },
		{ name: "MANIFEST-000002", bytes: man.bytes() },
		{ name: "000003.log", bytes: log.bytes() },
	];
}

// ── 読む（取り込み用）：ログ（*.log）と表（*.ldb / *.sst）を全部読み、鍵ごとに番号の一番新しい物を残す ──

const getVarint = (b, p) => { let x = 0, s = 0, c; do { c = b[p++]; x += (c & 127) * 2 ** s; s += 7; } while (c & 128); return [x, p]; };

function applyBatch(r, put) {
	const dv = new DataView(r.buffer, r.byteOffset, r.byteLength), seq = dv.getBigUint64(0, true), n = dv.getUint32(8, true); let p = 12;
	for (let i = 0; i < n; i++) {
		const type = r[p++]; let kl, vl; [kl, p] = getVarint(r, p); const k = r.subarray(p, p + kl); p += kl;
		if (type === 1) { [vl, p] = getVarint(r, p); put(k, seq + BigInt(i), r.subarray(p, p + vl)); p += vl; } else put(k, seq + BigInt(i), null);
	}
}
/** ログの記録を並べる */
export function readLogRecords(b) {
	const recs = []; let cur = [];
	for (let blk = 0; blk < b.length; blk += BLOCK) {
		let p = blk; const end = Math.min(b.length, blk + BLOCK);
		while (p + 7 <= end) {
			const len = b[p + 4] | (b[p + 5] << 8), type = b[p + 6];
			if (!type && !len) break;
			cur.push(b.subarray(p + 7, p + 7 + len));
			if (type === 1 || type === 4) { recs.push(cur.length === 1 ? cur[0] : new Uint8Array(Buffer.concat(cur))); cur = []; }
			p += 7 + len;
		}
	}
	return recs;
}
function readBlock(b, off, size) {
	const raw = b.subarray(off, off + size), type = b[off + size];
	return type === 0 ? raw : type === 4 ? new Uint8Array(inflateRawSync(raw)) : type === 2 ? new Uint8Array(inflateSync(raw)) : (() => { throw new Error(`leveldb: compression ${type} not supported`); })();
}
function* blockEntries(blk) {
	const dv = new DataView(blk.buffer, blk.byteOffset, blk.byteLength), nr = dv.getUint32(blk.length - 4, true), end = blk.length - 4 - nr * 4;
	let p = 0, key = new Uint8Array(0);
	while (p < end) {
		let sh, ns, vl; [sh, p] = getVarint(blk, p); [ns, p] = getVarint(blk, p); [vl, p] = getVarint(blk, p);
		const k = new Uint8Array(sh + ns); k.set(key.subarray(0, sh)); k.set(blk.subarray(p, p + ns), sh); p += ns; key = k;
		yield [k, blk.subarray(p, p + vl)]; p += vl;
	}
}
/** 表（SSTable）の [内部鍵, 値] */
export function* readTable(b) {
	const f = b.subarray(b.length - 48); let p = 0, x;
	[x, p] = getVarint(f, p); [x, p] = getVarint(f, p);   // metaindex
	let io, is; [io, p] = getVarint(f, p); [is, p] = getVarint(f, p);
	for (const [, h] of blockEntries(readBlock(b, io, is))) {
		let q = 0, o, s; [o, q] = getVarint(h, q); [s, q] = getVarint(h, q);
		yield* blockEntries(readBlock(b, o, s));
	}
}
/** db フォルダ（[{ name, bytes }]）→ Map（鍵の hex → 値） */
export function readLevelDb(files) {
	const best = new Map();
	const put = (k, seq, v) => { const h = Buffer.from(k).toString("hex"), o = best.get(h); if (!o || o.seq < seq) best.set(h, { seq, v }); };
	for (const f of files) {
		if (/\.(ldb|sst)$/.test(f.name)) for (const [ik, v] of readTable(f.bytes)) {
			const t = new DataView(ik.buffer, ik.byteOffset + ik.length - 8, 8).getBigUint64(0, true);
			put(ik.subarray(0, ik.length - 8), t >> 8n, (t & 255n) === 1n ? v : null);
		}
		else if (/\.log$/.test(f.name)) for (const r of readLogRecords(f.bytes)) applyBatch(r, put);
	}
	const out = new Map(); for (const [h, { v }] of best) if (v) out.set(h, v); return out;
}
