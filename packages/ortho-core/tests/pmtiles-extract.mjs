// 大きな PMTiles から z8 矩形を切り出す（UNMAP オフライン版 M3・2026-11-14）の検定。
// 元＝葉の索引つき・gzip の索引・同じ中身の連続（runLength）・重複の中身を持つ合成アーカイブ。切り出した物を pmtiles.js で読んで中身を比べる。
// node packages/ortho-core/tests/pmtiles-extract.mjs
import { gzipSync } from "node:zlib";
import { PMTiles, zxyToTileId, tileIdToZxy } from "pmtiles";
import { tileZxy, listEntries, readTileAt, decompressTile, parseHeader, serializeHeader, serializeDir, deserializeDir, tileId, idRanges, worldRanges, splitZ8Rect, z8Around, z8OfBbox, z8Count, z8Bbox, z8Of, openExtractSource, planExtract, writeExtract, chunkPlan, trimPlan, maxZoomWithin, zoomOfId, archiveVersion } from "../src/pmtiles-extract.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };

// ── ID ──
{
	let same = true;
	for (const [z, x, y] of [[0, 0, 0], [3, 5, 2], [8, 200, 100], [12, 3000, 1500], [15, 30000, 12000]]) same &&= tileId(z, x, y) === zxyToTileId(z, x, y);
	ok("tileId＝pmtiles.js の zxyToTileId", same);
	// z8 の子孫は連続区間
	const r = idRanges({ x0: 200, x1: 200, y0: 100, y1: 100 }, 10, 10);
	const ids = []; for (let x = 800; x < 804; x++) for (let y = 400; y < 404; y++) ids.push(zxyToTileId(10, x, y));
	ok("z8 の 1 枚の z10 の子孫＝1 区間 16 枚", r.length === 1 && r[0][1] - r[0][0] === 16 && ids.every(i => i >= r[0][0] && i < r[0][1]));
	const anc = idRanges({ x0: 200, x1: 201, y0: 100, y1: 101 }, 5, 7);
	ok("z8 より粗い＝祖先（2×2 の矩形→ z7 は 1 枚・z5 も 1 枚）", anc.reduce((s, [a, b]) => s + b - a, 0) === 3);
	ok("zoomOfId", zoomOfId(zxyToTileId(9, 3, 4)) === 9 && zoomOfId(0) === 0 && zoomOfId(zxyToTileId(1, 1, 1)) === 1);
}
// ── 矩形 ──
{
	const r = z8Around(139.69, 35.68, 3); const [x, y] = z8Of(139.69, 35.68);
	ok("現在地の 3×3（東京）", r.x0 === x - 1 && r.x1 === x + 1 && r.y0 === y - 1 && r.y1 === y + 1 && z8Count(r) === 9);
	const f = z8Around(179.9, -17, 3);
	ok("日付変更線（フィジー）：x0 > x1・割ると 2 つ", f.x0 > f.x1 && splitZ8Rect(f).length === 2 && splitZ8Rect(f).every(p => p.x0 <= p.x1) && z8Count(f) === 9);
	const b = z8Bbox(splitZ8Rect(f)[0]);
	ok("割った東側の箱の東端＝180", Math.abs(b[2] - 180) < 1e-9);
	const pole = z8Around(0, 89, 5);
	ok("極の近く：y を 0 から 5 枚へずらす", pole.y0 === 0 && pole.y1 === 4);
	const bb = z8OfBbox(130, 30, 145, 40);
	ok("経緯度の箱→z8（外へ丸め）", z8Bbox(bb)[0] <= 130 && z8Bbox(bb)[2] >= 145 && z8Bbox(bb)[1] <= 30 && z8Bbox(bb)[3] >= 40 && z8Bbox(bb)[2] - 145 < 1.41);
	ok("跨ぐ箱→z8（x0 > x1）", z8OfBbox(170, -20, -170, -10).x0 > z8OfBbox(170, -20, -170, -10).x1);
}

// ── 合成の元 ──
// z0–4 全部・z5–11 は日本の箱とフィジーの日付変更線の両側。中身＝"z/x/y"。(x+y)%7==0 は同じ中身「海」（連続すれば runLength）
function tilesIn(w, s, e, n, z) {
	const N = 2 ** z, lx = l => Math.floor((l + 180) / 360 * N), ly = l => { const r = l * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N); };
	const out = []; for (let x = lx(w); x <= Math.min(N - 1, lx(e)); x++) for (let y = ly(n); y <= ly(s); y++) out.push([z, x, y]); return out;
}
const want = new Map();   // id → 中身（文字列）
for (let z = 0; z <= 11; z++) {
	const ts = z <= 4 ? Array.from({ length: 4 ** z }, (_, i) => tileIdToZxy(zxyToTileId(z, 0, 0) + i)) : [...tilesIn(130, 30, 145, 40, z), ...tilesIn(178, -20, 179.999, -15, z), ...tilesIn(-180, -20, -178, -15, z)];
	for (const [tz, x, y] of ts) want.set(zxyToTileId(tz, x, y), (x + y) % 7 === 0 ? "sea" : `${tz}/${x}/${y}`);
}
function buildSource() {
	const ids = [...want.keys()].sort((a, b) => a - b), enc = new TextEncoder();
	const blobs = new Map(), parts = []; let off = 0;
	const ents = [];
	for (const id of ids) {
		const c = want.get(id);
		let o = blobs.get(c); if (o == null) { const d = enc.encode(c.padEnd(40, ".")); o = { offset: off, length: d.length }; blobs.set(c, o); parts.push(d); off += d.length; }
		const l = ents[ents.length - 1];
		if (l && l.offset === o.offset && l.tileId + l.runLength === id) l.runLength++;
		else ents.push({ tileId: id, offset: o.offset, length: o.length, runLength: 1 });
	}
	const data = new Uint8Array(off); { let a = 0; for (const p of parts) { data.set(p, a); a += p.length; } }
	// 葉 300 項目ずつ（gzip）・根も gzip
	const leafParts = [], rootEs = []; let lo = 0;
	for (let i = 0; i < ents.length; i += 300) { const d = gzipSync(serializeDir(ents.slice(i, i + 300))); leafParts.push(d); rootEs.push({ tileId: ents[i].tileId, offset: lo, length: d.length, runLength: 0 }); lo += d.length; }
	const root = gzipSync(serializeDir(rootEs)), md = gzipSync(JSON.stringify({ name: "synthetic", vector_layers: [{ id: "x" }] }));
	const leaves = new Uint8Array(lo); { let a = 0; for (const p of leafParts) { leaves.set(p, a); a += p.length; } }
	const rootOff = 127, mdOff = rootOff + root.length, leafOff = mdOff + md.length, dataOff = leafOff + leaves.length;
	const h = { rootOffset: rootOff, rootLength: root.length, metadataOffset: mdOff, metadataLength: md.length, leafOffset: leafOff, leafLength: leaves.length, dataOffset: dataOff, dataLength: data.length,
		addressedTiles: ids.length, tileEntries: ents.length, tileContents: blobs.size, clustered: true, internalCompression: 2, tileCompression: 1, tileType: 1, minZoom: 0, maxZoom: 11, minLon: -180, minLat: -85, maxLon: 180, maxLat: 85, centerZoom: 0, centerLon: 0, centerLat: 0 };
	const out = new Uint8Array(dataOff + data.length);
	out.set(serializeHeader(h)); out.set(root, rootOff); out.set(md, mdOff); out.set(leaves, leafOff); out.set(data, dataOff);
	return { bytes: out, h, ents };
}
const SRC = buildSource();
ok("ヘッダの往復", JSON.stringify(parseHeader(serializeHeader(SRC.h))) === JSON.stringify(SRC.h));
ok("索引の往復（offset の続き＝0）", JSON.stringify(deserializeDir(serializeDir(SRC.ents))) === JSON.stringify(SRC.ents));
ok("元は葉を持つ（根は葉の指しだけ）", SRC.h.leafLength > 0 && SRC.ents.length > 600);

let reads = 0, readBytes = 0;
const rangeRead = async (o, l) => { reads++; readBytes += l; if (o + l > SRC.bytes.length) throw new Error("read past end"); return SRC.bytes.slice(o, o + l); };
const memSink = () => { let buf = new Uint8Array(0); const grow = n => { if (n > buf.length) { const b = new Uint8Array(Math.max(n, buf.length * 2)); b.set(buf); buf = b; } };
	return { write(d, at) { grow(at + d.length); buf.set(d, at); }, read(at, l) { return buf.slice(at, at + l); }, truncate(n) { grow(n); buf = buf.slice(0, n); }, get bytes() { return buf; } }; };
const readArchive = bytes => new PMTiles({ getKey: () => "mem", getBytes: async (o, l) => ({ data: bytes.slice(o, o + l).buffer }) });

const src = await openExtractSource(rangeRead);
ok("元を開く（metadata は gzip を解く）", src.metadata.name === "synthetic" && src.header.maxZoom === 11);

// 東京の 3×3、z0–11
const rect = z8Around(139.69, 35.68, 3);
const cache = new Map();
const plan = await planExtract(src, idRanges(rect, 0, 11), { minZoom: 0, maxZoom: 11, bbox: z8Bbox(rect), cache });
const expect = [...want.keys()].filter(id => { const [z, x, y] = tileIdToZxy(id); if (z < 8) { const k = 8 - z; return x >= rect.x0 >> k && x <= rect.x1 >> k && y >= rect.y0 >> k && y <= rect.y1 >> k; } const k = z - 8; return x >> k >= rect.x0 && x >> k <= rect.x1 && y >> k >= rect.y0 && y >> k <= rect.y1; });
ok("計画のタイル数＝矩形と祖先に在る全部", plan.tiles === expect.length, `${plan.tiles}/${expect.length}`);
ok("見積もり：重複した中身は 1 回", plan.bytes < plan.entries.reduce((s, e) => s + e.length, 0) && plan.bytes > 0);
ok("葉は要る物だけ読む", cache.size < 1 + Math.ceil(SRC.ents.length / 300), `${cache.size} dirs`);
{
	const r0 = reads; await planExtract(src, idRanges(rect, 0, 11), { minZoom: 0, maxZoom: 11, bbox: z8Bbox(rect), cache });
	ok("索引の覚え：2 回目は読まない", reads === r0);
	const t = trimPlan(plan, 9);
	ok("上限ズームで絞る", t.maxZoom === 9 && t.entries.every(e => zoomOfId(e.tileId + e.runLength - 1) <= 9) && t.bytes < plan.bytes);
	ok("容量に収まる上限ズーム", maxZoomWithin(plan, t.bytes) === 9 && maxZoomWithin(plan, 1e12) === 11 && maxZoomWithin(plan, 0) === 0);
	const cp = chunkPlan(plan.entries, { gap: 0, max: 200 });
	ok("チャンク：上限で割る・書き先は詰める", cp.chunks.length > 1 && cp.chunks.every(c => c.end - c.start <= 200 || c.blobs.length === 1) && cp.dataLength === plan.bytes);
}
async function checkOut(bytes, ids, label) {
	const pm = readArchive(bytes), h = await pm.getHeader();
	let good = 0, bad = [];
	for (const id of ids) { const [z, x, y] = tileIdToZxy(id); const t = await pm.getZxy(z, x, y); const s = t ? new TextDecoder().decode(t.data).replace(/\.+$/, "") : null; if (s === want.get(id)) good++; else bad.push(`${z}/${x}/${y}:${s}`); }
	ok(`${label}：pmtiles.js で全タイルが読める`, good === ids.length, bad.slice(0, 3).join(" "));
	return h;
}
{
	reads = 0; readBytes = 0;
	const sink = memSink(); let last = null;
	const size = await writeExtract(src, plan, sink, { chunking: { gap: 400 }, onProgress: p => { last = p; }, metadata: { ...src.metadata, unmap: { rect } } });
	const out = sink.bytes;
	ok("大きさ＝戻り値", out.length === size);
	const h = await checkOut(out, expect, "東京 3×3");
	ok("ヘッダ：ズーム域・箱・索引は無圧縮", h.minZoom === 0 && h.maxZoom === 11 && Math.abs(h.minLon - z8Bbox(rect)[0]) < 1e-6 && h.internalCompression === 1 && h.tileType === 1);
	ok("根は先頭 16384 バイトの内", h.rootDirectoryOffset + h.rootDirectoryLength <= 16384);
	const pm = readArchive(out);
	ok("矩形の外は無い", (await pm.getZxy(11, 0, 0)) === undefined && (await pm.getZxy(9, 10, 10)) === undefined);
	ok("metadata に印", (await pm.getMetadata()).unmap?.rect?.x0 === rect.x0);
	ok("進み：最後は全部", last && last.chunk === last.chunks && last.bytes === last.total);
	ok("読む量 ≒ 書く中身（隙間 400 バイトまで繋ぐ時・2 倍未満）", readBytes < plan.bytes * 2 + 1000, `${readBytes} vs ${plan.bytes}`);
}
// 再開：途中で止めて続きから
{
	const sink = memSink(), ac = new AbortController();
	const chunking = { gap: 64, max: 2048 };
	ok("再開の検定に足るチャンク数", chunkPlan(plan.entries, chunking).chunks.length > 3);
	let stopAt = 0;
	await writeExtract(src, plan, sink, { chunking, signal: ac.signal, onProgress: p => { stopAt = p.chunk; if (p.chunk >= 1) ac.abort(); } }).then(() => ok("止める", false), e => ok("止める（AbortError）", e?.name === "AbortError" || /abort/i.test(String(e))));
	ok("途中で止まった", stopAt === 1);
	await writeExtract(src, plan, sink, { chunking, startChunk: stopAt });
	await checkOut(sink.bytes, expect, "再開した書き出し");
}
// 日付変更線：割って 2 本
{
	const f = z8Around(179.9, -17, 3), parts = splitZ8Rect(f);
	let n = 0;
	for (const p of parts) {
		const pl = await planExtract(src, idRanges(p, 5, 11), { minZoom: 5, maxZoom: 11, bbox: z8Bbox(p) });
		const sink = memSink(); await writeExtract(src, pl, sink);
		const ex = [...want.keys()].filter(id => { const [z, x, y] = tileIdToZxy(id); if (z < 5) return false; if (z < 8) { const k = 8 - z; return x >= p.x0 >> k && x <= p.x1 >> k && y >= p.y0 >> k && y <= p.y1 >> k; } const k = z - 8; return x >> k >= p.x0 && x >> k <= p.x1 && y >> k >= p.y0 && y >> k <= p.y1; });
		await checkOut(sink.bytes, ex, `日付変更線の${p.x0 === 0 ? "西" : "東"}側`); n += ex.length;
		const h = await readArchive(sink.bytes).getHeader();
		ok(`${p.x0 === 0 ? "西" : "東"}側の箱は跨がない`, h.minLon < h.maxLon);
	}
	ok("両側にタイルがある", n > 0);
}
// 世界の土台：z0–3 全部・多くの項目でも根は 16384 に収まる（葉に分ける）
{
	const pl = await planExtract(src, worldRanges(0, 3), { minZoom: 0, maxZoom: 3, bbox: [-180, -85.0511, 180, 85.0511] });
	ok("世界 z0–3＝85 枚", pl.tiles === 85);
	const sink = memSink(); await writeExtract(src, pl, sink);
	await checkOut(sink.bytes, [...want.keys()].filter(id => zoomOfId(id) <= 3), "世界の土台");
	const all = await planExtract(src, worldRanges(0, 11), { minZoom: 0, maxZoom: 11, bbox: [-180, -85.0511, 180, 85.0511] });
	const sink2 = memSink(); await writeExtract(src, all, sink2);
	const h = await readArchive(sink2.bytes).getHeader();
	await checkOut(sink2.bytes, [...want.keys()], "全部");
	ok("全部：項目が多くても根は先頭に収まる", h.rootDirectoryOffset + h.rootDirectoryLength <= 16384);
}
// Range を無視する鯖は拒む（planet を丸ごと落とさない）
{
	const real = globalThis.fetch;
	globalThis.fetch = async () => new Response(SRC.bytes, { status: 200 });
	await openExtractSource("https://example.test/a.pmtiles").then(() => ok("Range 非対応を拒む", false), e => ok("Range 非対応を拒む", /Range/.test(e.message)));
	globalThis.fetch = async (u, o) => { const m = /bytes=(\d+)-(\d+)/.exec(o.headers.Range); const a = +m[1], b = +m[2]; return new Response(SRC.bytes.slice(a, b + 1), { status: 206, headers: { "content-range": `bytes ${a}-${b}/${SRC.bytes.length}`, etag: '"v1"' } }); };
	const s = await openExtractSource("https://example.test/a.pmtiles");
	ok("HTTP：etag と全体の大きさを覚える", s.etag === '"v1"' && s.size === SRC.bytes.length);
	globalThis.fetch = real;
}
// 手元のアーカイブを全部たどる（地名の索引作り）
{
	let same = true;
	for (const id of [0, 1, 5, 21, 12345, zxyToTileId(12, 3637, 1612), zxyToTileId(15, 29000, 12000)]) same &&= JSON.stringify(tileZxy(id)) === JSON.stringify(tileIdToZxy(id));
	ok("tileZxy＝pmtiles.js の tileIdToZxy", same);
	const all = await listEntries(src);
	ok("listEntries：根と葉を全部（元の項目数）", all.length === SRC.ents.length && all.every((e, i) => !i || all[i - 1].tileId < e.tileId));
	const e = all.find(e => tileZxy(e.tileId)[0] === 9);
	const t = new TextDecoder().decode(await decompressTile(await readTileAt(src, e), 1)).replace(/\.+$/, "");
	ok("readTileAt：中身", t === want.get(e.tileId));
}
// 版の印（M5）：同じ元＝同じ印・中身の大きさが変われば違う印（host・etag に依らない）
{
	const h = parseHeader(serializeHeader(src.header));
	ok("archiveVersion：同じヘッダ＝同じ印", archiveVersion(h) === archiveVersion(src.header));
	ok("archiveVersion：中身の大きさが変わる＝違う印", archiveVersion({ ...h, dataLength: h.dataLength + 1 }) !== archiveVersion(h) && archiveVersion({ ...h, tileEntries: h.tileEntries + 1 }) !== archiveVersion(h));
}
if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall pass");
