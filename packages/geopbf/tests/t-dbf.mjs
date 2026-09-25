// t-dbf: Shapefile の DBF の空欄と日付（B8・2026-09-25）。decoder/shape.js・encoder/shape.js の worker を Node で直に回す。
// 守るもの：空白の N 欄・D 欄と "00000000" は null（0 や 1970-01-01 にしない）／書き出しの月がずれない／null の値で書き出しが落ちない
globalThis.ImageData ??= class ImageData {};
import { GeoPBF } from "../src/pbf.js";
import { encodeZIP } from "../src/modules/encodeZIP.js";
import { fileURLToPath } from "node:url";
let fails = 0;
const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
let seq = 0;
async function runWorker(path, data) {
  globalThis.onmessage = null;
  const got = new Promise(r => { globalThis.postMessage = m => r(m); });
  await import(path + "?v=" + (++seq));
  globalThis.onmessage({ data });
  return got;
}
const S = fileURLToPath(new URL("../src", import.meta.url));
const quiet = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
// (A) 手組み DBF：N 欄と D 欄が空白（GDAL/QGIS が NULL を書く流儀）
function shpPoints(n) {
  const total = 100 + n * 28, out = new Uint8Array(total), h = new DataView(out.buffer);
  h.setInt32(0, 9994, false); h.setInt32(24, total / 2, false); h.setInt32(28, 1000, true); h.setInt32(32, 1, true);
  for (let i = 0; i < n; i++) { const p = 100 + i * 28; h.setInt32(p, i + 1, false); h.setInt32(p + 4, 10, false); h.setInt32(p + 8, 1, true); h.setFloat64(p + 12, 139 + i, true); h.setFloat64(p + 20, 35, true); }
  return out;
}
function dbf(rows) {   // fields: ID C4, NUM N6, DT D8
  const F = [["ID", "C", 4], ["NUM", "N", 6], ["DT", "D", 8]];
  const rec = 1 + F.reduce((s, f) => s + f[2], 0), head = 32 + 32 * F.length + 1;
  const out = new Uint8Array(head + rec * rows.length + 1), d = new DataView(out.buffer);
  out[0] = 3; d.setUint32(4, rows.length, true); d.setUint16(8, head, true); d.setUint16(10, rec, true);
  F.forEach(([nm, t, l], k) => { out.set(new TextEncoder().encode(nm), 32 + 32 * k); out[32 + 32 * k + 11] = t.charCodeAt(0); out[32 + 32 * k + 16] = l; });
  out[head - 1] = 0x0d;
  rows.forEach((r, i) => { let o = head + i * rec; out[o++] = 0x20; F.forEach(([, , l], k) => { out.set(new TextEncoder().encode(r[k].padEnd(l).slice(0, l)), o); o += l; }); });
  out[out.length - 1] = 0x1a; return out;
}
const rows = [["a", "    12", "20240315"], ["b", "      ", "        "], ["c", "     0", "00000000"]];
const zip = await encodeZIP([new File([shpPoints(3)], "t.shp"), new File([dbf(rows)], "t.dbf"), new File(["UTF-8"], "t.cpg")], "t.zip");
const r = await quiet(() => runWorker(S + "/decoder/shape.js", { file: zip, name: "t", precision: 6, encoding: "utf8" }));
const p = await new GeoPBF().set(r.data);
const A = [0, 1, 2].map(i => p.getProperties(i));
ok(A[0].NUM === 12 && A[0].DT instanceof Date && A[0].DT.toISOString().startsWith("2024-03-15"), "値のある欄はそのまま（12・2024-03-15）");
ok(A[1].NUM == null && A[1].DT == null, "空白の N 欄・D 欄は null（旧＝0 と 1970-01-01）");
ok(A[2].NUM === 0 && A[2].DT == null, '"     0" は 0、"00000000" は null');
// (B) 書き出し：Date → DBF の D 欄
const fc = { type: "FeatureCollection", features: [
  { type: "Feature", properties: { id: "x", d: new Date("2024-03-15T00:00:00Z") }, geometry: { type: "Point", coordinates: [139, 35] } },
  { type: "Feature", properties: { id: "y", d: new Date("2024-01-10T00:00:00Z") }, geometry: { type: "Point", coordinates: [140, 35] } },
  { type: "Feature", properties: { id: "z", d: null }, geometry: { type: "Point", coordinates: [141, 35] } },
]};
const src = await new GeoPBF().set(structuredClone(fc));
const f = await quiet(() => runWorker(S + "/encoder/shape.js", { buf: src.arrayBuffer.slice(0), name: "o", opts: {} }));
const { decodeZIP } = await import(S + "/modules/decodeZIP.js");
const ents = await decodeZIP(f);
const db = new Uint8Array(await ents.find(e => /\.dbf$/.test(e.name)).arrayBuffer());
const hl = new DataView(db.buffer).getUint16(8, true), rl = new DataView(db.buffer).getUint16(10, true);
const recs = [0, 1, 2].map(i => new TextDecoder().decode(db.subarray(hl + i * rl, hl + (i + 1) * rl)));
ok(recs[0].includes("20240315") && recs[1].includes("20240110"), `書き出しの月がずれない（${JSON.stringify(recs.slice(0, 2))}）`);
const back = await quiet(() => runWorker(S + "/decoder/shape.js", { file: f, name: "o", precision: 6, encoding: "utf8" }));
const bp = await new GeoPBF().set(back.data);
const B = [0, 1, 2].map(i => bp.getProperties(i));
ok(B[0].d?.toISOString().startsWith("2024-03-15") && B[1].d?.toISOString().startsWith("2024-01-10") && B[2].id === "z" && B[2].d == null, "書き出し→読み戻しで日付が往復・null は null のまま");
console.log(fails ? `FAIL (${fails})` : "PASS"); process.exit(fails ? 1 : 0);
