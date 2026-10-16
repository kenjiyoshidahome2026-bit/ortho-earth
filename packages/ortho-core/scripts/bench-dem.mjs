// 外来の標高タイル（dem-src）の node の計り：decodeDEM（RGBA→標高）と cell()（1025² の格子を双線形で引く）。fetch・画像の解読は偽物（GPU・網は要らない）。
// 使い方：node packages/ortho-core/scripts/bench-dem.mjs [--runs N] [--hash] [--src <dem-src のパス>]
//   偽のタイル＝URL の z/x/y から決まる模様（種固定）・一部は 404（海）・α=0 の画素あり。--hash＝出力の FNV 指紋＝最適化の前後でビット同値を確かめる
//   --src＝比べたい別の版の dem-src.ts（例：git show で取り出した旧版）を読む
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const runs = +(args[args.indexOf("--runs") + 1] || 0) || 10, wantHash = args.includes("--hash");
const src = args.includes("--src") ? path.resolve(args[args.indexOf("--src") + 1]) : path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/dem-src.ts");

const N = 256;
const pixels = key => {   // key＝"z/x/y" → RGBA（決定的）
	let s = 0; for (const c of key) s = Math.imul(s ^ c.charCodeAt(0), 16777619) >>> 0;
	const a = new Uint8ClampedArray(N * N * 4);
	for (let i = 0; i < a.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; a[i] = s >>> 24; }
	for (let i = 3; i < a.length; i += 4 * 97) a[i] = 0;   // ところどころ α=0（無効）
	return a;
};
globalThis.fetch = async u => { const key = String(u).replace(/^dem:\/\//, ""); const [, x, y] = key.split("/").map(Number); return (x * 7 + y) % 11 === 0 ? { ok: false } : { ok: true, blob: async () => key }; };
globalThis.createImageBitmap = async key => ({ width: N, height: N, key, close() {} });
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { const cv = this; let cur = null; return { canvas: cv, clearRect() {}, drawImage(b) { cur = b.key; }, getImageData() { return { data: pixels(cur) }; } }; } };

const { decodeDEM, createDemSource } = await import(pathToFileURL(src).href);
const fnv = (h, b) => { const u = new Uint8Array(b.buffer, b.byteOffset, b.byteLength); for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } return h; };
const ms = t => Number(process.hrtime.bigint() - t) / 1e6, med = a => a.sort((p, q) => p - q)[a.length >> 1];

// decodeDEM：4 つの encoding × 16 枚
const rgba = Array.from({ length: 16 }, (_, i) => pixels(`dec/${i}/0`));
const F = { redFactor: 0.3, greenFactor: 2.5, blueFactor: -1.25, baseShift: -7 };
for (const enc of ["terrarium", "mapbox", "gsi", "custom"]) {
	let h = 2166136261; for (const p of rgba) h = fnv(h, decodeDEM(p, enc, F));
	const t = []; for (let r = 0; r < runs; r++) { const t0 = process.hrtime.bigint(); for (const p of rgba) decodeDEM(p, enc, F); t.push(ms(t0)); }
	console.log(`decodeDEM ${enc.padEnd(9)} 16×${N}²  ${med(t).toFixed(2)}ms${wantHash ? `  hash ${h.toString(16)}` : ""}`);
}
// cell()：R01（z12・タイル 180 枚前後）と R10（z9）・範囲の縁（bounds）と経度 180 の縁
for (const [name, spec, lng, lat, range] of [
	["R01 z12", { maxzoom: 12, cellZoom: 12 }, 138, 35, 1],
	["R01 bounds", { maxzoom: 12, cellZoom: 12, bounds: [138.3, 35.2, 140, 36] }, 138, 35, 1],
	["R01 lon179", { maxzoom: 11, cellZoom: 11 }, 179, -18, 1],
	["R10 z9", { maxzoom: 9 }, 130, 30, 10],
]) {
	const s = createDemSource({ tiles: ["dem://{z}/{x}/{y}"], encoding: "terrarium", ...spec });
	const c0 = await s.cell(lng, lat, range);   // 温め＋タイルの読み込み（在庫に載る）
	const t = []; let c = c0;
	for (let r = 0; r < runs; r++) { const t0 = process.hrtime.bigint(); c = await s.cell(lng, lat, range); t.push(ms(t0)); }
	console.log(`cell ${name.padEnd(10)} ${c ? `${c.width}² valid ${(c.valid * 100).toFixed(1)}%` : "null"}  ${med(t).toFixed(1)}ms${wantHash && c ? `  hash ${fnv(2166136261, c.data).toString(16)}` : ""}`);
}
