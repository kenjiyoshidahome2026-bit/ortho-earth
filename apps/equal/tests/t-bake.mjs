// GintBUF → 描画用配列の焼きの検定（LOD 段・縫い目の除外・向きの正規化・隣接・輪郭の分類）
// GintBUF は geopbf の gint.pack と同じ Morton 詰めで手組み（ここに複製＝geopbf の wasm/worker を Node で起こさない）
import assert from "node:assert/strict";
import { bakeLayer, bakeGraticule } from "../src/bake.js";
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const spread16 = x => { x &= 0xFFFF; x = (x | (x << 8)) & 0x00FF00FF; x = (x | (x << 4)) & 0x0F0F0F0F; x = (x | (x << 2)) & 0x33333333; x = (x | (x << 1)) & 0x55555555; return x >>> 0; };
const morton = (ix, iy) => { const xl = spread16(ix & 0xFFFF), xh = spread16(ix >>> 16), yl = spread16(iy & 0xFFFF), yh = spread16(iy >>> 16); return (BigInt((xh | (yh << 1)) >>> 0) << 32n) | BigInt((xl | (yl << 1)) >>> 0); };
// term＝終端（rank 63）／それ以外は座標を 8 の倍数に丸めて下位 6bit に rank
const V = (lon, lat, rank = 63) => { const ix = Math.round((lon + 180) * 1e7), iy = Math.round((lat + 90) * 1e7); return rank >= 63 ? morton(ix, iy) | (1n << 63n) : (morton(ix & ~7, iy & ~7) & ~0x3Fn) | BigInt(rank); };

// 2 つの正方形 A=(0..10) と B=(10..20) が辺 (10,0)-(10,10) を共有。B の外環は時計回り（正規化の対象）。
// arc0: (10,10)→(0,10)→(0,0)→(10,0) に中点（rank 10）を 1 つ挟む／arc1: 共有辺／arc2: B 側／arc3: 縫い目（lon=-180 上の 2 点）
const arcs = [
	[V(10, 10), V(5, 10, 10), V(0, 10), V(0, 0), V(10, 0)],
	[V(10, 0), V(10, 10)],
	[V(10, 10), V(20, 10), V(20, 0), V(10, 0)],
	[V(-180, 0), V(-180, 10)],
];
const arcBuffer = BigUint64Array.from(arcs.flat());
const arcMeta = new Uint32Array(arcs.length * 8); let off = 0; arcs.forEach((a, i) => { arcMeta[i * 8] = off; arcMeta[i * 8 + 1] = a.length; off += a.length; });
// polyStream: fid, nRings, [arcCount, arcs…]。B は a2, ~a1（時計回り）。fid 2＝縫い目だけの退化した面（辺は artificial）
const polyStream = Int32Array.from([0, 1, 2, 0, 1, /* B */ 1, 1, 2, 2, ~1, /* seam */ 2, 1, 1, 3]);
const pbf = { unPackGint: { arcBuffer, arcMeta, polyStream, lineStream: null, pointBuffer: null, point: null }, getProperties: fid => ({ key: ["A", "B", "S"][fid] }) };

const L = bakeLayer(pbf, { kind: "poly", fill: () => 0, unit: p => ({ A: 0, B: 1, S: 2 })[p.key], outline: (pa, refs, pb) => ({ cls: refs >= 2 ? 1 : 0, minZoom: 0 }) });
ok(L.vertexCount === arcBuffer.length, "頂点数");
// 1) LOD 段：thr=0 は中点を含む・thr=12 で落ちる・辺数は段が粗いほど減り、arc の両端は残る
const t0 = L.tier(0), t12 = L.tier(12);
const edges = t => t.lines.length / 3;
ok(edges(t0) === edges(t12) + 1, `中点 1 つが落ちる: ${edges(t0)} → ${edges(t12)}`);
ok(t12.lines.includes(0) && t12.lines.includes(4), "arc0 の両端は残る");
// 2) 縫い目の辺（lon=-180 上の 2 点）は輪郭に出ない
const seamEdges = [...Array(edges(t0))].filter((_, i) => { const a = t0.lines[i * 3], b = t0.lines[i * 3 + 1]; return a >= 13 && b >= 13; });
ok(seamEdges.length === 0, "縫い目の辺を描かない");
// 3) 輪郭の分類：共有辺（arc1）は cls 1・外周は cls 0
const clsOf = (a, b) => { for (let i = 0; i < edges(t0); i++) if (t0.lines[i * 3] === a && t0.lines[i * 3 + 1] === b) return t0.lines[i * 3 + 2] & 255; return -1; };
ok(clsOf(5, 6) === 1 && clsOf(7, 8) === 0, `輪郭の分類 共有=${clsOf(5, 6)} 外周=${clsOf(7, 8)}`);
// 4) 塗り：unit（fid ではなく unit の番号）が packed・B の辺は向きが反転して積まれる（外環＝反時計回り）
const F = t0.fills, fillEdges = F.length / 4;
ok(fillEdges > 0, "塗りの辺");
const unitsSeen = new Set(); for (let i = 0; i < fillEdges; i++) unitsSeen.add(F[i * 4 + 3] & 0xFFFFF);
ok(unitsSeen.has(0) && unitsSeen.has(1), "unit 0/1");
// B の arc2 は元の向き (7→8→9→10) が時計回り＝反転して (8→7) の順で積まれているはず
let flipped = false; for (let i = 0; i < fillEdges; i++) if (F[i * 4] === 8 && F[i * 4 + 1] === 7) flipped = true;
ok(flipped, "時計回りの外環は反転");
// 5) 隣接：A と B は共有 arc で隣
ok(L.neighbors.some(([a, b]) => (a === 0 && b === 1)), `隣接 ${JSON.stringify(L.neighbors)}`);
// 6) include で層を振り分け
const L2 = bakeLayer(pbf, { kind: "poly", include: p => p.key === "A", fill: () => 0 });
ok(L2.tier(0).fills.length < F.length, "include で減る");
// 7) 経緯線
const G = bakeGraticule();
ok(G.tier(0).lines.length > 1000 && G.vertexCount > 1000, "経緯線");
console.log(`t-bake: ${n} ok`);
