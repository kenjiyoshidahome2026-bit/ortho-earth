// 普通の LAS/LAZ の八分木（src/pointcloud-octree.js・点群計画 段 3-3）の検定。node packages/globe/tests/t-pointcloud-octree.mjs
//  ① 全点がちょうど 1 回ずつどこかの節に入る・節の点は節の範囲の内・1 節の点は升の数まで（子を作った節）
//  ② 足し算の形＝親の無い節が無い・根の点は全体に散る（粗い見本）
//  ③ 重なった点（全部同じ所）も止まる・上限の判定
import assert from "node:assert/strict";
import { createStore, appendRaw, buildOctree, gatherNode, wholeFileLimit, G, MIN_SPLIT, LIMIT_POINTS } from "../src/pointcloud-octree.ts";
import { nodeBounds } from "@ortho-earth/tile-formats/las";

let tn = 0;
const t = (name, fn) => { fn(); tn++; console.log("  ✔", name); };
let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
// 起伏のある地面（1 km 四方・1 cm 単位の整数）＝面の点群
function terrain(n) {
	const X = new Int32Array(n), Y = new Int32Array(n), Z = new Int32Array(n);
	for (let i = 0; i < n; i++) { const x = rnd() * 1000, y = rnd() * 1000; X[i] = Math.round(x * 100); Y[i] = Math.round(y * 100); Z[i] = Math.round((50 + 20 * Math.sin(x / 90) * Math.cos(y / 70)) * 100); }
	return { X, Y, Z, intensity: new Uint16Array(n).fill(7), classification: new Uint8Array(n).fill(2), rgb: null };
}
function make(r, n, batches = 3) {
	const s = createStore(n, { rgb: false, scale: [0.01, 0.01, 0.01], offset: [-30000, -120000, 0] });
	const step = Math.ceil(n / batches);
	for (let a = 0; a < n; a += step) { const k = Math.min(step, n - a), sub = {}; for (const key of ["X", "Y", "Z", "intensity", "classification"]) sub[key] = r[key].subarray(a, a + k); sub.rgb = null; appendRaw(s, sub, k); }
	return s;
}

t("全点が 1 回ずつ・節の範囲の内・升の数まで", () => {
	const n = 300000, s = make(terrain(n), n), { info, nodes, idx } = buildOctree(s, { random: rnd });
	assert.equal(s.at, n);
	assert.ok(Math.abs(s.min[0] - -30000) < 1 && s.max[0] - s.min[0] > 999, `x range ${s.min[0]}..${s.max[0]}`);
	const seen = new Uint8Array(n);
	let total = 0;
	for (const nd of nodes) {
		const b = nodeBounds(info, nd.key), r = gatherNode(s, idx, nd.start, nd.count), eps = 1e-6;
		for (let i = 0; i < nd.count; i++) {
			seen[idx[nd.start + i]]++;
			assert.ok(r.x[i] >= b[0] - eps && r.x[i] <= b[3] + eps && r.y[i] >= b[1] - eps && r.y[i] <= b[4] + eps && r.z[i] >= b[2] - eps && r.z[i] <= b[5] + eps, `node ${nd.key} point ${i} outside`);
		}
		total += nd.count;
	}
	assert.equal(total, n);
	assert.ok(seen.every(v => v === 1), "every point exactly once");
	const keys = new Set(nodes.map(nd => nd.key.join("-")));
	for (const nd of nodes) {
		const [d, x, y, z] = nd.key;
		if (d) assert.ok(keys.has([d - 1, x >> 1, y >> 1, z >> 1].join("-")), `parent of ${nd.key}`);
		const hasChild = nodes.some(c => c.key[0] === d + 1 && c.key[1] >> 1 === x && c.key[2] >> 1 === y && c.key[3] >> 1 === z);
		if (hasChild) assert.ok(nd.count <= G * G * G, "split node holds at most one point per cell");
	}
	assert.ok(Math.abs(info.spacing - info.halfsize * 2 / G) < 1e-9);
	console.log(`     ${nodes.length} nodes, root ${nodes.find(nd => nd.key[0] === 0).count} pts, depth ${Math.max(...nodes.map(nd => nd.key[0]))}`);
});

t("根の点は全体に散る（粗い見本）", () => {
	const n = 200000, s = make(terrain(n), n), { nodes, idx } = buildOctree(s, { random: rnd });
	const root = nodes.find(nd => nd.key[0] === 0), r = gatherNode(s, idx, root.start, root.count), q = [0, 0, 0, 0];
	for (let i = 0; i < root.count; i++) q[(r.x[i] > -29500 ? 1 : 0) + (r.y[i] > -119500 ? 2 : 0)]++;
	assert.ok(root.count > 5000, `root ${root.count}`);
	for (const v of q) assert.ok(v > root.count * 0.2, `quadrants ${q}`);
});

t("同じ所に重なった点も止まる", () => {
	const n = 5000, r = { X: new Int32Array(n).fill(5), Y: new Int32Array(n).fill(5), Z: new Int32Array(n).fill(5), intensity: new Uint16Array(n), classification: new Uint8Array(n), rgb: null };
	const s = make(r, n, 1), { nodes } = buildOctree(s, { random: rnd });
	assert.equal(nodes.reduce((a, nd) => a + nd.count, 0), n);
	assert.ok(nodes.length < 40, `${nodes.length} nodes`);
	assert.ok(MIN_SPLIT > 1);
});

t("丸ごと読みの上限", () => {
	assert.equal(wholeFileLimit({ count: 1e6, size: 4e7, local: false }), null);
	assert.match(wholeFileLimit({ count: LIMIT_POINTS + 1, size: 1e6, local: true }), /20,000,000 limit.*COPC/);
	assert.match(wholeFileLimit({ count: 1e6, size: 600 * 1048576, local: false }), /500 MB limit/);
	assert.equal(wholeFileLimit({ count: 1e6, size: 600 * 1048576, local: true }), null);
});
console.log(`t-pointcloud-octree: ${tn} passed`);
