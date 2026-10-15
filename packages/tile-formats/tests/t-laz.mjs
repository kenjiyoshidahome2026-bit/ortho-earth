// LAZ の解読器（src/laz.js・src/pointcloud.js・#178）の検定。node packages/tile-formats/tests/t-laz.mjs
//  ① globe の COPC 試料（ellipsoid.copc.laz・10 万点・形式 7）の節を全部解く＝点の数が合う・位置がヘッダの範囲の内・RGB が入っている
//  ③ LAS 1.2・形式 3（日本の配布物の形）のヘッダと点の記録・GeoTIFF キーの EPSG 番号（合成）
//  ② 差し込み口の形（POINTCLOUD_FORMATS.laz＝関数・呼ぶまで laz-perf を読まない）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLazPerf } from "laz-perf";
import { decodeLazChunk, decodeLazFile } from "../src/laz.ts";
import { POINTCLOUD_FORMATS, POINTCLOUD_NAMES } from "../src/pointcloud.ts";
import { parseHeader, listVlrs, parseCopcInfo, parseHierarchyPage, readRecords, readRecordsRaw, rgbMax, geoKeysEpsg, hasRgb } from "../src/las.ts";   // LAS/COPC の形を読む純関数

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ✔", name); };
const buf = new Uint8Array(readFileSync(fileURLToPath(new URL("../../globe/tests/fixtures/copc/ellipsoid.copc.laz", import.meta.url))));
const lp = await createLazPerf();

await t("COPC の節を全部解く（点の数・範囲・RGB）", () => {
	const hdr = parseHeader(buf), vlrs = listVlrs(buf, hdr.headerSize, hdr.vlrCount);
	const info = parseCopcInfo(buf, vlrs.find(v => v.userId === "copc" && v.recordId === 1).offset);
	const pages = [parseHierarchyPage(buf.subarray(info.rootHierOffset, info.rootHierOffset + info.rootHierSize))];
	let total = 0, nodes = 0, rgbMax = 0;
	while (pages.length) {
		const p = pages.pop();
		for (const q of p.pages) pages.push(parseHierarchyPage(buf.subarray(q.offset, q.offset + q.byteSize)));
		for (const nd of p.nodes) {
			const rec = decodeLazChunk(lp, buf.subarray(nd.offset, nd.offset + nd.byteSize), { format: hdr.format, recordLength: hdr.recordLength, count: nd.pointCount });
			assert.equal(rec.byteLength, nd.pointCount * hdr.recordLength);
			const r = readRecords(rec, nd.pointCount, hdr);
			for (let i = 0; i < nd.pointCount; i++) for (const [k, a] of [[0, r.x], [1, r.y], [2, r.z]]) {
				const eps = hdr.scale[k];
				assert.ok(a[i] >= hdr.min[k] - eps && a[i] <= hdr.max[k] + eps, `point ${i} axis ${k} ${a[i]} outside [${hdr.min[k]}, ${hdr.max[k]}]`);
			}
			for (const v of r.rgb) if (v > rgbMax) rgbMax = v;
			total += nd.pointCount; nodes++;
		}
	}
	assert.equal(hdr.format, 7);
	assert.equal(nodes, 5);
	assert.equal(total, hdr.pointCount);
	assert.equal(total, 100000);
	assert.ok(rgbMax > 0, "RGB decoded");
});

await t("LAS 1.2・形式 3 のヘッダと点の記録（合成）", () => {
	const L = 34, n = 2, h = new Uint8Array(227 + n * L), dv = new DataView(h.buffer);
	h.set([76, 65, 83, 70]); h[24] = 1; h[25] = 2;
	dv.setUint16(94, 227, true); dv.setUint32(96, 227, true); dv.setUint32(100, 0, true); h[104] = 3; dv.setUint16(105, L, true); dv.setUint32(107, n, true);
	[0.01, 0.01, 0.01].forEach((v, i) => dv.setFloat64(131 + i * 8, v, true)); [50000, -99000, 0].forEach((v, i) => dv.setFloat64(155 + i * 8, v, true));
	const pt = (i, x, y, z, it, cls, r, g, b) => { const o = 227 + i * L; dv.setInt32(o, x, true); dv.setInt32(o + 4, y, true); dv.setInt32(o + 8, z, true); dv.setUint16(o + 12, it, true); h[o + 15] = cls | 0x80; dv.setUint16(o + 28, r, true); dv.setUint16(o + 30, g, true); dv.setUint16(o + 32, b, true); };
	pt(0, 100, 200, 15000, 7, 2, 65280, 0, 256); pt(1, -100, 0, 300, 9, 6, 1, 2, 3);
	const hdr = parseHeader(h);
	assert.deepEqual(hdr.version, [1, 2]); assert.equal(hdr.format, 3); assert.equal(hdr.pointCount, 2); assert.equal(hdr.evlrCount, 0); assert.ok(hasRgb(3));
	const r = readRecords(h.subarray(227), n, hdr);
	assert.ok(Math.abs(r.x[0] - 50001) < 1e-9 && Math.abs(r.y[0] + 98998) < 1e-9 && Math.abs(r.z[0] - 150) < 1e-9);
	assert.deepEqual([...r.classification], [2, 6]);   // 下 5 bit（上の印は落とす）
	assert.deepEqual([...r.intensity], [7, 9]);
	assert.deepEqual([...r.rgb], [65280, 0, 256, 1, 2, 3]);
	assert.ok(!hasRgb(1) && hasRgb(2) && hasRgb(7) && !hasRgb(6));
});

await t("GeoTIFF キーの EPSG 番号（平面直角 VIII 系＋JGD2011 の標高）", () => {
	const keys = [[1, 1, 0, 4], [1024, 0, 1, 1], [3072, 0, 1, 6676], [3076, 0, 1, 9001], [4096, 0, 1, 6695]];
	const u = new Uint16Array(keys.flat());
	assert.deepEqual(geoKeysEpsg(new Uint8Array(u.buffer)), { horizontal: 6676, vertical: 6695 });
	const g = new Uint16Array([1, 1, 0, 1, 2048, 0, 1, 6668]);
	assert.deepEqual(geoKeysEpsg(new Uint8Array(g.buffer)), { horizontal: 6668, vertical: null });
	const user = new Uint16Array([1, 1, 0, 1, 3072, 0, 1, 32767]);
	assert.deepEqual(geoKeysEpsg(new Uint8Array(user.buffer)), { horizontal: null, vertical: null });
});

await t("LAZ を丸ごと解く（COPC の印を消した＝普通の LAZ 1.4）・記録のままの整数の列", () => {
	const plain = buf.slice(), hdr = parseHeader(plain), ci = listVlrs(plain, hdr.headerSize, hdr.vlrCount).find(v => v.userId === "copc");
	plain.set(new TextEncoder().encode("copx"), ci.offset - 54 + 2);   // userId を書き換える＝COPC の読み手からは普通の LAZ
	assert.ok(!listVlrs(plain, hdr.headerSize, hdr.vlrCount).some(v => v.userId === "copc"));
	let total = 0, batches = 0, first = null;
	const r = decodeLazFile(lp, plain, (rec, k) => { if (!first) first = rec.slice(0, 3 * hdr.recordLength); total += k; batches++; }, { batch: 30000 });
	assert.deepEqual(r, { count: 100000, recordLength: hdr.recordLength, format: 7 });
	assert.equal(total, 100000); assert.equal(batches, 4);
	const a = readRecords(first, 3, hdr), b = readRecordsRaw(first, 3, hdr, { shift: 8 });
	for (let i = 0; i < 3; i++) {
		assert.equal(b.X[i] * hdr.scale[0] + hdr.offset[0], a.x[i]); assert.equal(b.Z[i] * hdr.scale[2] + hdr.offset[2], a.z[i]);
		assert.equal(b.intensity[i], a.intensity[i]); assert.equal(b.classification[i], a.classification[i]); assert.equal(b.rgb[i * 3], a.rgb[i * 3] >> 8);
	}
	assert.equal(rgbMax(first, 3, hdr), Math.max(...a.rgb));
});

await t("差し込み口の形＝{ laz: () => Promise<decode>, lazFile }", () => {
	assert.deepEqual(Object.keys(POINTCLOUD_FORMATS), ["laz", "lazFile"]);
	assert.equal(typeof POINTCLOUD_FORMATS.laz, "function"); assert.equal(typeof POINTCLOUD_FORMATS.lazFile, "function");
	assert.deepEqual(POINTCLOUD_NAMES, ["laz"]);   // globe 本体は名前だけ読む（capabilities）
});

console.log(`\n全 ${n} 件通過`);
