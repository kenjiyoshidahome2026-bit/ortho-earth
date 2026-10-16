// メッシュの後段（finishMesh＝重複三角形の除去→接地→LOD 焼き→RTE→溶接）の node の計り（GPU は要らない）。
// 使い方：node packages/globe/scripts/bench-mesh.mjs [--runs N] [--buildings N] [--hash]
//   見本＝合成の街（箱の建物・面ごとに別頂点＝PLATEAU の nusamai 出力の形・両面出力の重複 30%）。乱数は種固定＝毎回同じ入力
//   --hash＝出力（MeshOut の typed array と数）の FNV 指紋＝最適化の前後でビット同値を確かめる
import { finishMesh } from "../src/meshdecode.ts";

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? +args[args.indexOf(k) + 1] : d);
const runs = arg("--runs", 10), B = arg("--buildings", 30000), wantHash = args.includes("--hash");

let seed = 3;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const geo = [], idx = [];
for (let b = 0; b < B; b++) {
	const x = 2.38 + rnd() * 3e-4, y = 0.61 + rnd() * 3e-4, w = 2e-7 + rnd() * 2e-6, h = 3 + rnd() * 40, base = rnd() * 3;
	const c = [[x, y], [x + w, y], [x + w, y + w], [x, y + w]];
	const face = pts => { const o = geo.length / 3; for (const p of pts) geo.push(p[0], p[1], p[2]); idx.push(o, o + 1, o + 2, o, o + 2, o + 3); if (rnd() < 0.3) idx.push(o, o + 2, o + 1, o, o + 3, o + 2); };
	for (let k = 0; k < 4; k++) { const a = c[k], d = c[(k + 1) % 4]; face([[...a, base], [...d, base], [...d, base + h], [...a, base + h]]); }
	face(c.map(p => [...p, base + h]));
}
const G = new Float64Array(geo), I = new Uint32Array(idx), N = new Int8Array(G.length / 3 * 4);

const fnv = (h, b) => { const u = new Uint8Array(b.buffer, b.byteOffset, b.byteLength); for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } return h; };
const enc = new TextEncoder();
function hashOut(h, v) {
	if (ArrayBuffer.isView(v)) return fnv(h, v);
	if (Array.isArray(v)) { for (const x of v) h = hashOut(h, x); return h; }
	if (v && typeof v === "object") { for (const k of Object.keys(v).sort()) h = hashOut(fnv(h, enc.encode(k)), v[k]); return h; }
	return fnv(h, enc.encode(String(v)));
}

finishMesh(G.slice(), N.slice(), I.slice(), 0, null, null, false);   // 温め
const ts = [];
let out;
for (let r = 0; r < runs; r++) {
	const g = G.slice(), n = N.slice(), i = I.slice();
	const t0 = process.hrtime.bigint();
	out = finishMesh(g, n, i, 0, null, null, false);
	ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
ts.sort((a, b) => a - b);
console.log(`city: buildings=${B} vertices=${G.length / 3} triangles=${I.length / 3}  finishMesh ${ts[ts.length >> 1].toFixed(1)}ms (median of ${runs})${wantHash ? `  hash ${hashOut(2166136261, out).toString(16)}` : ""}`);
