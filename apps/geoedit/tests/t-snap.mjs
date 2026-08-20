// t-snap: 格子量子化による共有化（e-3で結合/e-7で独立）・空間ハッシュの最近傍・±180継ぎ目
import { buildTopology } from "../src/topo-extract.js";
import { createSnapIndex, normLon } from "../src/snap.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
// B は A の右に「ほぼ」接する（ずれ 4e-4 度）
const fc = {
	type: "FeatureCollection",
	features: [
		{ type: "Feature", properties: { n: "A" }, geometry: { type: "Polygon", coordinates: [sq(0, 0, 1, 1)] } },
		{ type: "Feature", properties: { n: "B" }, geometry: { type: "Polygon", coordinates: [sq(1.0004, 0, 2, 1)] } },
	],
};
const t3 = buildTopology(fc, 3);
ok(t3.arcs.size === 3, `格子1e-3＝量子化で辺共有（arc3本、実際 ${t3.arcs.size}）`);
const t7 = buildTopology(fc, 7);
ok(t7.arcs.size === 2, `格子1e-7＝独立のまま（孤立閉arc2本、実際 ${t7.arcs.size}）`);

// ---- 最近傍スナップ ----
const idx3 = createSnapIndex(3);
const en = { x: 139.0001, y: 35.0002, arcId: 0, idx: 0 };
idx3.add(en);
ok(idx3.nearest(139.0009, 35.0005) === en, "1e-3格子＝0.8e-3度差で吸着");
ok(idx3.nearest(139.003, 35.0005) === null, "1e-3格子＝3e-3度差は吸着しない");
const idx7 = createSnapIndex(7);
idx7.add(en);
ok(idx7.nearest(139.0009, 35.0005) === null, "1e-7格子＝0.8e-3度差は吸着しない");
ok(idx7.nearest(139.00010005, 35.00020002) === en, "1e-7格子＝1e-8度差は吸着");

// skip（ドラッグ中の自分自身の除外）
ok(idx3.nearest(139.0009, 35.0005, e => e === en) === null, "skip で自分自身を除外");

// ---- ±180 継ぎ目 ----
ok(normLon(180.0001) < -179.99, "normLon が +180 超を負側へ折り返す");
const idxSeam = createSnapIndex(3);
const seamEn = { x: 179.9999, y: 0, arcId: 1, idx: 0 };
idxSeam.add(seamEn);
ok(idxSeam.nearest(-179.9998, 0) === seamEn, "継ぎ目を跨いだ最近傍が引ける（179.9999 ↔ -179.9998）");

// ---- 格子切替＝載せ替え ----
idx3.setGrid(7, [en]);
ok(idx3.nearest(139.0009, 35.0005) === null, "setGrid(7) 後は粗い吸着が消える");

process.exit(fails ? 1 : 0);
