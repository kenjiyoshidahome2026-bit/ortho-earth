#!/usr/bin/env node
// geopbf CLI ── ブラウザを開かずに GeoJSON ⇄ GeoPBF を往復し、gint の効き目を数字で見るための入口。
//
// 依存はこのパッケージ自身と Node 組み込みのみ（pbf / pako は geopbf の既存依存）。
// Worker と DOM を使う src/index.js は通さず、Node でそのまま動く pbf-base / extension/gint を直に叩く。
// ImageData は pbf-base のエンコード経路が参照するが Node に無いので、tests/t-loaders.mjs と同じ手で補う。
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync, deflateSync } from "node:zlib";
import { GeoPBF } from "../src/pbf-base.js";

globalThis.ImageData ??= class ImageData {
	constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};

const USAGE = `geopbf <command>

  enc  <in.geojson> <out.geopbf>   GeoJSON を GeoPBF へ（書き出しは gzip が既定＝配布形の通例）
       [--precision N]             座標に残す小数桁（1-9・既定 6 ≒ 0.1m）
       [--no-gzip]                 gzip せず生の GeoPBF を書く
  dec  <in.geopbf>  <out.geojson>  GeoPBF を GeoJSON へ
  info <in.geopbf>                 中身の要約（地物数・頂点数・精度・大きさ）
  lod  <in.geopbf>                 gint のランクを付け、ズーム別に描かれる頂点数を出す
  cog  info <url|file.tif>         COG の構造（寸法・タイル格子・overview・圧縮・CRS・bbox）
       [--bench]                   ヘッダ読み/レンダの実測数字（range 本数・coalesce・デコード時間）
  cog  png  <url|file.tif> <out.png>  COG を PNG に描き出す（Range 直読み・低解像度全景が既定）
       [--level N] [--width N]     overview 段（既定=最粗）と出力幅（既定 768）

  入力の gzip は拡張子によらず署名（1f 8b）で判別して透過的に展開する。
`;

// ── 共通ヘルパ ────────────────────────────────────────────────────────────────

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
	const { pos: [inPath, outPath], opts } = parseArgs(argv, ["precision"]);
	if (!inPath || !outPath) throw new Error("enc <in.geojson> <out.geopbf>");

	const precision = opts.precision === undefined ? undefined : Number(opts.precision);
	if (precision !== undefined && !(Number.isInteger(precision) && precision >= 1 && precision <= 9))
		throw new Error("--precision は 1 から 9 の整数");   // 0 は pbf-base の `precision || 6` が黙って 6 に落とすので範囲外

	const src = await readMaybeGzip(inPath);
	const gj = JSON.parse(Buffer.from(src).toString("utf8"));
	const t = Date.now();
	const pbf = await new GeoPBF({ name: gj.name || "layer", precision }).set(gj);
	const gzip = !opts["no-gzip"];   // GDAL ドライバの COMPRESS=GZIP 既定・配布形に合わせる
	let out = Buffer.from(pbf.arrayBuffer);
	if (gzip) out = gzipSync(out, { level: 9 });
	await writeFile(outPath, out);

	console.log(`${inPath}  ${mb(src.length)}`);
	console.log(`${outPath}  ${mb(out.length)}${gzip ? " (gzip)" : ""}  ${(src.length / out.length).toFixed(1)} 分の 1  ${Date.now() - t} ms`);
}

// ── dec ───────────────────────────────────────────────────────────────────────

async function dec(argv) {
	const { pos: [inPath, outPath] } = parseArgs(argv);
	if (!inPath || !outPath) throw new Error("dec <in.geopbf> <out.geojson>");
	const gj = (await openPbf(inPath)).geojson;
	await writeFile(outPath, JSON.stringify(gj));
	console.log(`${outPath}  features ${num(gj.features.length)}  頂点 ${num(countVertices(gj.features))}`);
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
	console.log(`頂点        ${num(countVertices(gj.features))}`);
	console.log(`geometry    ${[...types].map(([t, n]) => `${t} ${num(n)}`).join("  ")}`);
	console.log(`precision   ${pbf.precision()}  （${(1 / Math.pow(10, pbf.precision()) * 111320).toFixed(2)} m 相当）`);
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
	const t = Date.now();
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
	if (!total) { console.log("頂点がない"); return; }

	console.log(`頂点 ${num(total)}（うち L1 ${num(l1)}）  ランク付け ${Date.now() - t} ms  gint ${mb(total * 8)}（8 byte/頂点）\n`);
	console.log("  z  threshold      描画頂点   残存率");
	for (const z of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 21]) {
		const th = Math.max(0, (21 - z) * 3);
		let keep = l1;
		for (let r = th; r < 64; r++) keep += hist[r];
		const pct = keep / total * 100;
		console.log(`  ${String(z).padStart(2)}  ${String(th).padStart(3)}  ${num(keep).padStart(12)}   ${pct.toFixed(1).padStart(5)}%  ${"#".repeat(Math.round(pct / 2.5))}`);
	}
	console.log("\n位相解析なし＝L1 はリングの端点のみ。共有境界の頂点は L1 に立たない。");
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
			console.log(`--bench     TTFH ${m.ttfhMs.toFixed(0)} ms・全景${W}px ${Date.now() - dt} ms・` +
				`range ${m.rangeRequests} 本/要求 ${m.coalescedFrom}（coalesce ${(m.coalescedFrom / Math.max(m.rangeRequests, 1)).toFixed(1)}x）・` +
				`受信 ${mb(m.bytesFetched)}・デコード ${m.tilesDecoded} タイル ${m.decodeMs.toFixed(0)} ms`);
		}
		return;
	}
	if (sub === "png") {
		if (!outPath) throw new Error("cog png <url|file.tif> <out.png>");
		const level = opts.level !== undefined ? +opts.level : c.overviews.length - 1;
		const [w, s, e, n] = c.bboxLL;
		const W = opts.width ? +opts.width : 768, H = Math.max(16, Math.round(W * (n - s) / (e - w)));
		const rgba = await c.render(lonlatTarget([w, s, e, n], W, H), { level });
		if (!rgba) throw new Error("cog png: 範囲外（レンダ結果が空）");
		await writeFile(outPath, encodePNG(rgba, W, H));
		console.log(`${outPath}  ${W} x ${H}  level ${level}/${c.overviews.length - 1}  ${Date.now() - t0} ms`);
		return;
	}
	throw new Error(`cog: 知らないサブコマンド "${sub}"`);
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

// ── entry ─────────────────────────────────────────────────────────────────────

const [cmd, ...argv] = process.argv.slice(2);
const commands = { enc, dec, info, lod, cog };
if (!cmd || cmd === "--help" || cmd === "-h") { console.log(USAGE); process.exit(0); }
if (!commands[cmd]) { console.error(`geopbf: 知らないコマンド "${cmd}"\n`); console.error(USAGE); process.exit(1); }
try {
	await commands[cmd](argv);
} catch (e) {
	console.error(`geopbf ${cmd}: ${e.message}`);
	process.exit(1);
}
