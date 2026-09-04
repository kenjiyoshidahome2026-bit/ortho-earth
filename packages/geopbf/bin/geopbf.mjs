#!/usr/bin/env node
// geopbf CLI ── ブラウザを開かずに GeoJSON ⇄ GeoPBF を往復し、gint の効き目を数字で見るための入口。
//
// 依存はこのパッケージ自身と Node 組み込みのみ（pbf / pako は geopbf の既存依存）。
// Worker と DOM を使う src/index.js は通さず、Node でそのまま動く pbf-base / extension/gint を直に叩く。
// ImageData は pbf-base のエンコード経路が参照するが Node に無いので、tests/t-loaders.mjs と同じ手で補う。
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { GeoPBF } from "../src/pbf-base.js";

globalThis.ImageData ??= class ImageData {
	constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};

const USAGE = `geopbf <command>

  enc  <in.geojson> <out.geopbf>   GeoJSON を GeoPBF へ
       [--precision N]             座標に残す小数桁（0-9・既定 6 ≒ 0.1m）
       [--gzip]                    書き出しを gzip する（配布形の通例）
  dec  <in.geopbf>  <out.geojson>  GeoPBF を GeoJSON へ
  info <in.geopbf>                 中身の要約（地物数・頂点数・精度・大きさ）
  lod  <in.geopbf>                 gint のランクを付け、ズーム別に描かれる頂点数を出す

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
	if (precision !== undefined && !(Number.isInteger(precision) && precision >= 0 && precision <= 9))
		throw new Error("--precision は 0 から 9 の整数");

	const src = await readFile(inPath);
	const gj = JSON.parse(src.toString("utf8"));
	const t = Date.now();
	const pbf = await new GeoPBF({ name: gj.name || "layer", precision }).set(gj);
	let out = Buffer.from(pbf.arrayBuffer);
	if (opts.gzip) out = gzipSync(out, { level: 9 });
	await writeFile(outPath, out);

	console.log(`${inPath}  ${mb(src.length)}`);
	console.log(`${outPath}  ${mb(out.length)}${opts.gzip ? " (gzip)" : ""}  ${(src.length / out.length).toFixed(1)} 分の 1  ${Date.now() - t} ms`);
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
	// PRECISION は公開アクセサが無いので内部フィールドを読む（用意されれば差し替える）
	console.log(`precision   ${pbf._precision}  （${(1 / Math.pow(10, pbf._precision) * 111320).toFixed(2)} m 相当）`);
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

// ── entry ─────────────────────────────────────────────────────────────────────

const [cmd, ...argv] = process.argv.slice(2);
const commands = { enc, dec, info, lod };
if (!cmd || cmd === "--help" || cmd === "-h") { console.log(USAGE); process.exit(0); }
if (!commands[cmd]) { console.error(`geopbf: 知らないコマンド "${cmd}"\n`); console.error(USAGE); process.exit(1); }
try {
	await commands[cmd](argv);
} catch (e) {
	console.error(`geopbf ${cmd}: ${e.message}`);
	process.exit(1);
}
