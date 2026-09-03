// t-model: 隣接2ポリゴンの共有arc・ノード同時移動・アドレス往復（node tests/t-model.mjs）
import { buildTopology } from "../src/topo-extract.js";
import { createModel } from "../src/model.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const fc = {
	type: "FeatureCollection",
	features: [
		{ type: "Feature", properties: { name: "A" }, geometry: { type: "Polygon", coordinates: [sq(0, 0, 1, 1)] } },
		{ type: "Feature", properties: { name: "B" }, geometry: { type: "Polygon", coordinates: [sq(1, 0, 2, 1)] } },
	],
};

const topo = buildTopology(fc, 6);
ok(topo.arcs.size === 3, `共有辺で arc は3本（実際 ${topo.arcs.size}）`);
const model = createModel(topo);

const sharedId = [...model.arcs.keys()].find(id => model.arcs.get(id).refs.size === 2);
ok(sharedId !== undefined, "refs=2 の共有arcが存在");
const shared = model.arcs.get(sharedId);
ok(shared.pts.length === 4, `共有arcは2頂点（実際 ${shared.pts.length / 2}）`);

// ---- 共有arcの端点（junctionノード）移動＝A/B両方の外周も同時に動く ----
const before = JSON.stringify(model.toGeoJSON());
const ex = shared.pts[0], ey = shared.pts[1];   // 端点の元座標（(1,0) か (1,1)）
model.moveVertex(sharedId, 0, 1.25, ex === 1 && ey === 0 ? -0.25 : 1.25);
const g1 = model.toGeoJSON();
const hasCoord = (f, x, y) => JSON.stringify(f.geometry.coordinates).includes(`[${x},${y}]`);
ok(hasCoord(g1.features[0], 1.25, ey === 0 ? -0.25 : 1.25), "移動が A に反映");
ok(hasCoord(g1.features[1], 1.25, ey === 0 ? -0.25 : 1.25), "移動が B に反映");
ok(!hasCoord(g1.features[0], ex, ey), "A から旧座標が消えた");
ok(!hasCoord(g1.features[1], ex, ey), "B から旧座標が消えた");
// 戻す
model.moveVertex(sharedId, 0, ex, ey);
ok(JSON.stringify(model.toGeoJSON()) === before, "端点を戻すと完全一致");

// ---- 共有arcへの頂点挿入→内部頂点の移動＝両ポリゴンが同形に変形 ----
const ins = model.insertVertex(sharedId, 0, 1, 0.5);
model.moveVertex(ins.arcId, ins.idx, 1.2, 0.5);
const g2 = model.toGeoJSON();
ok(hasCoord(g2.features[0], 1.2, 0.5) && hasCoord(g2.features[1], 1.2, 0.5), "挿入頂点の移動が A/B 両方に出る");
ok(g2.features[0].geometry.coordinates[0].length === 6, `A のリングが1頂点増（実際 ${g2.features[0].geometry.coordinates[0].length}）`);

// ---- 安定アドレス往復 ----
let addrOk = true;
for (const [aid, arc] of model.arcs) {
	const u = arc.pts.length / 2 - (arc.closed ? 1 : 0);
	for (let i = 0; i < u; i++) {
		const addr = model.addrOf(aid, i);
		const r = model.resolveAddr(addr);
		const same = model.arcs.get(r.arcId).pts[r.idx * 2] === arc.pts[i * 2] && model.arcs.get(r.arcId).pts[r.idx * 2 + 1] === arc.pts[i * 2 + 1];
		if (!same) { addrOk = false; console.error(`  addr不一致 arc${aid}[${i}] →`, addr, "→", r); }
	}
}
ok(addrOk, "addrOf ⇄ resolveAddr が全頂点で座標一致");

// ---- 孤立リング（junction無し）＝閉arc1本・末尾/先頭の同時書換 ----
const topo2 = buildTopology({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [sq(10, 10, 11, 11)] } }] }, 6);
const m2 = createModel(topo2);
ok(m2.arcs.size === 1 && [...m2.arcs.values()][0].closed, "孤立リング＝閉arc1本");
const aid2 = [...m2.arcs.keys()][0];
m2.moveVertex(aid2, 0, 10.5, 9.5);
const ring2 = m2.toGeoJSON().features[0].geometry.coordinates[0];
ok(JSON.stringify(ring2[0]) === JSON.stringify(ring2[ring2.length - 1]), "閉リングの先頭=末尾が維持される");

// ---- 穴（内環）：追加＝外環と逆回りに正規化・undo（unhole）で元どおり ----
const mh = createModel(buildTopology(fc, 6));
const sh = r => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
const holeCmd = { op: "hole", eid: 0, ring: [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6], [0.2, 0.2]] };
mh.applyCmd(holeCmd);
{
	const rings = mh.toGeoJSON().features[0].geometry.coordinates;
	ok(rings.length === 2, `穴追加でリング2本（実際 ${rings.length}）`);
	ok((sh(rings[0].slice(0, -1)) > 0) !== (sh(rings[1].slice(0, -1)) > 0), "穴は外環と逆回り（winding塗りの条件）");
}
mh.applyCmd(mh.invertCmd(holeCmd));
ok(mh.toGeoJSON().features[0].geometry.coordinates.length === 1, "unhole で外環だけに戻る");
mh.applyCmd(holeCmd);   // redo 相当
ok(mh.toGeoJSON().features[0].geometry.coordinates.length === 2, "hole の再適用（redo）も通る");


// ---- 退化ガードは環単位：正方形と辺を共有する三角形（＝共有arc2点＋自前の開arc3点）の頂点は消せない ----
{
	const fc2 = { type: "FeatureCollection", features: [
		{ type: "Feature", properties: { n: "A" }, geometry: { type: "Polygon", coordinates: [sq(0, 0, 1, 1)] } },
		{ type: "Feature", properties: { n: "T" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [0.5, -1], [0, 0]]] } },
	] };
	const mdl = createModel(buildTopology(fc2, 6));
	const tri = mdl.feats.get(1);
	const own = [...mdl.arcs.entries()].find(([, a]) => a.refs.size === 1 && a.refs.has(1));   // 三角形だけの開arc（3点）
	ok(own && own[1].pts.length / 2 === 3 && !own[1].closed, "三角形の自前arc＝開3点（共有辺は別arc）");
	const res = mdl.applyCmd({ op: "delete", addr: mdl.addrOf(own[0], 1) });
	ok(res == null, "3頂点の環の頂点削除は拒否（環単位の退化ガード）");
	ok(mdl.featureGeoJSON(1, false).geometry.coordinates[0].length === 4, "三角形は無傷（3頂点＋閉）");
	// 4頂点にしてからなら消せる
	const ins = { op: "insert", addr: mdl.addrOf(own[0], 0), ll: [0.9, -0.4] };
	ok(!!mdl.applyCmd(ins), "頂点挿入");
	ok(!!mdl.applyCmd({ op: "delete", addr: ins.addrNew }), "4頂点の環なら削除できる");
	ok(mdl.featureGeoJSON(1, false).geometry.coordinates[0].length === 4 && tri, "削除後も3頂点で閉じている");
}

process.exit(fails ? 1 : 0);