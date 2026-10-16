// altpbf の decode（src/format.ts）の node の計り。伸長（inflateRaw）と標高の varint 読みに分けて出す。
// 使い方：node packages/altpbf/scripts/bench-decode.mjs [--runs N] [--hash] [--src <format.ts のパス>]
//   見本＝合成の R10 相当（2400²・なだらかな地形＋細かい起伏）と急な地形（差分の多くが 2 バイトの varint）の 2 通り。
//   --hash＝標高の FNV 指紋＝最適化の前後でビット同値を確かめる
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRaw } from "geopbf/gzip";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const runs = +(args[args.indexOf("--runs") + 1] || 0) || 9, wantHash = args.includes("--hash");
const src = args.includes("--src") ? path.resolve(args[args.indexOf("--src") + 1]) : path.join(DIR, "../src/format.ts");
const { encode, decode } = await import(pathToFileURL(src).href);

let seed = 7; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const fnv = (h, b) => { const u = new Uint8Array(b.buffer, b.byteOffset, b.byteLength); for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } return h; };
const med = a => a.sort((p, q) => p - q)[a.length >> 1];
const W = 2400, H = 2400;
for (const [label, amp, noise] of [["gentle", 700, 6], ["steep", 3000, 300]]) {
	const data = new Int16Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = Math.round(800 + amp * Math.sin(x / 140) * Math.cos(y / 170) + 120 * Math.sin((x + 2 * y) / 23) + noise * (rnd() - 0.5));
	const bytes = await encode({ name: "R10N035E139", source: "bench", width: W, height: H, lng: 139, lat: 35, range: 10, data });
	const blob = new Blob([bytes]);
	let out = await decode(blob);
	if (out.data.length !== data.length || out.data.some((v, i) => v !== data[i])) throw new Error(`${label}: decode が元に戻らない`);
	const tAll = [], tInf = [];
	for (let r = 0; r < runs; r++) {
		let t0 = performance.now(); out = await decode(blob); tAll.push(performance.now() - t0);
		t0 = performance.now(); await inflateRaw(await blob.arrayBuffer()); tInf.push(performance.now() - t0);
	}
	const a = med(tAll), f = med(tInf);
	console.log(`${label} ${W}×${H}: deflated ${bytes.length} B  decode ${a.toFixed(1)}ms（うち inflate ≈ ${f.toFixed(1)}ms・varint ≈ ${(a - f).toFixed(1)}ms）` + (wantHash ? `  hash ${fnv(2166136261, out.data).toString(16)}` : ""));
}
