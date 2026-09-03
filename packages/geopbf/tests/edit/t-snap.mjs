// t-snap v2: 格子量子化による共有化（e-3/e-7）＋ Morton基底/追記ジャーナル索引の意味論
//   ・座標は deref（モデル現在値）＝移動は追記1件で旧掲載が自然失効・削除は何もしなくても失効
//   ・基底（buildBase→setBase）とジャーナル（addRef）の両経路・±180継ぎ目・setGrid再構築
import { buildTopology } from "../../src/edit/topo-extract.js";
import { createSnapIndex, buildBase, normLon } from "../../src/edit/snap.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// ---- 格子量子化による共有化（従来どおり）----
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const fc = {
	type: "FeatureCollection",
	features: [
		{ type: "Feature", properties: { n: "A" }, geometry: { type: "Polygon", coordinates: [sq(0, 0, 1, 1)] } },
		{ type: "Feature", properties: { n: "B" }, geometry: { type: "Polygon", coordinates: [sq(1.0004, 0, 2, 1)] } },
	],
};
ok(buildTopology(fc, 3).arcs.size === 3, "格子1e-3＝量子化で辺共有（arc3本）");
ok(buildTopology(fc, 7).arcs.size === 2, "格子1e-7＝独立のまま（孤立閉arc2本）");

// ---- v2 索引：疑似モデル（deref が現在値を返す）----
const store = new Map();   // "a,b" → [x,y] | null
const key = (a, b) => a + "," + b;
const deref = (a, b) => store.get(key(a, b)) ?? null;
const put = (a, b, x, y) => store.set(key(a, b), [x, y]);
function* refs() { for (const [k, v] of store) if (v) { const [a, b] = k.split(",").map(Number); yield [a, b, v[0], v[1]]; } }

const idx = createSnapIndex(3, deref);
idx.setRefSource(refs);
put(0, 0, 139.0001, 35.0002);
idx.addRef(0, 0, 139.0001, 35.0002);
ok(idx.nearest(139.0009, 35.0005)?.arcId === 0, "1e-3格子＝0.8e-3度差で吸着（ジャーナル）");
ok(idx.nearest(139.003, 35.0005) === null, "1e-3格子＝3e-3度差は吸着しない");
ok(idx.nearest(139.0009, 35.0005, en => en.arcId === 0 && en.idx === 0) === null, "skip で自分自身を除外");

// 移動＝新セルへ追記1件（旧掲載は deref 実座標が遠い＝自然失効）
put(0, 0, 139.5, 35.5);
idx.addRef(0, 0, 139.5, 35.5);
ok(idx.nearest(139.0009, 35.0005) === null, "移動後＝旧位置では拾えない（楽観追記＋実測deref）");
ok(idx.nearest(139.5004, 35.5004)?.arcId === 0, "移動後＝新位置で拾える");

// 削除＝何もしない（deref null で自動失効）
store.set(key(0, 0), null);
ok(idx.nearest(139.5004, 35.5004) === null, "削除＝derefのnullで自動失効（墓標なし）");

// ---- 基底（buildBase → setBase）経路 ----
const store2 = new Map();
const idx2 = createSnapIndex(6, (a, b) => store2.get(key(a, b)) ?? null);
for (let i = 0; i < 100; i++) store2.set(key(7, i), [139 + i * 0.001, 35 + (i % 10) * 0.001]);
idx2.setBase(buildBase(function* () { for (const [k, v] of store2) { const [a, b] = k.split(",").map(Number); yield [a, b, v[0], v[1]]; } }(), 6));
ok(idx2.nearest(139.0500004, 35.0000004)?.idx === 50, `基底（ソート済Morton）から最近傍が引ける`);
ok(idx2.nearest(139.05055, 35.00055) === null, "1e-6格子＝5.5e-4度差は吸着しない");

// ---- ±180 継ぎ目 ----
const idx3 = createSnapIndex(3, (a, b) => (a === 1 && b === 0 ? [179.9999, 0] : null));
idx3.addRef(1, 0, 179.9999, 0);
ok(normLon(180.0001) < -179.99, "normLon が +180 超を負側へ折り返す");
ok(idx3.nearest(-179.9998, 0)?.arcId === 1, "継ぎ目を跨いだ最近傍が引ける");

// ---- setGrid＝refSource から基底焼き直し ----
const store4 = new Map([[key(2, 0), [139.0001, 35.0002]]]);
const idx4 = createSnapIndex(3, (a, b) => store4.get(key(a, b)) ?? null);
idx4.setRefSource(function* () { yield [2, 0, 139.0001, 35.0002]; });
idx4.rebuild();
ok(idx4.nearest(139.0009, 35.0005)?.arcId === 2, "rebuild後＝1e-3で吸着");
idx4.setGrid(7);
ok(idx4.nearest(139.0009, 35.0005) === null, "setGrid(7)＝粗い吸着が消える");
ok(idx4.nearest(139.00010005, 35.00020002)?.arcId === 2, "setGrid(7)＝1e-8差なら吸着");

process.exit(fails ? 1 : 0);
