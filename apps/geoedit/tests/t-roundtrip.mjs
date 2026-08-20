// t-roundtrip: fc → buildTopology → createModel → toGeoJSON がサイクリック一致（リングは回転の自由度あり）
// ＋ Worker転送（topoToTransfer/topoFromTransfer）を挟んでも同一
import { buildTopology } from "../src/topo-extract.js";
import { createModel, topoToTransfer, topoFromTransfer } from "../src/model.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const fc = {
	type: "FeatureCollection",
	features: [
		{ type: "Feature", properties: { n: "A" }, geometry: { type: "Polygon", coordinates: [sq(0, 0, 1, 1)] } },
		{ type: "Feature", properties: { n: "B" }, geometry: { type: "Polygon", coordinates: [sq(1, 0, 2, 1)] } },
		{ type: "Feature", properties: { n: "iso", "@fill": "#a04040" }, geometry: { type: "Polygon", coordinates: [sq(5, 5, 6, 6), sq(5.2, 5.2, 5.8, 5.8)] } },   // 穴付き孤立
		{ type: "Feature", properties: { n: "L" }, geometry: { type: "LineString", coordinates: [[0, 0], [0.5, -0.5], [1, 0]] } },   // 両端がAの角に一致
		{ type: "Feature", properties: { n: "P", "@icon": "star" }, geometry: { type: "Point", coordinates: [0.5000004, 0.5000004] } },
		{ type: "Feature", properties: { n: "ML" }, geometry: { type: "MultiLineString", coordinates: [[[3, 3], [4, 4]], [[3, 4], [4, 3]]] } },
	],
};

// リング＝回転不変で正規化（向きは保存される前提）。ライン/点はそのまま。
const canonRing = ring => {
	const r = ring.slice(0, -1);
	let best = 0;
	const k = p => p[0] + "," + p[1];
	for (let i = 1; i < r.length; i++) if (k(r[i]) < k(r[best])) best = i;
	return r.slice(best).concat(r.slice(0, best));
};
const canonGeom = g => {
	if (g.type === "Polygon") return g.coordinates.map(canonRing);
	if (g.type === "MultiPolygon") return g.coordinates.map(p => p.map(canonRing));
	return g.coordinates;
};

const E = 1e6;
const q = v => Math.round(v * E) / E;
const qDeep = c => Array.isArray(c[0]) ? c.map(qDeep) : [q(c[0]), q(c[1])];

for (const viaTransfer of [false, true]) {
	let topo = buildTopology(fc, 6);
	if (viaTransfer) {
		const { payload } = topoToTransfer(topo);
		topo = topoFromTransfer(payload);   // 実転送は structured clone＝ここでは同一オブジェクトで代用
	}
	const model = createModel(topo);
	const out = model.toGeoJSON();
	ok(out.features.length === fc.features.length, `[${viaTransfer ? "転送後" : "直接"}] フィーチャ数一致（${out.features.length}）`);
	for (let i = 0; i < fc.features.length; i++) {
		const a = fc.features[i], b = out.features[i];
		const same = JSON.stringify(canonGeom({ type: a.geometry.type, coordinates: qDeep(a.geometry.coordinates) })) ===
			JSON.stringify(canonGeom(b.geometry));
		ok(same, `[${viaTransfer ? "転送後" : "直接"}] ${a.properties.n}: ジオメトリ往復一致`);
		ok(JSON.stringify(a.properties) === JSON.stringify(b.properties), `[${viaTransfer ? "転送後" : "直接"}] ${a.properties.n}: プロパティ往復一致（@キー含む）`);
	}
	// __eid 注入と除去
	const withEid = model.toGeoJSON({ eid: true });
	ok(withEid.features.every((f, i) => f.properties.__eid === i), `[${viaTransfer ? "転送後" : "直接"}] __eid が index 整列`);
	ok(out.features.every(f => !("__eid" in f.properties)), `[${viaTransfer ? "転送後" : "直接"}] 素の出力に __eid が混じらない`);
}

// ラインの端点がポリゴン角と共有される（junction）＝Aの角を動かすとラインも動く
const model = createModel(buildTopology(fc, 6));
ok([...model.arcs.values()].some(a => a.refs.has(3)), "ライン（eid=3）が arc を持つ");
// (0,0) はA外周とライン端の共有ノード：Aの該当arc端点を動かしてラインの端も動くこと
let nodeArcId = null, nodeIdx = null;
for (const [aid, a] of model.arcs) {
	const n = a.pts.length / 2;
	if (a.pts[0] === 0 && a.pts[1] === 0) { nodeArcId = aid; nodeIdx = 0; break; }
	if (a.pts[(n - 1) * 2] === 0 && a.pts[(n - 1) * 2 + 1] === 0) { nodeArcId = aid; nodeIdx = n - 1; break; }
}
ok(nodeArcId !== null, "(0,0) を端点に持つ arc がある");
model.moveVertex(nodeArcId, nodeIdx, -0.3, -0.3);
const after = model.toGeoJSON();
ok(JSON.stringify(after.features[3].geometry.coordinates).includes("[-0.3,-0.3]"), "ノード移動がラインの端点にも波及");
ok(JSON.stringify(after.features[0].geometry.coordinates).includes("[-0.3,-0.3]"), "ノード移動がAの角にも波及");

process.exit(fails ? 1 : 0);
