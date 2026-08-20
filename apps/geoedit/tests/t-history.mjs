// t-history: 逆デルタ undo/redo（move/insert/props/add/del）が完全に巻き戻る・進み直せる
import { buildTopology } from "../src/topo-extract.js";
import { createModel, rebuildModel } from "../src/model.js";
import { createHistory } from "../src/history.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const fc = {
	type: "FeatureCollection",
	features: [
		{ type: "Feature", properties: { n: "A" }, geometry: { type: "Polygon", coordinates: [sq(0, 0, 1, 1)] } },
		{ type: "Feature", properties: { n: "B" }, geometry: { type: "Polygon", coordinates: [sq(1, 0, 2, 1)] } },
	],
};
let model = createModel(buildTopology(fc, 6));
const hist = createHistory();
// 構造操作（add/del）の後は controller と同じく再抽出＝共有回復。undo/redo 経由でも同様。
const applyR = c => { model.applyCmd(c); if (c.op === "add" || c.op === "del") model = rebuildModel(model); };
// スナップショットは巡回正規化して比較する：フィーチャ削除の undo（=再追加）は素朴トポロジ
// （孤立閉arc・正規回転）で入るのが設計＝リングの開始点はズレてよく、共有の回復は controller の
// 再抽出の仕事。ここ（純粋モデル試験）は「図形として同一か」を見る。
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
const snap = () => JSON.stringify(model.toGeoJSON().features.map(f => [f.properties, f.geometry.type, canonGeom(f.geometry)]));
const doCmd = cmd => { applyR(cmd); hist.push(cmd); };   // コントローラ相当：cmd を組んで applyCmd 一本＋構造操作後は再抽出
const s0 = snap();

// 1) 頂点移動（共有arc端点＝ノード同時移動）
const sharedId = [...model.arcs.keys()].find(id => model.arcs.get(id).refs.size === 2);
const addr1 = model.addrOf(sharedId, 0);
const from1 = [model.arcs.get(sharedId).pts[0], model.arcs.get(sharedId).pts[1]];
doCmd({ op: "move", addr: addr1, from: from1, to: [1.3, from1[1] === 0 ? -0.3 : 1.3] });
const s1 = snap();
ok(s1 !== s0, "移動で状態が変わる");

// 2) 頂点挿入（共有arcの中へ）→ 3) 挿入した頂点の削除（delete の undo も試すため別コマンド）
doCmd({ op: "insert", addr: model.addrOf(sharedId, 0), ll: [1.15, 0.5] });
const s2 = snap();
const insCmd = { op: "insert", addr: model.addrOf(sharedId, 0), ll: [1.18, 0.7] };
doCmd(insCmd);
doCmd({ op: "delete", addr: insCmd.addrNew });   // 直前に挿した頂点を消す
const s3 = snap();
ok(s3 === s2, "挿入→削除で挿入前と一致（アドレスの自己完結）");

// 4) プロパティ編集（@キー）
doCmd({ op: "props", eid: 0, from: { n: "A" }, to: { n: "A", "@fill": "#3355aa" } });
const s4 = snap();

// 5) フィーチャ追加（ポイント＋@icon） 6) フィーチャ削除（B）
doCmd({ op: "add", feature: { type: "Feature", properties: { n: "C", "@icon": "star" }, geometry: { type: "Point", coordinates: [5, 5] } } });
const s5 = snap();
doCmd({ op: "del", eid: 1 });
const s6 = snap();

// ---- undo 全段 ----
const apply = applyR, invert = c => model.invertCmd(c);
hist.undo(apply, invert); ok(snap() === s5, "undo: 削除が戻る（B復活・位置も同じ）");
hist.undo(apply, invert); ok(snap() === s4, "undo: 追加が消える");
hist.undo(apply, invert); ok(snap() === s3, "undo: プロパティが戻る");
hist.undo(apply, invert);                                            // 頂点削除の取り消し＝insert2復元
hist.undo(apply, invert); ok(snap() === s2, "undo: insert2 が消える");
hist.undo(apply, invert); ok(snap() === s1, "undo: insert1 が消える");
hist.undo(apply, invert); ok(snap() === s0, "undo: 全段で初期状態と完全一致");
ok(!hist.canUndo, "undoスタックが空");

// ---- redo 全段 ----
while (hist.canRedo) hist.redo(apply);
ok(snap() === s6, "redo: 全段で最終状態と完全一致");

process.exit(fails ? 1 : 0);
