// LAZ の解読（laz.ts の decodeLazChunk＝COPC の節）と LAS の記録の読み（las.ts の readRecords／readRecordsRaw）の node の計り。
// 使い方：node packages/tile-formats/scripts/bench-laz.mjs [--runs N] [--hash] [--src <laz.ts のパス>]
//   見本＝globe/tests/fixtures/copc/ellipsoid.copc.laz（10 万点・形式 7）の節を全部。--hash＝出力の FNV 指紋＝最適化の前後でビット同値を確かめる
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLazPerf } from "laz-perf";
import { parseHeader, listVlrs, parseCopcInfo, parseHierarchyPage, readRecords, readRecordsRaw } from "../src/las.ts";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const runs = +(args[args.indexOf("--runs") + 1] || 0) || 10, wantHash = args.includes("--hash");
const src = args.includes("--src") ? path.resolve(args[args.indexOf("--src") + 1]) : path.join(DIR, "../src/laz.ts");
const { decodeLazChunk } = await import(pathToFileURL(src).href);

const buf = new Uint8Array(readFileSync(path.join(DIR, "../../globe/tests/fixtures/copc/ellipsoid.copc.laz")));
const lp = await createLazPerf();
const hdr = parseHeader(buf), vlrs = listVlrs(buf, hdr.headerSize, hdr.vlrCount);
const info = parseCopcInfo(buf, vlrs.find(v => v.userId === "copc" && v.recordId === 1).offset);
const nodes = [], pages = [parseHierarchyPage(buf.subarray(info.rootHierOffset, info.rootHierOffset + info.rootHierSize))];
while (pages.length) { const p = pages.pop(); for (const q of p.pages) pages.push(parseHierarchyPage(buf.subarray(q.offset, q.offset + q.byteSize))); for (const nd of p.nodes) if (nd.pointCount > 0) nodes.push(nd); }
const total = nodes.reduce((a, nd) => a + nd.pointCount, 0);

const fnv = (h, b) => { const u = new Uint8Array(b.buffer, b.byteOffset, b.byteLength); for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } return h; };
const ms = t => Number(process.hrtime.bigint() - t) / 1e6, med = a => a.sort((p, q) => p - q)[a.length >> 1];
const decAll = () => nodes.map(nd => decodeLazChunk(lp, buf.subarray(nd.offset, nd.offset + nd.byteSize), { format: hdr.format, recordLength: hdr.recordLength, count: nd.pointCount }));
let recs = decAll();
const tDec = [], tRead = [], tRaw = [];
for (let r = 0; r < runs; r++) {
	let t0 = process.hrtime.bigint(); recs = decAll(); tDec.push(ms(t0));
	t0 = process.hrtime.bigint(); recs.forEach((rec, i) => readRecords(rec, nodes[i].pointCount, hdr)); tRead.push(ms(t0));
	t0 = process.hrtime.bigint(); recs.forEach((rec, i) => readRecordsRaw(rec, nodes[i].pointCount, hdr, {})); tRaw.push(ms(t0));
}
let h = 2166136261;
if (wantHash) recs.forEach((rec, i) => { h = fnv(h, rec); const r = readRecords(rec, nodes[i].pointCount, hdr); for (const k of Object.keys(r).sort()) if (ArrayBuffer.isView(r[k])) h = fnv(h, r[k]); });
console.log(`copc ellipsoid: nodes=${nodes.length} points=${total}  decodeLazChunk ${med(tDec).toFixed(1)}ms  readRecords ${med(tRead).toFixed(1)}ms  readRecordsRaw ${med(tRaw).toFixed(1)}ms  (all nodes, median of ${runs})${wantHash ? `  hash ${h.toString(16)}` : ""}`);
