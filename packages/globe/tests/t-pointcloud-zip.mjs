// ZIP に包まれた LAS/LAZ（src/pointcloud-zip.js・静岡県の配布物の形・2026-10-18）の検定。node packages/globe/tests/t-pointcloud-zip.mjs
//  ① 中央ディレクトリ・局所ヘッダを読む（deflate・格納・ZIP64 の大きさ）
//  ② 解いた中身が元と同じ・進み具合が総長まで届く・範囲読みは項の生のバイトだけ（ZIP 全体を取らない）
//  ③ 点の数を見て、取り終える前に断る
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { openSource } from "geopbf/cog/source";
import { isZip, parseEOCD, parseCentralDirectory, pickPointEntry, parseLocalEntry, localDataOffset, lasPointCount, unzipPointCloud } from "../src/pointcloud-zip.ts";

let tn = 0;
const t = async (name, fn) => { await fn(); tn++; console.log("  ✔", name); };
// LAS 1.4 の頭（375 B）＋点の記録の代わりの模様
function fakeLas(count, body = 200000) {
	const b = new Uint8Array(375 + body), dv = new DataView(b.buffer);
	b.set([0x4c, 0x41, 0x53, 0x46]); b[24] = 1; b[25] = 4; dv.setUint16(94, 375, true); dv.setUint32(96, 375, true);
	dv.setBigUint64(247, BigInt(count), true);   // 1.4 の 64bit の欄（32bit の欄は 0＝1.4 の書き手の作法）
	for (let i = 375, x = 7; i < b.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; b[i] = x >>> 24; }   // 縮まない中身（deflate でも束が何本にもなる）
	return b;
}
// ZIP を作る（項＝[名前, 中身, 方式]）。zip64＝中央ディレクトリの大きさの欄を 0xffffffff にして拡張で持つ
function makeZip(items, { zip64 = false } = {}) {
	const locals = [], cds = []; let off = 0;
	for (const [name, data, method] of items) {
		const nm = new TextEncoder().encode(name), comp = method === 8 ? new Uint8Array(zlib.deflateRawSync(data)) : data;
		const lh = new Uint8Array(30 + nm.length), lv = new DataView(lh.buffer);
		lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, method, true); lv.setUint32(18, comp.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nm.length, true); lh.set(nm, 30);
		const ext = zip64 ? 28 : 0, ch = new Uint8Array(46 + nm.length + ext), cv = new DataView(ch.buffer);
		cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, method, true); cv.setUint16(28, nm.length, true); cv.setUint16(30, ext, true); ch.set(nm, 46);
		if (zip64) {
			cv.setUint32(20, 0xffffffff, true); cv.setUint32(24, 0xffffffff, true); cv.setUint32(42, 0xffffffff, true);
			const e = 46 + nm.length; cv.setUint16(e, 1, true); cv.setUint16(e + 2, 24, true); cv.setBigUint64(e + 4, BigInt(data.length), true); cv.setBigUint64(e + 12, BigInt(comp.length), true); cv.setBigUint64(e + 20, BigInt(off), true);
		} else { cv.setUint32(20, comp.length, true); cv.setUint32(24, data.length, true); cv.setUint32(42, off, true); }
		locals.push(lh, comp); cds.push(ch); off += lh.length + comp.length;
	}
	const cdSize = cds.reduce((a, c) => a + c.length, 0), eo = new Uint8Array(22), ev = new DataView(eo.buffer);
	ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, items.length, true); ev.setUint16(10, items.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
	const parts = [...locals, ...cds, eo], out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
	for (const p of parts) { out.set(p, o); o += p.length; }
	return out;
}
// 範囲読みを数える源（URL の代わり）
function counted(bytes) {
	const reads = [];
	return { reads, src: { size: bytes.length, read: async (from, len) => { reads.push([from, len]); return bytes.slice(from, from + len); } } };
}

const las = fakeLas(1234567);
await t("① 中央ディレクトリ・局所ヘッダ・点の項の選び（説明書きの .txt は飛ばす）", async () => {
	const z = makeZip([["readme.txt", new TextEncoder().encode("hello"), 0], ["08MC4919.las", las, 8]]);
	assert.ok(isZip(z));
	const loc = parseEOCD(z.subarray(z.length - 22), z.length - 22);
	const es = parseCentralDirectory(z.subarray(loc.offset, loc.offset + loc.size));
	assert.equal(es.length, 2);
	const e = pickPointEntry(es);
	assert.equal(e.name, "08MC4919.las"); assert.equal(e.method, 8); assert.equal(e.usize, las.length);
	assert.equal(localDataOffset(z.subarray(e.localOffset)), 30 + "08MC4919.las".length);
	assert.equal(lasPointCount(las.subarray(0, 375)), 1234567);
	assert.equal(lasPointCount(new Uint8Array(10)), null);
	assert.equal(pickPointEntry([{ name: "__MACOSX/._a.las" }, { name: "a.LAZ" }]).name, "a.LAZ");
});
await t("① ZIP64 の大きさの拡張", async () => {
	const z = makeZip([["x.laz", las, 0]], { zip64: true });
	const loc = parseEOCD(z.subarray(z.length - 22), z.length - 22), [e] = parseCentralDirectory(z.subarray(loc.offset, loc.offset + loc.size));
	assert.equal(e.usize, las.length); assert.equal(e.csize, las.length); assert.equal(e.localOffset, 0);
});
for (const method of [8, 0]) await t(`② 解く（方式 ${method}）＝元と同じ・進み具合・項の外は読まない`, async () => {
	const z = makeZip([["readme.txt", new TextEncoder().encode("x".repeat(5000)), 0], ["a.las", las, method]]);
	const { reads, src } = counted(z);
	const prog = [];
	const { blob, name } = await unzipPointCloud(await openSource(src, { headerBytes: 64 }), { chunk: 16384, onProgress: (a, b) => prog.push([a, b]) });
	assert.equal(name, "a.las");
	assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), las);
	const total = prog.at(-1)[1]; assert.equal(prog.at(-1)[0], total); assert.ok(prog.length > 2, JSON.stringify(prog) + JSON.stringify(reads));
	const big = reads.filter(([, len]) => len === 16384);   // 束の読み＝説明書き（0〜5 KB 余り）に掛からない
	assert.ok(big.length >= 2 && big.every(([from]) => from > 5000));
});
await t("② 総長の分からない URL（S3 は Content-Range を CORS で見せない）＝先頭の局所ヘッダから・末尾は読まない", async () => {
	const z = makeZip([["08MC7659.las", las, 8], ["readme.txt", new TextEncoder().encode("x"), 0]]);
	const e = parseLocalEntry(z.subarray(0, 64));
	assert.equal(e.entry.name, "08MC7659.las"); assert.equal(e.dataOffset, 30 + 12);
	assert.equal(parseLocalEntry(makeZip([["a.txt", las, 0], ["b.las", las, 0]]).subarray(0, 64)), null);   // 先頭が点群でない＝中央ディレクトリへ
	const { reads, src } = counted(z);
	const s = await openSource(src, { headerBytes: 64 }); s.size = null;
	const { blob } = await unzipPointCloud(s, { chunk: 65536 });
	assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), las);
	assert.ok(reads.every(([from, len]) => from + len <= z.length - 22 - 40), "no tail read");
	const s2 = await openSource(counted(makeZip([["a.txt", las, 0], ["b.las", las, 0]])).src, { headerBytes: 64 }); s2.size = null;
	await assert.rejects(unzipPointCloud(s2), /did not report the ZIP size/);
});
await t("③ 点の数の上限＝取り終える前に断る", async () => {
	const z = makeZip([["big.las", fakeLas(30e6, 400000), 8]]);
	const { reads, src } = counted(z);
	await assert.rejects(unzipPointCloud(await openSource(src, { headerBytes: 64 }), { chunk: 4096, check: n => n > 20e6 ? `too many: ${n}` : null }), /too many: 30000000/);
	const got = reads.filter(([, len]) => len === 4096).length;
	assert.ok(got < Math.ceil(z.length / 4096) - 2, `read ${got} chunks`);
});
await t("壊れた ZIP・点群の無い ZIP は理由つきで断る", async () => {
	await assert.rejects(unzipPointCloud(await openSource(new Blob([new Uint8Array(100)]))), /no end of central directory/);
	await assert.rejects(unzipPointCloud(await openSource(new Blob([makeZip([["a.txt", new Uint8Array(3), 0]])]))), /no \.las or \.laz/);
});
console.log(`t-pointcloud-zip: ${tn} 件 OK`);
