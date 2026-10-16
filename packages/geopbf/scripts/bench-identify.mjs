// 描画レス識別（identifyAt＝点→線→面・findPolygon の内包判定）の node の計り。
// 使い方：node packages/geopbf/scripts/bench-identify.mjs [--n 格子の辺] [--queries N] [--hash] [--src <identify.ts のパス>]
//   見本＝合成の格子（N×N の隣り合う四角形・辺ごとに 64 点の揺らぎ＝頂点の多い面）＋線。問い合わせ＝種固定の乱数の点。
//   --hash＝答え（fid の列）の FNV 指紋＝最適化の前後で同じ答えかを確かめる。--src＝比べたい別の版の identify.ts
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
globalThis.ImageData ??= class ImageData { };
const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? +args[args.indexOf(k) + 1] : d);
const N = arg("--n", 40), Q = arg("--queries", 20000), wantHash = args.includes("--hash");
const src = args.includes("--src") ? path.resolve(args[args.indexOf("--src") + 1]) : path.join(DIR, "../src/extension/identify.ts");
const { GeoPBFBase } = await import("../src/pbf-base.ts");
const { topology, unPackGintBuffer } = await import("../src/extension/topology.ts");
const { gint } = await import("../src/extension/gint.ts");
const { identifyAt } = await import(pathToFileURL(src).href);
{
	const wasmJs = path.join(DIR, "../wasm/pkg/gint_wasm.js");
	const mod = await import(pathToFileURL(wasmJs).href);
	await mod.default({ module_or_path: readFileSync(wasmJs.replace(/\.js$/, "_bg.wasm")) });
	await gint.initialize();
}
const SUB = 64, x0 = 139, y0 = 35, w = 1 / N;
const wig = (a, b, k) => Math.sin(a * 12.9898 + b * 78.233 + k * 3.7) * w * 0.05;
const edgeH = (i, j) => Array.from({ length: SUB }, (_, k) => [x0 + (i + k / SUB) * w, y0 + j * w + (k ? wig(i, j, k) : 0)]);
const edgeV = (i, j) => Array.from({ length: SUB }, (_, k) => [x0 + i * w + (k ? wig(j, i + 999, k) : 0), y0 + (j + k / SUB) * w]);
const features = [];
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
	const top = edgeH(i, j + 1).concat([[x0 + (i + 1) * w, y0 + (j + 1) * w]]).reverse().slice(0, SUB);
	const left = edgeV(i, j).concat([[x0 + i * w, y0 + (j + 1) * w]]).reverse().slice(0, SUB);
	const r = [...edgeH(i, j), ...edgeV(i + 1, j), ...top, ...left]; r.push(r[0]);
	features.push({ type: "Feature", properties: { id: i * N + j }, geometry: { type: "Polygon", coordinates: [r] } });
}
for (let j = 0; j < N; j += 4) features.push({ type: "Feature", properties: { line: j }, geometry: { type: "LineString", coordinates: Array.from({ length: 400 }, (_, k) => [x0 + k / 400, y0 + (j + 0.37) * w + Math.sin(k) * w * 0.1]) } });
const p = await new GeoPBFBase({ name: "bench-identify" }).set({ type: "FeatureCollection", features });
const self = { unPackGint: unPackGintBuffer(topology(p)) };
let seed = 11; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const qs = Array.from({ length: Q }, () => [x0 - 0.02 + rnd() * 1.04, y0 - 0.02 + rnd() * 1.04]);
const run = () => qs.map(([lng, lat]) => identifyAt(self, lng, lat, { line: 30, point: 30 }) ?? -1);
run();
const ts = []; let ans;
for (let r = 0; r < 5; r++) { const t0 = process.hrtime.bigint(); ans = run(); ts.push(Number(process.hrtime.bigint() - t0) / 1e6); }
ts.sort((a, b) => a - b);
let h = 2166136261; for (const f of ans) { h ^= f & 0xff; h = Math.imul(h, 16777619) >>> 0; h ^= f >>> 8; h = Math.imul(h, 16777619) >>> 0; }
console.log(`grid ${N}²×${SUB * 4} vertices/polygon + ${Math.ceil(N / 4)} lines: ${Q} queries ${ts[2].toFixed(1)}ms (${(ts[2] / Q * 1000).toFixed(1)}µs/query, hits ${ans.filter(f => f >= 0).length})${wantHash ? `  hash ${h.toString(16)}` : ""}`);
