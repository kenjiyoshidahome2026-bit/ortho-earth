// LAZ の解読器（src/laz.js・src/pointcloud.js・#178）の検定。node packages/tile-formats/tests/t-laz.mjs
//  ① globe の COPC 試料（ellipsoid.copc.laz・10 万点・形式 7）の節を全部解く＝点の数が合う・位置がヘッダの範囲の内・RGB が入っている
//  ② 差し込み口の形（POINTCLOUD_FORMATS.laz＝関数・呼ぶまで laz-perf を読まない）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLazPerf } from "laz-perf";
import { decodeLazChunk } from "../src/laz.js";
import { POINTCLOUD_FORMATS } from "../src/pointcloud.js";
import { parseHeader, listVlrs, parseCopcInfo, parseHierarchyPage, readRecords } from "../../globe/src/copc-format.js";   // COPC の形を読む（globe の純関数）

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

await t("差し込み口の形＝{ laz: () => Promise<decode> }", () => {
	assert.deepEqual(Object.keys(POINTCLOUD_FORMATS), ["laz"]);
	assert.equal(typeof POINTCLOUD_FORMATS.laz, "function");
});

console.log(`\n全 ${n} 件通過`);
