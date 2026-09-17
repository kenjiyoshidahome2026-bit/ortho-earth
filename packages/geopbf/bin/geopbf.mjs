#!/usr/bin/env node
// geopbf CLI ── ブラウザを開かずに GeoJSON ⇄ GeoPBF を往復し、gint の効き目を数字で見るための入口。
//
// 依存はこのパッケージ自身と Node 組み込みのみ（pbf は geopbf の既存依存・圧縮は node:zlib）。
// Worker と DOM を使う src/index.js は通さず、Node でそのまま動く pbf-base / extension/gint を直に叩く。
// ImageData は pbf-base のエンコード経路が参照するが Node に無いので、tests/t-loaders.mjs と同じ手で補う。
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync, deflateSync } from "node:zlib";
import { GeoPBF } from "../src/pbf-base.js";
import { t } from "./messages.mjs";   // 表示文（英語基軸・GEOPBF_LANG=ja で日本語）

globalThis.ImageData ??= class ImageData {
	constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};

// ── 共通ヘルパ ────────────────────────────────────────────────────────────────

const tkyArg = async (v) => !v ? undefined : /^https?:\/\//.test(v) ? v : new Uint8Array(await readFile(v));

const readMaybeGzip = async (path) => {
	const buf = await readFile(path);
	return new Uint8Array(buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf);
};

const openPbf = async (path) => await new GeoPBF().set(await readMaybeGzip(path));

// 幾何を種別によらず「リング／ライン／点」の座標列に均す（頂点勘定と gint 化の共通入口）
const eachRing = (geom, fn) => {
	if (!geom) return;
	const c = geom.coordinates;
	switch (geom.type) {
		case "Point":            fn([c]); break;
		case "MultiPoint":
		case "LineString":       fn(c); break;
		case "MultiLineString":
		case "Polygon":          c.forEach(fn); break;
		case "MultiPolygon":     c.forEach(p => p.forEach(fn)); break;
		case "GeometryCollection": geom.geometries.forEach(g => eachRing(g, fn)); break;
	}
};

const countVertices = (features) => {
	let n = 0;
	for (const f of features) eachRing(f.geometry, r => { n += r.length; });
	return n;
};

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const num = (n) => n.toLocaleString("en-US");
// 変換系コマンドの共通行（書き出し報告・読まなかった列・他の層）
const pbfOut = (outPath, out, gzip, s) => t("pbfOut", { out: outPath, size: mb(out.length), gzip: gzip ? " (gzip)" : "", precision: s.precision, read: s.ms.read.toFixed(0), encode: s.ms.encode.toFixed(0) });
const skippedList = (skipped) => skipped.map(k => `${k.name}(${k.reason})`).join(" ");
const othersNote = (s) => s.layers.length > 1 ? t("others", { list: s.layers.filter(l => l !== s.layer).join(", ") }) : "";

// 引数を「位置引数」と「オプション」に一度で分ける（--name value 形式・--name 単独は真）
const parseArgs = (argv, valued = []) => {
	const pos = [], opts = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) { pos.push(a); continue; }
		const name = a.slice(2);
		opts[name] = valued.includes(name) ? argv[++i] : true;
	}
	return { pos, opts };
};

// ── enc ───────────────────────────────────────────────────────────────────────

async function enc(argv) {
	const { pos: [inPath, outPath], opts } = parseArgs(argv, ["precision", "name"]);
	if (!inPath || !outPath) throw new Error("enc <in.geojson|in.ndjson> <out.geopbf>");

	const precision = opts.precision === undefined ? undefined : Number(opts.precision);
	if (precision !== undefined && !(Number.isInteger(precision) && precision >= 1 && precision <= 9))
		throw new Error(t("precisionRange"));   // 0 は pbf-base の `precision || 6` が黙って 6 に落とすので範囲外

	const src = await readMaybeGzip(inPath);
	const t0 = Date.now();
	let pbf;
	if (/\.(ndjson|geojsonl|geojsons|jsonl)(\.gz)?$/i.test(inPath)) {   // 1 行 1 地物 / GeoJSON Text Sequence（convert/ndjson.js）
		const { fromNdjson } = await import("../src/convert/ndjson.js");
		const r = await fromNdjson(src, { name: opts.name ?? inPath.replace(/^.*[\\/]/, "").replace(/\.[^.]+?(\.gz)?$/i, ""), precision });
		pbf = r.pbf;
		if (r.stats.badLines) console.log(t("ndjsonBadLines", { n: num(r.stats.badLines) }));
	} else {
		const gj = JSON.parse(Buffer.from(src).toString("utf8"));
		pbf = await new GeoPBF({ name: gj.name || "layer", precision }).set(gj);
	}
	const gzip = !opts["no-gzip"];   // GDAL ドライバの COMPRESS=GZIP 既定・配布形に合わせる
	let out = Buffer.from(pbf.arrayBuffer);
	if (gzip) out = gzipSync(out, { level: 9 });
	await writeFile(outPath, out);

	console.log(`${inPath}  ${mb(src.length)}`);
	console.log(t("encDone", { out: outPath, size: mb(out.length), gzip: gzip ? " (gzip)" : "", ratio: (src.length / out.length).toFixed(1), ms: Date.now() - t0 }));
}

// ── dec ───────────────────────────────────────────────────────────────────────

async function dec(argv) {
	const { pos: [inPath, outPath] } = parseArgs(argv);
	if (!inPath || !outPath) throw new Error("dec <in.geopbf> <out.geojson>");
	const gj = (await openPbf(inPath)).geojson;
	await writeFile(outPath, JSON.stringify(gj));
	console.log(t("decDone", { out: outPath, features: num(gj.features.length), vertices: num(countVertices(gj.features)) }));
}

// ── info ──────────────────────────────────────────────────────────────────────

async function info(argv) {
	const { pos: [inPath] } = parseArgs(argv);
	if (!inPath) throw new Error("info <in.geopbf>");
	const raw = await readFile(inPath);
	const gzipped = raw[0] === 0x1f && raw[1] === 0x8b;
	const pbf = await openPbf(inPath);
	const gj = pbf.geojson;

	const types = new Map();
	for (const f of gj.features) types.set(f.geometry?.type ?? "null", (types.get(f.geometry?.type ?? "null") ?? 0) + 1);

	console.log(`size        ${mb(raw.length)}${gzipped ? " (gzip)" : ""}`);
	console.log(`features    ${num(gj.features.length)}`);
	console.log(t("infoVertices", { n: num(countVertices(gj.features)) }));
	console.log(`geometry    ${[...types].map(([t, n]) => `${t} ${num(n)}`).join("  ")}`);
	console.log(t("infoPrecision", { p: pbf.precision(), m: (1 / Math.pow(10, pbf.precision()) * 111320).toFixed(2) }));
	for (const [label, v] of [["name", pbf.name()], ["description", pbf.description()],
		["license", pbf.license()], ["attribution", pbf.attribution()],
		["minZoom", pbf.minZoom()], ["maxZoom", pbf.maxZoom()]])
		if (v !== undefined && v !== null && v !== "") console.log(`${label.padEnd(11)} ${v}`);
}

// ── lod ───────────────────────────────────────────────────────────────────────
// gint の VW ランクを付けて、ズームごとに実際に描かれる頂点数を出す。
// しきい値は README の 3*(21-z)＝「その頂点が 1 ピクセル分の意味を持ち始めるズーム」。
// 注意: ここは位相解析（analyzeTopology）を通していないので、L1（常時描画）になるのは
// リングの端点だけ。隣り合う面が共有する境界の頂点は L1 に立たないので、実際の描画で
// 隙間を作らない保証まで見たい場合はブラウザ側の位相経路を通すこと。

async function lod(argv) {
	const { gint } = await import("../src/extension/gint.js");   // wasm 無しでも純JS経路で動く
	const { pos: [inPath] } = parseArgs(argv);
	if (!inPath) throw new Error("lod <in.geopbf>");

	const gj = (await openPbf(inPath)).geojson;
	const hist = new Array(64).fill(0);
	let total = 0, l1 = 0;
	const t0 = Date.now();
	for (const f of gj.features) eachRing(f.geometry, (ring) => {
		total += ring.length;
		const arc = new BigUint64Array(ring.length);
		for (let i = 0; i < ring.length; i++) arc[i] = gint.pack(ring[i]);
		gint.L1toL2(arc);
		for (let i = 0; i < arc.length; i++) {
			if ((arc[i] & gint.TERMINAL_BIT) !== 0n) l1++;
			else hist[Number(arc[i] & gint.WEIGHT_MASK)]++;
		}
	});
	if (!total) { console.log(t("lodEmpty")); return; }

	console.log(t("lodHead", { total: num(total), l1: num(l1), ms: Date.now() - t0, size: mb(total * 8) }));
	console.log(t("lodTable"));
	for (const z of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 21]) {
		const th = Math.max(0, (21 - z) * 3);
		let keep = l1;
		for (let r = th; r < 64; r++) keep += hist[r];
		const pct = keep / total * 100;
		console.log(`  ${String(z).padStart(2)}  ${String(th).padStart(3)}  ${num(keep).padStart(12)}   ${pct.toFixed(1).padStart(5)}%  ${"#".repeat(Math.round(pct / 2.5))}`);
	}
	console.log(t("lodNote"));
}

// ── cog ───────────────────────────────────────────────────────────────────────
// COG（Cloud Optimized GeoTIFF）＝HTTP Range 直読み。src/cog/core.js（DOM-free）を lod 方式の
// dynamic import で呼ぶ＝他コマンドはコストを払わない。JPEG/WebP タイルは Node にデコーダが
// 無いため明示エラー（ブラウザゲート tests/t-cog.html で見る）。

async function cog(argv) {
	const { openCog, lonlatTarget } = await import("../src/cog/core.js");
	const { pos: [sub, inPath, outPath], opts } = parseArgs(argv, ["level", "width"]);
	if (!sub || !inPath) throw new Error("cog info <url|file.tif> | cog png <url|file.tif> <out.png>");
	const src = /^https?:\/\//.test(inPath) ? inPath : new Blob([await readFile(inPath)]);
	const t0 = Date.now();
	const c = await openCog(src);
	const compName = { 1: "none", 5: "LZW", 7: "JPEG", 8: "deflate", 32946: "deflate", 50001: "WebP" }[c.compression] || c.compression;

	if (sub === "info") {
		console.log(`size        ${c.width} x ${c.height} px${c.bigtiff ? "  (BigTIFF)" : ""}`);
		console.log(`tile        ${c.tileW} x ${c.tileH}`);
		console.log(`bands       ${c.samples} (${c.dtype})  compression ${compName}${c.nodata !== null ? `  nodata ${c.nodata}` : ""}`);
		console.log(`crs         EPSG:${c.epsg}`);
		console.log(`bbox        ${c.bbox.map(v => +v.toFixed(3)).join(", ")}`);
		console.log(`bboxLL      ${c.bboxLL.map(v => +v.toFixed(6)).join(", ")}`);
		if (c.citation) console.log(`citation    ${c.citation}`);
		console.log(`overviews   ${c.overviews.map(o => `${o.width}x${o.height}`).join("  ")}`);
		if (opts.bench) {
			const [w, s, e, n] = c.bboxLL;
			const W = 512, H = Math.max(32, Math.round(W * (n - s) / (e - w)));
			const dt = Date.now();
			await c.render(lonlatTarget([w, s, e, n], W, H), { level: c.overviews.length - 1 });
			const m = c.metrics();
			console.log(t("cogBench", { ttfh: m.ttfhMs.toFixed(0), w: W, ms: Date.now() - dt, requests: m.rangeRequests, coalesced: m.coalescedFrom,
				ratio: (m.coalescedFrom / Math.max(m.rangeRequests, 1)).toFixed(1), bytes: mb(m.bytesFetched), tiles: m.tilesDecoded, decode: m.decodeMs.toFixed(0) }));
		}
		return;
	}
	if (sub === "png") {
		if (!outPath) throw new Error("cog png <url|file.tif> <out.png>");
		const level = opts.level !== undefined ? +opts.level : c.overviews.length - 1;
		const [w, s, e, n] = c.bboxLL;
		const W = opts.width ? +opts.width : 768, H = Math.max(16, Math.round(W * (n - s) / (e - w)));
		const rgba = await c.render(lonlatTarget([w, s, e, n], W, H), { level });
		if (!rgba) throw new Error(t("cogEmpty"));
		await writeFile(outPath, encodePNG(rgba, W, H));
		console.log(`${outPath}  ${W} x ${H}  level ${level}/${c.overviews.length - 1}  ${Date.now() - t0} ms`);
		return;
	}
	throw new Error(t("cogUnknownSub", { sub }));
}

// 最小 PNG エンコーダ（8bit RGBA・filter 0・node:zlib）＝依存ゼロ維持
function encodePNG(rgba, w, h) {
	const crcT = [...Array(256)].map((_, nn) => { let c = nn; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
	const crc = (u8) => { let c = ~0; for (const b of u8) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (~c) >>> 0; };
	const chunk = (type, data) => {
		const out = new Uint8Array(12 + data.length);
		const v = new DataView(out.buffer);
		v.setUint32(0, data.length);
		out.set([...type].map(ch => ch.charCodeAt(0)), 4);
		out.set(data, 8);
		v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
		return out;
	};
	const ihdr = new Uint8Array(13);
	const iv = new DataView(ihdr.buffer);
	iv.setUint32(0, w); iv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;   // 8bit RGBA
	const rows = new Uint8Array(h * (w * 4 + 1));
	for (let j = 0; j < h; j++) rows.set(rgba.subarray(j * w * 4, (j + 1) * w * 4), j * (w * 4 + 1) + 1);
	const idat = new Uint8Array(deflateSync(rows, { level: 6 }));   // PNG の IDAT は zlib 形式（deflateSync）
	return Buffer.concat([
		Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0)),
	]);
}

// ── pmtiles / parquet ─────────────────────────────────────────────────────────
// src/convert/*（DOM 非依存）を dynamic import。GPU は navigator.gpu（ブラウザ/Deno）か npm の webgpu（Dawn）＝
// Node 単体では CPU 経路（同じ契約・同じ出力）で動く。どちらで走ったかは必ず数字と一緒に出す。

const gpuOpt = (opts) => opts["no-gpu"] ? false : opts.gpu ? true : undefined;
// Node で Dawn（任意依存の `webgpu` パッケージ）が入っていれば読んで setGPU() で注入する。
// ここに置く理由: CLI は Node 専用で exports にも載らない＝消費者のバンドラが辿らない唯一の場所。
// ライブラリ側（src/convert/gpu.js）に裸の `import("webgpu")` を置くと vite/rolldown が静的解決を試みて
// 消費者の dev が 500 で割れる（1.5.0 の轍・"web"+"gpu" の細工も vite 8 の定数畳み込みで戻される＝1.5.1 の轍）。
const injectDawn = async () => {
	try {
		const m = await import("webgpu");
		if (!m?.create) return false;
		if (m.globals) for (const k of Object.keys(m.globals)) globalThis[k] ??= m.globals[k];
		const { setGPU } = await import("../src/convert/gpu.js");
		setGPU(m.create([]));
		return true;
	} catch { return false; }   // 未導入＝CPU 経路（失敗ではなく通常の分岐）
};
const attrOpts = (opts) => ({ include: opts.include ? opts.include.split(",") : undefined, exclude: opts.exclude ? opts.exclude.split(",") : undefined, excludeAll: !!opts["exclude-all"] });
const engineNote = (st) => st.engine === "gpu" ? `GPU ${[st.gpu?.vendor, st.gpu?.architecture].filter(Boolean).join(" ") || "webgpu"}` : "CPU";

async function pmtiles(argv) {
	const { toPMTiles } = await import("../src/convert/tiler.js");
	const { pos: [inPath, outPath], opts } = parseArgs(argv, ["minzoom", "maxzoom", "extent", "buffer", "layer", "gint", "lod-bias", "workers", "drop-rate", "tiny-polygon", "tiny-line", "include", "exclude", "simplification"]);
	if (!inPath || !outPath) throw new Error("pmtiles <in.geopbf> <out.pmtiles>");
	const t0 = Date.now();
	const pbf = await openPbf(inPath);
	let gint;
	if (opts.gint) gint = (await readMaybeGzip(opts.gint)).buffer.slice(0);
	else { const { bakeGint } = await import("../src/convert/node-gint.js"); gint = await bakeGint(pbf); }
	const t1 = Date.now();
	const wantGpu = gpuOpt(opts);
	if (wantGpu === true) { await injectDawn(); const { findGPU } = await import("../src/convert/gpu.js"); if (!(await findGPU())) console.error(t("gpuMissing")); }
	const r = await toPMTiles(pbf, { gint, gpu: wantGpu,
		minZoom: opts.minzoom !== undefined ? +opts.minzoom : 0, maxZoom: opts.maxzoom !== undefined ? +opts.maxzoom : 14,
		extent: opts.extent ? +opts.extent : undefined, buffer: opts.buffer !== undefined ? +opts.buffer : undefined,
		layer: opts.layer, lodBias: opts["lod-bias"] !== undefined ? +opts["lod-bias"] : undefined, workers: opts.workers !== undefined ? +opts.workers : undefined, dropRate: opts["drop-rate"] !== undefined ? +opts["drop-rate"] : undefined,
		simplification: opts.simplification === undefined ? undefined : opts.simplification === "off" ? false : +opts.simplification,
		tinyPolygon: opts["tiny-polygon"] !== undefined ? +opts["tiny-polygon"] : undefined, tinyLine: opts["tiny-line"] !== undefined ? +opts["tiny-line"] : undefined, ...attrOpts(opts) });
	await writeFile(outPath, r.buffer);
	const s = r.stats;
	console.log(t("pmIn", { in: inPath, features: num(pbf.length), how: t(opts.gint ? "gintLoaded" : "gintBaked"), ms: t1 - t0, arcs: num(s.arcs), vertices: num(s.vertices) }));
	console.log(t("pmOut", { out: outPath, size: mb(s.bytes), tiles: num(s.tiles), contents: num(s.contents), min: r.metadata.minzoom, max: r.metadata.maxzoom, engine: engineNote(s), workers: s.workers }));
	console.log(t("pmTimes", { project: s.ms.project_lod.toFixed(0), calibrate: (s.ms.calibrate ?? 0).toFixed(0), write: s.ms.lod_write.toFixed(0), assemble: s.ms.assemble.toFixed(0), pmtiles: s.ms.pmtiles.toFixed(0), total: s.ms.total.toFixed(0), kept: num(s.kept) }));
}

async function parquet(argv) {
	const { toGeoParquet } = await import("../src/convert/geoparquet.js");
	const { pos: [inPath, outPath], opts } = parseArgs(argv, ["compression", "row-group", "order", "include", "exclude"]);
	if (!inPath || !outPath) throw new Error("parquet <in.geopbf> <out.parquet>");
	const pbf = await openPbf(inPath);
	const wantGpu = gpuOpt(opts);
	if (wantGpu === true) { await injectDawn(); const { findGPU } = await import("../src/convert/gpu.js"); if (!(await findGPU())) console.error(t("gpuMissing")); }
	const r = await toGeoParquet(pbf, { gpu: wantGpu, codec: opts.compression || undefined, rowGroupSize: opts["row-group"] ? +opts["row-group"] : undefined, order: opts.order, bboxColumn: opts["no-bbox"] ? false : undefined, ...attrOpts(opts) });
	await writeFile(outPath, r.buffer);
	const s = r.stats;
	console.log(t("pqIn", { in: inPath, features: num(s.features), vertices: num(s.vertices) }));
	console.log(`${outPath}  ${mb(s.bytes)}  ${r.geo.columns.geometry.geometry_types.join("/")}  order ${s.order}  ${s.codec}  ${engineNote(s)}`);
	console.log(t("pqTimes", { decode: s.ms.decode.toFixed(0), kernels: s.ms.kernels.toFixed(0), wkb: s.ms.wkb.toFixed(0), parquet: s.ms.parquet.toFixed(0), total: s.ms.total.toFixed(0) }));
}

async function parquet2pbf(argv) {
	const { fromGeoParquet } = await import("../src/convert/geoparquet.js");
	const { pos: [inPath, outPath], opts } = parseArgs(argv, ["precision", "name", "geometry", "include", "exclude"]);
	if (!inPath || !outPath) throw new Error("parquet2pbf <in.parquet> <out.geopbf>");
	const r = await fromGeoParquet(new Uint8Array(await readFile(inPath)), { precision: opts.precision !== undefined ? +opts.precision : undefined, name: opts.name, geometryColumn: opts.geometry, ignoreCrs: !!opts["ignore-crs"], ...attrOpts(opts) });
	const gzip = !opts["no-gzip"];
	let out = Buffer.from(r.pbf.arrayBuffer);
	if (gzip) out = gzipSync(out, { level: 9 });
	await writeFile(outPath, out);
	const s = r.stats;
	console.log(t("pq2In", { in: inPath, features: num(s.features), dropped: s.droppedGeometries ? t("droppedRowsNoGeom", { n: num(s.droppedGeometries) }) : "", vertices: num(s.vertices), columns: s.columns.length, crs: s.crs, writer: s.created || "?" }));
	if (s.skipped.length) console.log(t("skippedColumns", { list: skippedList(s.skipped) }));
	console.log(pbfOut(outPath, out, gzip, s));
}

async function gpkg2pbf(argv) {
	const { fromGeoPackage, readGeoPackage } = await import("../src/convert/gpkg.js");
	const { pos: [inPath, outPath], opts } = parseArgs(argv, ["precision", "name", "layer", "include", "exclude", "tky2jgd", "patchjgd"]);
	if (!inPath) throw new Error("gpkg2pbf <in.gpkg> [out.geopbf] [--layer name]");
	const u8 = new Uint8Array(await readFile(inPath));
	if (!outPath) {
		const g = readGeoPackage(u8);
		console.log(t("gpkgList", { in: inPath, encoding: g.encoding, page: g.pageSize, n: g.layers.length }));
		for (const l of g.layers) console.log(`  ${l.table}${l.identifier && l.identifier !== l.table ? ` (${l.identifier})` : ""}  ${l.geometryType}${l.z ? "Z" : ""}${l.m ? "M" : ""}  ${l.crs.label}${l.crs.kind === "other" ? t("notLonLat") : ""}  ${t("rows", { n: num(l.count) })}  ${t("columns", { list: l.columns.filter(c => c.name !== l.geometryColumn).map(c => c.name).join(",") })}`);
		for (const x of g.tiles) console.log(`  ${x.table}${x.identifier && x.identifier !== x.table ? ` (${x.identifier})` : ""}  tiles  ${x.crs.label}  z${x.zooms[0]}–${x.zooms[x.zooms.length - 1]}  ${t("tilesCount", { n: num(x.count) })}${x.description ? `  ${x.description}` : ""}`);
		for (const o of g.others) console.log(`  ${o.table}  (${o.dataType}${o.missing ? t("tableMissing") : ""})`);
		for (const w of g.warnings) console.log(`  ⚠ ${w}`);
		return;
	}
	const r = await fromGeoPackage(u8, { layer: opts.layer, precision: opts.precision !== undefined ? +opts.precision : undefined, name: opts.name, ignoreCrs: !!opts["ignore-crs"], tky2jgd: await tkyArg(opts.tky2jgd), patchjgd: await tkyArg(opts.patchjgd), ...attrOpts(opts) });
	const gzip = !opts["no-gzip"];
	let out = Buffer.from(r.pbf.arrayBuffer);
	if (gzip) out = gzipSync(out, { level: 9 });
	await writeFile(outPath, out);
	const s = r.stats;
	console.log(t("layerLine", { in: inPath, layer: s.layer, others: othersNote(s), features: num(s.features), vertices: num(s.vertices), columns: s.columns.length, crs: s.crs, reprojected: s.reprojected ? t("toLonLat") : "" }));
	if (s.skipped.length) console.log(t("skippedColumns", { list: skippedList(s.skipped) }));
	if (s.droppedGeometries || s.z || s.m || s.bigints) console.log(t("gpkgDropped", { n: s.droppedGeometries, plain: s.droppedGeometries - s.extendedGeometries, extended: s.extendedGeometries, zm: s.z || s.m ? t("zmDropped") : "", bigints: s.bigints ? t("bigintToString", { n: s.bigints }) : "" }));
	for (const w of s.warnings) console.log(`  ⚠ ${w}`);
	console.log(pbfOut(outPath, out, gzip, s));
}

async function spatialite2pbf(argv) {
	const { fromSpatiaLite, readSpatiaLite } = await import("../src/convert/spatialite.js");
	const { pos: [inPath, outPath], opts } = parseArgs(argv, ["precision", "name", "layer", "include", "exclude", "tky2jgd", "patchjgd"]);
	if (!inPath) throw new Error("spatialite2pbf <in.sqlite> [out.geopbf] [--layer name]");
	const u8 = new Uint8Array(await readFile(inPath));
	if (!outPath) {
		const g = readSpatiaLite(u8);
		console.log(t("gpkgList", { in: inPath, encoding: g.encoding, page: g.pageSize, n: g.layers.length }));
		for (const l of g.layers) console.log(`  ${l.table}${l.identifier && l.identifier !== l.table ? ` (${l.identifier})` : ""}  ${l.geometryType}${l.z ? "Z" : ""}${l.m ? "M" : ""}  ${l.crs.label}${l.crs.kind === "other" ? t("notLonLat") : ""}  ${t("rows", { n: num(l.count) })}  ${t("columns", { list: l.columns.filter(c => c.name !== l.geometryColumn).map(c => c.name).join(",") })}`);
		for (const m of g.missing) console.log(t("missingTable", { table: m }));
		for (const w of g.warnings) console.log(`  ⚠ ${w}`);
		return;
	}
	const r = await fromSpatiaLite(u8, { layer: opts.layer, precision: opts.precision !== undefined ? +opts.precision : undefined, name: opts.name, ignoreCrs: !!opts["ignore-crs"], tky2jgd: await tkyArg(opts.tky2jgd), patchjgd: await tkyArg(opts.patchjgd), ...attrOpts(opts) });
	const gzip = !opts["no-gzip"];
	let out = Buffer.from(r.pbf.arrayBuffer);
	if (gzip) out = gzipSync(out, { level: 9 });
	await writeFile(outPath, out);
	const s = r.stats;
	console.log(t("layerLine", { in: inPath, layer: s.layer, others: othersNote(s), features: num(s.features), vertices: num(s.vertices), columns: s.columns.length, crs: s.crs, reprojected: s.reprojected ? t("toLonLat") : "" }));
	if (s.skipped.length) console.log(t("skippedColumns", { list: skippedList(s.skipped) }));
	if (s.droppedGeometries || s.z || s.m || s.bigints) console.log(t("gpkgDropped", { n: s.droppedGeometries, plain: s.droppedGeometries - s.extendedGeometries, extended: s.extendedGeometries, zm: s.z || s.m ? t("zmDropped") : "", bigints: s.bigints ? t("bigintToString", { n: s.bigints }) : "" }));
	for (const w of s.warnings) console.log(`  ⚠ ${w}`);
	console.log(pbfOut(outPath, out, gzip, s));
}

async function dxf2pbf(argv) {
	const { fromDxf, readDxf } = await import("../src/convert/dxf.js");
	const { pos: [inPath, outPath], opts } = parseArgs(argv, ["precision", "name", "crs", "unit", "encoding", "tky2jgd", "patchjgd"]);
	if (!inPath) throw new Error("dxf2pbf <in.dxf> [out.geopbf] [--crs 6677]");
	const u8 = new Uint8Array(await readFile(inPath));
	if (!outPath) {
		const d = readDxf(u8, { encoding: opts.encoding });
		console.log(t("dxfList", { in: inPath, ver: d.header.acadver ?? "?", units: d.header.insunits ?? "?", range: d.header.extmin ? `${d.header.extmin.join(",")} – ${d.header.extmax.join(",")}` : "?", entities: num(d.entities), blocks: d.blocks.length }));
		console.log(t("dxfKinds", { list: Object.entries(d.counts).map(([k, v]) => `${k}×${v}`).join(" ") }));
		console.log(t("dxfLayers", { list: d.layers.map(l => l.name).join(", ") || t("dxfNoLayerTable") }));
		return;
	}
	const r = await fromDxf(u8, { crs: opts.crs, ignoreCrs: !!opts["ignore-crs"], unitScale: opts.unit !== undefined ? +opts.unit : undefined, encoding: opts.encoding, closedAsPolygon: !opts["closed-lines"],
		precision: opts.precision !== undefined ? +opts.precision : undefined, name: opts.name ?? inPath.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, ""), tky2jgd: await tkyArg(opts.tky2jgd), patchjgd: await tkyArg(opts.patchjgd) });
	const gzip = !opts["no-gzip"];
	let out = Buffer.from(r.pbf.arrayBuffer);
	if (gzip) out = gzipSync(out, { level: 9 });
	await writeFile(outPath, out);
	const s = r.stats;
	console.log(t("dxfIn", { in: inPath, entities: num(s.entities), inserts: num(s.inserts), features: num(s.features), vertices: num(s.vertices), crs: s.crs, unit: s.reprojected ? t("dxfUnit", { scale: s.unitScale }) : "" }));
	const sk = Object.entries(s.skipped); if (sk.length) console.log(t("dxfSkipped", { list: sk.map(([k, v]) => `${k}×${v}`).join(" ") }));
	if (s.datumApprox) console.log(t("datumApprox"));
	console.log(pbfOut(outPath, out, gzip, s));
}

async function csv2pbf(argv) {
	const { fromTable } = await import("../src/convert/table.js");
	const { pos: [inPath, outPath], opts } = parseArgs(argv, ["precision", "name", "lon", "lat", "wkt", "sheet", "encoding", "fallback-encoding", "delimiter", "include", "exclude"]);
	if (!inPath || !outPath) throw new Error("csv2pbf <in.csv|tsv|xlsx> <out.geopbf>");
	const r = await fromTable(new Uint8Array(await readFile(inPath)), { precision: opts.precision !== undefined ? +opts.precision : undefined, name: opts.name ?? inPath.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, ""), lon: opts.lon, lat: opts.lat, wkt: opts.wkt, sheet: opts.sheet, encoding: opts.encoding, fallbackEncoding: opts["fallback-encoding"], delimiter: opts.delimiter, ...attrOpts(opts) });
	const gzip = !opts["no-gzip"];
	let out = Buffer.from(r.pbf.arrayBuffer);
	if (gzip) out = gzipSync(out, { level: 9 });
	await writeFile(outPath, out);
	const s = r.stats;
	const geom = s.geometry.wkt ? t("wktColumn", { col: s.geometry.wkt }) : t("lonLatColumns", { lon: s.geometry.lon, lat: s.geometry.lat });
	console.log(t("csvIn", { in: inPath, kind: s.kind, sheet: s.sheet ? t("sheet", { name: s.sheet, others: s.sheets?.length > 1 ? t("others", { list: s.sheets.filter(x => x !== s.sheet).join(", ") }) : "" }) : "", rows: num(s.rows), features: num(s.features), dropped: s.droppedGeometries ? t("droppedNoCoords", { n: num(s.droppedGeometries) }) : "", vertices: num(s.vertices), geom, columns: s.columns.length }));
	console.log(pbfOut(outPath, out, gzip, s));
}

async function gdb2pbf(argv) {
	const { openFileGDB, fromFileGDB, gdbSourceFromFiles } = await import("../src/convert/filegdb.js");
	const { pos: [inPath, outPath], opts } = parseArgs(argv, ["precision", "name", "layer", "include", "exclude", "tky2jgd", "patchjgd"]);
	if (!inPath) throw new Error("gdb2pbf <in.gdb|in.zip> [out.geopbf] [--layer name]");
	const { statSync, readdirSync, openSync, readSync, closeSync } = await import("node:fs");
	const { join } = await import("node:path");
	let source;
	if (statSync(inPath).isDirectory()) {
		const names = readdirSync(inPath);
		source = { names, read: async (name, offset = 0, length) => { const p = join(inPath, names.find(n => n.toLowerCase() === name.toLowerCase()) ?? name); const size = statSync(p).size; const n = length === undefined ? size - offset : Math.min(length, size - offset); const buf = Buffer.alloc(Math.max(0, n)); const fd = openSync(p, "r"); try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); } return new Uint8Array(buf.buffer, buf.byteOffset, buf.length); } };
	} else {
		const { decodeZIP } = await import("../src/modules/decodeZIP.js");
		const entries = await decodeZIP(new Blob([await readFile(inPath)]));
		if (!entries) throw new Error(t("zipOpenFailed"));
		source = gdbSourceFromFiles(entries);
	}
	if (!outPath) {
		const g = await openFileGDB(source);
		console.log(t("gdbList", { in: inPath, classes: g.layers.length, tables: g.tables.length - g.layers.length }));
		for (const x of g.tables) console.log(`  ${x.name}  ${x.error ? `⚠ ${x.error}` : x.geometryType ? `${x.geometryType}${x.hasZ ? "Z" : ""}${x.hasM ? "M" : ""}  ${x.crs.label}${x.crs.kind === "other" ? t("cannotToLonLat") : ""}` : "(table)"}  ${t("rows", { n: num(x.rows) })}  ${t("columns", { list: x.fields.filter(f => f.type !== "geometry").map(f => f.name).join(",") })}`);
		return;
	}
	const r = await fromFileGDB(source, { layer: opts.layer, precision: opts.precision !== undefined ? +opts.precision : undefined, name: opts.name, ignoreCrs: !!opts["ignore-crs"], tky2jgd: await tkyArg(opts.tky2jgd), patchjgd: await tkyArg(opts.patchjgd), ...attrOpts(opts) });
	const gzip = !opts["no-gzip"];
	let out = Buffer.from(r.pbf.arrayBuffer);
	if (gzip) out = gzipSync(out, { level: 9 });
	await writeFile(outPath, out);
	const s = r.stats;
	console.log(t("gdbLayerLine", { in: inPath, layer: s.layer, others: othersNote(s), type: s.geometryType, rows: num(s.rows), features: num(s.features), vertices: num(s.vertices), columns: s.columns.length, crs: s.crs, reprojected: s.reprojected ? t("toLonLat") : "" }));
	if (s.datumApprox) console.log(t("datumApprox"));
	if (s.datum?.tky2jgd) console.log(t("tky2jgd", { grid: num(s.datum.tky2jgd.grid), helmert: num(s.datum.tky2jgd.helmert) }));
	if (s.datum?.patchjgd) console.log(t("patchjgd", { grid: num(s.datum.patchjgd.grid), outside: num(s.datum.patchjgd.outside) }));
	if (s.droppedGeometries || s.curves || s.z || s.m || s.skipped.length) console.log(t("gdbDropped", { n: s.droppedGeometries, empty: s.emptyGeometries, multipatch: s.multipatch, curves: s.curves ? t("curvesLinearized", { n: s.curves }) : "", zm: s.z || s.m ? t("zmDropped") : "", skipped: s.skipped.length ? t("skippedColumns", { list: skippedList(s.skipped) }) : "" }));
	console.log(pbfOut(outPath, out, gzip, s));
}

// ── entry ─────────────────────────────────────────────────────────────────────

const [cmd, ...argv] = process.argv.slice(2);
const commands = { enc, dec, info, lod, cog, pmtiles, parquet, parquet2pbf, gpkg2pbf, spatialite2pbf, dxf2pbf, csv2pbf, gdb2pbf };
if (!cmd || cmd === "--help" || cmd === "-h") { console.log(t("usage")); process.exit(0); }
if (!commands[cmd]) { console.error(t("unknownCommand", { cmd })); console.error(t("usage")); process.exit(1); }
try {
	await commands[cmd](argv);
} catch (e) {
	console.error(`geopbf ${cmd}: ${e.message}`);
	process.exit(1);
}
