// Parquet の DELTA_BINARY_PACKED（INT32／INT64）の解読の node の計り。
// 使い方：node packages/geopbf/scripts/bench-parquet-delta.mjs [--runs N] [--hash] [--src <parquet-read.ts のパス>]
//   見本＝合成の列（種固定）100 万値・bit 幅 1〜20 と 25〜32 と 33〜40 の 3 通り。--hash＝出力の FNV 指紋＝最適化の前後でビット同値を確かめる
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const runs = +(args[args.indexOf("--runs") + 1] || 0) || 7, wantHash = args.includes("--hash");
const src = args.includes("--src") ? path.resolve(args[args.indexOf("--src") + 1]) : path.join(DIR, "../src/convert/parquet-read.ts");
const { decodeDeltaBinaryPacked } = await import(pathToFileURL(src).href);

let seed = 5; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const uv = (a, v) => { do { let b = Number(v & 127n); v >>= 7n; if (v) b |= 128; a.push(b); } while (v); };
const zz = (a, v) => uv(a, BigInt.asUintN(64, (v << 1n) ^ (v >> 63n)));
const column = (N, wMin, wMax) => {   // block 128・miniblock 4（parquet-mr の既定）
	const a = []; uv(a, 128n); uv(a, 4n); uv(a, BigInt(N)); zz(a, 12345n);
	for (let left = N - 1; left > 0;) {
		zz(a, -3n); const ws = Array.from({ length: 4 }, () => wMin + (rnd() * (wMax - wMin + 1) | 0)); a.push(...ws);
		for (let m = 0; m < 4 && left > 0; m++) { for (let k = 0; k < 32 * ws[m] / 8; k++) a.push(rnd() * 256 | 0); left -= Math.min(32, left); }
	}
	return new Uint8Array(a);
};
const fnv = (h, b) => { const u = new Uint8Array(b.buffer, b.byteOffset, b.byteLength); for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } return h; };
const N = 1 << 20;
for (const [wMin, wMax] of [[1, 20], [25, 32], [33, 40]]) {
	const u8 = column(N, wMin, wMax);
	for (const type of [1, 2]) {
		let r = decodeDeltaBinaryPacked(u8, 0, N, type);
		const t = []; for (let i = 0; i < runs; i++) { const t0 = process.hrtime.bigint(); r = decodeDeltaBinaryPacked(u8, 0, N, type); t.push(Number(process.hrtime.bigint() - t0) / 1e6); }
		t.sort((a, b) => a - b);
		const h = wantHash ? fnv(2166136261, type === 1 ? r.out : new Float64Array(r.out)) : 0;
		console.log(`${type === 1 ? "INT32" : "INT64"} width ${wMin}-${wMax}: ${N} values ${t[t.length >> 1].toFixed(1)}ms${wantHash ? `  hash ${h.toString(16)} pos ${r.pos}` : ""}`);
	}
}
