#!/usr/bin/env node
// scripts/lod-calibration-report.mjs ── 描画側 LOD を tiler の DP 較正（calibrate.js）に揃える価値を、データで測る（geopbf 改良点 12・2026-10-12）。
//   描画（ortho-core drawdata.js）は固定則 rank ≥ 63 − 3z（1px 未満を捨てる）で頂点を間引く。tiler は arc ごとに DP（tippecanoe -S）の予算へ
//   較正した閾値表 t(arc, z) を使う。描画をその表に揃えるには「頂点 → arc」の表（u16/u32 per vertex）と層ごとの t 表が要る。
//   この台本は各戦略が DP の予算（want＝DP が残す頂点数・arc ごと）にどれだけ近いかを、kept 集合の L1 誤差（Σ|kept − want| / Σwant）で出す:
//     fixed  ＝描画の固定則 / constD＝arc ごとの定数オフセット（1 byte/頂点で載る案） / lin＝ズームに線形のオフセット / table＝tiler の表そのもの
//   使い方: node scripts/lod-calibration-report.mjs <file.geopbf|.fgb|.geojson> [minZoom=0] [maxZoom=14]
//   結果の台帳: lod-calibration-2026-10-12.md（pop-density-2020・countries・topp_states）
import { readFileSync } from "node:fs";
import { GeoPBF } from "../src/pbf-base.ts";
import { fromFlatGeobuf } from "../src/convert/fgb.ts";
import { bakeGint } from "../src/convert/node-gint.ts";
import { prepareTiling } from "../src/convert/tiler.ts";
import { fileURLToPath } from "node:url";

export async function lodCalibrationReport(file, { minZoom = 0, maxZoom = 14, extentShift = 12 } = {}) {
let pbf;
if (file.endsWith(".fgb")) { const { pbf: p0 } = await fromFlatGeobuf(new Uint8Array(readFileSync(file)), { ignoreCrs: true }); pbf = await new GeoPBF().set(p0.arrayBuffer); }
else if (file.endsWith(".geojson")) pbf = await new GeoPBF({ precision: 7 }).set(JSON.parse(readFileSync(file, "utf8")));
else pbf = await new GeoPBF().set(readFileSync(file).buffer);
const gint = await bakeGint(pbf);
const P = await prepareTiling(pbf, { gint, gpu: false, workers: 0, minZoom, maxZoom });
const { A, arcs, params, d, proj } = P; const K = params.zoomCount, T = params.arcThresholds, fixed = params.thresholds;
const { xy, rk } = proj;
function dpImportance(xy, off, n, eps) {
	eps[0] = Infinity; eps[n - 1] = Infinity; if (n <= 2) return;
	const stack = [0, n - 1, Infinity];
	while (stack.length) { const pe = stack.pop(), j = stack.pop(), i = stack.pop(); if (j - i < 2) continue;
		const ax = xy[(off + i) * 2], ay = xy[(off + i) * 2 + 1], dx = xy[(off + j) * 2] - ax, dy = xy[(off + j) * 2 + 1] - ay, l2 = dx * dx + dy * dy;
		let best = -1, bd = -1;
		for (let k = i + 1; k < j; k++) { const px = xy[(off + k) * 2] - ax, py = xy[(off + k) * 2 + 1] - ay; let dd; if (l2 === 0) dd = px * px + py * py; else { let u = (px * dx + py * dy) / l2; u = u < 0 ? 0 : u > 1 ? 1 : u; const ex = px - u * dx, ey = py - u * dy; dd = ex * ex + ey * ey; } if (dd > bd) { bd = dd; best = k; } }
		const e = Math.min(pe, Math.sqrt(bd)); eps[best] = e; stack.push(i, best, e, best, j, e); }
}
const tol = new Float64Array(K); for (let k = 0; k < K; k++) { const sh = 32 - (minZoom + k) - extentShift; tol[k] = sh >= 0 ? Math.pow(2, sh) : 1 / Math.pow(2, -sh); }
const cum = new Int32Array(65); let eps = new Float64Array(4096);
const err = { fixed: new Float64Array(K), constD: new Float64Array(K), lin: new Float64Array(K), table: new Float64Array(K) }, wantK = new Float64Array(K), keptFixed = new Float64Array(K);
let active = 0, deltas = [];
for (let a = 0; a < d.arcCount; a++) {
	const off = arcs[a * 2], n = arcs[a * 2 + 1]; if (n < 4) continue;
	if (n > eps.length) eps = new Float64Array(n * 2);
	dpImportance(xy, off, n, eps);
	cum.fill(0); for (let i = 0; i < n; i++) cum[rk[off + i]]++; for (let t = 63; t >= 0; t--) cum[t] += cum[t + 1];
	const want = new Int32Array(K); for (let k = 0; k < K; k++) { let w = 0; for (let i = 0; i < n; i++) if (eps[i] > tol[k]) w++; want[k] = w; }
	// arc 定数 delta＝「DP が全部を欲しがらない」ズームでの (t - fixed) の中央値
	const dl = [], ks = []; for (let k = 0; k < K; k++) if (want[k] < n && T[k * A + a] > 0) { dl.push(T[k * A + a] - fixed[k]); ks.push(k); }
	let delta = 0, slope = 0, mk = 0;
	if (dl.length) { const s = [...dl].sort((x, y) => x - y); delta = s[s.length >> 1]; active++; deltas.push(delta);
		mk = ks.reduce((x, y) => x + y, 0) / ks.length; const mean = dl.reduce((x, y) => x + y, 0) / dl.length; let sxy = 0, sxx = 0; for (let i = 0; i < dl.length; i++) { sxy += (ks[i] - mk) * (dl[i] - mean); sxx += (ks[i] - mk) ** 2; } slope = sxx ? sxy / sxx : 0; delta = mean; }
	for (let k = 0; k < K; k++) {
		const w = want[k]; wantK[k] += w;
		const kf = cum[fixed[k]]; keptFixed[k] += kf;
		const tc = Math.max(0, Math.min(63, Math.round(fixed[k] + delta))), tl = Math.max(0, Math.min(63, Math.round(fixed[k] + delta + slope * (k - mk))));
		err.fixed[k] += Math.abs(kf - w); err.constD[k] += Math.abs(cum[tc] - w); err.lin[k] += Math.abs(cum[tl] - w); err.table[k] += Math.abs(cum[T[k * A + a]] - w);
	}
}
deltas.sort((x, y) => x - y);
const K2 = K;
const rel = Object.fromEntries(Object.entries(err).map(([k, e]) => [k, Array.from(e, (v, i) => wantK[i] ? v / wantK[i] : 0)]));
return { file, features: pbf.length, arcs: d.arcCount, vertices: P.stats.vertices, calibrateMs: P.stats.ms.calibrate ?? 0, active, deltas, minZoom, K: K2, want: Array.from(wantK), keptFixed: Array.from(keptFixed), err: rel };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
const file = process.argv[2]; if (!file) { console.error("usage: node scripts/lod-calibration-report.mjs <file> [minZoom] [maxZoom]"); process.exit(1); }
const r = await lodCalibrationReport(file, { minZoom: +(process.argv[3] ?? 0), maxZoom: +(process.argv[4] ?? 14) });
const { deltas, K, minZoom, want: wantK, keptFixed, err } = r;
console.log(`${file.split("/").pop()}: features ${r.features} arcs ${r.arcs} vertices ${r.vertices}; calibrate ${r.calibrateMs.toFixed(0)} ms (cpu); arcs with a non-trivial regime ${r.active}; per-arc delta median ${deltas[deltas.length >> 1]} p10 ${deltas[Math.floor(deltas.length * 0.1)]} p90 ${deltas[Math.floor(deltas.length * 0.9)]}`);
console.log("z     : " + Array.from({ length: K }, (_, k) => String(minZoom + k).padStart(6)).join(""));
console.log("want  : " + Array.from(wantK, v => String(Math.round(v)).padStart(6)).join(""));
console.log("fixed : " + Array.from(keptFixed, v => String(Math.round(v)).padStart(6)).join(""));
for (const [name, e] of Object.entries(err)) console.log(`L1 ${name.padEnd(6)}: ` + e.map(v => (100 * v).toFixed(0) + "%").map(v => v.padStart(6)).join(""));
}
