#!/usr/bin/env node
// t-parquet-range: GeoParquet の部分読み（openParquet の src＝{read,size} / url / Blob）。
//   ・footer だけで開く（読むバイト＝末尾 64KB 以下）・列統計（bbox 覆域列の min/max）・select({bbox}) が視野の row group だけ返す
//   ・readRowGroup(g, {columns}) は指定列のチャンクだけ読む（バイト数が全列より少ない）・値は全量読み（readParquet）と一致
//   ・url：Range 対応（206）→ 部分読み・非対応（200）→ 全量モードへ自動で落ちる。fromGeoParquet(url) も同じ道で動く
//   ・空間整列（str）した書き手のファイルでは、遠い視野の row group が 0 になる
globalThis.ImageData ??= class ImageData { };
import { createServer } from "node:http";
import { GeoPBF } from "../src/pbf-base.js";
import { toGeoParquet, fromGeoParquet } from "../src/convert/geoparquet.js";
import { openParquet, readParquet } from "../src/parquet.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// ── 器：2 つの塊（東京近郊 / 欧州）に 8,000 点＋少しの面（≈ 500KB＝末尾 64KB の footer 読みが数字で見える大きさ）──
const feats = [];
let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
for (let i = 0; i < 4000; i++) feats.push({ type: "Feature", properties: { id: i, k: "jp", v: rnd() * 100 }, geometry: { type: "Point", coordinates: [139 + rnd() * 2, 35 + rnd() * 1.5] } });
for (let i = 0; i < 4000; i++) feats.push({ type: "Feature", properties: { id: 4000 + i, k: "eu", v: rnd() * 100 }, geometry: { type: "Point", coordinates: [5 + rnd() * 10, 45 + rnd() * 8] } });
const sq = (x0, y0, d) => [[x0, y0], [x0 + d, y0], [x0 + d, y0 + d], [x0, y0 + d], [x0, y0]];
for (let i = 0; i < 40; i++) feats.push({ type: "Feature", properties: { id: 8000 + i, k: i < 20 ? "jp" : "eu", v: i }, geometry: { type: "Polygon", coordinates: [sq(i < 20 ? 139 + rnd() * 2 : 5 + rnd() * 10, i < 20 ? 35 + rnd() : 45 + rnd() * 8, 0.05)] } });
const pbf = await new GeoPBF({ name: "fix", precision: 6 }).set({ type: "FeatureCollection", features: feats });
const N = pbf.length;
const { buffer: u8 } = await toGeoParquet(pbf, { gpu: false, order: "str", rowGroupSize: 128, codec: "gzip" });
ok(u8.length > 200000, `fixture: ${N} features → GeoParquet ${u8.length} B（str 整列・row group 128 行・gzip）`);

// ── {read,size}＝バイト数を数える手元ソース ──
const counting = () => { const st = { bytes: 0, calls: 0 }; return { st, src: { size: u8.length, read: async (from, len) => { st.bytes += len; st.calls++; return u8.subarray(from, from + len); } } }; };
{
	const { st, src } = counting();
	const pq = await openParquet(src);
	ok(pq.numRows === N && pq.rowGroups.length === Math.ceil(N / 128), `footer: ${pq.numRows} 行・row group ${pq.rowGroups.length}`);
	ok(st.bytes <= 65536 && st.bytes < u8.length / 2, `footer だけで開く（読んだ ${st.bytes} B / 全 ${u8.length} B）`);
	ok(pq.geometry?.name === "geometry" && pq.geometry.covering?.xmin === "bbox.xmin", "geo メタ: 幾何列と covering");
	const rg0 = pq.rowGroups[0];
	ok(typeof rg0.stats["bbox.xmin"]?.min === "number" && typeof rg0.stats["bbox.xmax"]?.max === "number" && rg0.bytes > 0, `row group 統計: xmin.min=${rg0.stats["bbox.xmin"]?.min?.toFixed(3)} xmax.max=${rg0.stats["bbox.xmax"]?.max?.toFixed(3)} bytes=${rg0.bytes}`);

	// select：東京近郊だけ／欧州だけ／全球
	const jp = pq.select({ bbox: [138.5, 34.5, 141.5, 37] }), eu = pq.select({ bbox: [4, 44, 16, 54] }), all = pq.select({ bbox: [-180, -90, 180, 90] }), none = pq.select({ bbox: [-100, -50, -90, -40] });
	ok(jp.pruned && jp.groups.length > 0 && jp.groups.length < pq.rowGroups.length, `select(東京): ${jp.groups.length}/${pq.rowGroups.length} row group`);
	const both = eu.groups.filter(g => jp.groups.includes(g)).length;   // STR は行数が平方数でない端で 1〜2 個の row group が両地域にまたがる
	ok(eu.pruned && eu.groups.length > 0 && eu.groups.length < pq.rowGroups.length && both <= 2, `select(欧州): ${eu.groups.length}（東京と共通 ${both} 個以下＝str 整列の効き目）`);
	ok(all.groups.length === pq.rowGroups.length && none.groups.length === 0, "select(全球)=全部・select(大西洋)=0");
	// 東京の row group を全部読むと jp の地物が全部入っている
	const bytes0 = st.bytes;
	let jpRows = 0, jpSeen = 0;
	for (const g of jp.groups) { const m = await pq.readRowGroup(g, { columns: ["k"] }); const k = m.get("k"); jpRows += k.length; jpSeen += k.filter(x => x === "jp").length; }
	ok(jpSeen === 4020 && jpRows < N * 0.7, `東京の row group に jp 地物 ${jpSeen}/4020 が全部（読んだ行 ${jpRows} < ${N}）`);
	ok(st.bytes - bytes0 < u8.length / 4, `列 1 本（k）だけ＝${st.bytes - bytes0} B`);
	// 列を絞ると読むバイトが減る
	const b1 = st.bytes; await pq.readRowGroup(0, { columns: ["geometry"] }); const geomBytes = st.bytes - b1;
	const b2 = st.bytes; await pq.readRowGroup(0); const allBytes = st.bytes - b2;
	ok(geomBytes < allBytes, `readRowGroup(0, {columns:[geometry]}) ${geomBytes} B < 全列 ${allBytes} B`);
}

// ── 値の一致：部分読み（row group を順に）＝全量読み（readParquet） ──
{
	const full = await readParquet(u8);
	const pq = await openParquet(counting().src);
	const col = name => full.columns.find(c => c.name === name).values;
	let row0 = 0, same = true;
	for (let g = 0; g < pq.rowGroups.length; g++) {
		const m = await pq.readRowGroup(g, { columns: ["id", "v", "k"] });
		const id = m.get("id"), v = m.get("v"), k = m.get("k");
		for (let i = 0; i < id.length; i++) { if (id[i] !== col("id")[row0 + i] || v[i] !== col("v")[row0 + i] || k[i] !== col("k")[row0 + i]) same = false; }
		row0 += id.length;
	}
	ok(same && row0 === N, "部分読みの値＝全量読みの値（id/v/k・全 row group）");
}

// ── url：Range 対応（206）と非対応（200） ──
const serve = (range) => new Promise(res => {
	const srv = createServer((req, r) => {
		const h = req.headers.range;
		if (range && h) {
			let a, b; const m = /bytes=(\d*)-(\d*)/.exec(h);
			if (m[1] === "") { b = u8.length - 1; a = Math.max(0, u8.length - +m[2]); } else { a = +m[1]; b = m[2] === "" ? u8.length - 1 : Math.min(+m[2], u8.length - 1); }
			r.writeHead(206, { "Content-Type": "application/octet-stream", "Content-Range": `bytes ${a}-${b}/${u8.length}`, "Content-Length": b - a + 1, ETag: '"fix"' });
			r.end(Buffer.from(u8.subarray(a, b + 1)));
		} else { r.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": u8.length, ETag: '"fix"' }); r.end(Buffer.from(u8)); }
	}).listen(0, () => res({ srv, url: `http://127.0.0.1:${srv.address().port}/fix.parquet` }));
});
{
	const { srv, url } = await serve(true);
	const pq = await openParquet(url);
	ok(!pq.source.wholeFile && pq.source.metrics.rangeRequests === 2 && pq.source.metrics.bytesFetched <= 65537, `url(206): 0-0 で総長→末尾の 2 本 ${pq.source.metrics.bytesFetched} B で開く（suffix range は CORS preflight を招くので使わない）`);
	const jp = pq.select({ bbox: [138.5, 34.5, 141.5, 37] });
	const before = pq.source.metrics.bytesFetched;
	for (const g of jp.groups) await pq.readRowGroup(g, { columns: ["geometry", "id"] });
	ok(pq.source.metrics.bytesFetched - before < u8.length / 2 && pq.source.metrics.rangeRequests > 1, `url(206): 東京 ${jp.groups.length} row group＝${pq.source.metrics.bytesFetched - before} B（Range ${pq.source.metrics.rangeRequests} 本・合体元 ${pq.source.metrics.coalescedFrom}）`);
	const r = await fromGeoParquet(url);
	ok(r.stats.features === N, `fromGeoParquet(url) も同じ道＝${r.stats.features} 地物`);
	srv.close();
}
{
	const { srv, url } = await serve(false);
	const pq = await openParquet(url);
	ok(pq.source.wholeFile && pq.numRows === N, `url(200・Range 非対応): 全量モードへ落ちて開ける（${pq.source.metrics.bytesFetched} B）`);
	const m = await pq.readRowGroup(0, { columns: ["id"] });
	ok(m.get("id").length === pq.rowGroups[0].numRows, "全量モードでも readRowGroup が読める");
	srv.close();
}
// ── Blob（File ドロップの形） ──
if (typeof Blob !== "undefined") {
	const pq = await openParquet(new Blob([u8]));
	ok(pq.numRows === N && (await pq.readRowGroup(1, { columns: ["k"] })).get("k").length === pq.rowGroups[1].numRows, "Blob からも部分読み");
}
// ── 互換：Uint8Array の全量読み ──
{
	const pq = await openParquet(u8);
	ok(pq.source.inMemory && pq.numRows === N && pq.select({ bbox: [4, 44, 16, 54] }).pruned, "Uint8Array（手元）でも同じ API・統計も出る");
}

console.log(fails ? `\n${fails} FAILED` : "\nall ok");
process.exit(fails ? 1 : 0);
