// t-combine: 束ね(combine)/戻し(uncombine)/ばらす(split) の往復と refs 整合（node tests/t-combine.mjs）
import { buildTopology } from "../../src/edit/topo-extract.js";
import { createModel } from "../../src/edit/model.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

// ---- 面：隣接2ポリゴン（共有辺あり）----
{
	const fc = { type: "FeatureCollection", features: [
		{ type: "Feature", properties: { name: "A", "@fill": "#f00" }, geometry: { type: "Polygon", coordinates: [sq(0, 0, 1, 1)] } },
		{ type: "Feature", properties: { name: "B" }, geometry: { type: "Polygon", coordinates: [sq(1, 0, 2, 1)] } },
	] };
	const model = createModel(buildTopology(fc, 6));
	const eids = [...model.feats.keys()];
	const sharedId = [...model.arcs.keys()].find(id => model.arcs.get(id).refs.size === 2);
	ok(sharedId !== undefined, "面: 共有arc(refs=2)が存在");
	const before = JSON.stringify(model.toGeoJSON());

	const cmd = { op: "combine", eids: [...eids] };
	model.applyCmd(cmd);
	ok(model.feats.size === 1, `面: combine で 1フィーチャ（実際 ${model.feats.size}）`);
	const mf = model.feats.get(eids[0]);
	ok(mf.type === "MultiPolygon", `面: 型が MultiPolygon（実際 ${mf.type}）`);
	const g = model.toGeoJSON();
	ok(g.features.length === 1 && g.features[0].geometry.type === "MultiPolygon", "面: 出力が MultiPolygon 1件");
	ok(g.features[0].geometry.coordinates.length === 2, `面: 2ポリゴン（実際 ${g.features[0].geometry.coordinates.length}）`);
	ok(g.features[0].properties.name === "A", "面: プロパティは代表(A)を継承");
	ok(model.arcs.get(sharedId).refs.size === 1, `面: 共有arcの refs は代表のみ1（実際 ${model.arcs.get(sharedId).refs.size}）`);
	ok(cmd.parts && cmd.parts.length === 2, "面: undo用 parts が記録された");

	// undo（uncombine）
	model.applyCmd(model.invertCmd(cmd));
	ok(model.feats.size === 2, `面: uncombine で 2フィーチャに復帰（実際 ${model.feats.size}）`);
	ok(model.arcs.get(sharedId).refs.size === 2, "面: 共有arcの refs が2に復帰");
	ok(JSON.stringify(model.toGeoJSON()) === before, "面: uncombine で geometry 完全一致");

	// redo（combine）→ split（ばらす）
	model.applyCmd(cmd);
	const scmd = { op: "split", eid: eids[0] };
	model.applyCmd(scmd);
	ok(model.feats.size === 2, `面: split で 2フィーチャ（実際 ${model.feats.size}）`);
	const types = [...model.feats.values()].map(f => f.type);
	ok(types.every(t => t === "Polygon"), `面: split 後は Polygon×2（実際 ${types.join(",")}）`);
	ok(model.arcs.get(sharedId).refs.size === 2, "面: split 後 共有arc refs が2");
	ok(scmd.newEids && scmd.newEids.length === 1, "面: split の newEids が記録された");
	// split の undo（combine）で戻る
	model.applyCmd(model.invertCmd(scmd));
	ok(model.feats.size === 1 && model.feats.get(eids[0]).type === "MultiPolygon", "面: split の undo で MultiPolygon に戻る");
}

// ---- 線：2 LineString ----
{
	const fc = { type: "FeatureCollection", features: [
		{ type: "Feature", properties: { name: "L1" }, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } },
		{ type: "Feature", properties: { name: "L2" }, geometry: { type: "LineString", coordinates: [[2, 2], [3, 3]] } },
	] };
	const model = createModel(buildTopology(fc, 6));
	const eids = [...model.feats.keys()];
	const before = JSON.stringify(model.toGeoJSON());
	const cmd = { op: "combine", eids: [...eids] };
	model.applyCmd(cmd);
	ok(model.feats.size === 1 && model.feats.get(eids[0]).type === "MultiLineString", "線: combine で MultiLineString");
	const g = model.toGeoJSON();
	ok(g.features[0].geometry.type === "MultiLineString" && g.features[0].geometry.coordinates.length === 2, "線: 出力 MultiLineString 2本");
	model.applyCmd(model.invertCmd(cmd));
	ok(JSON.stringify(model.toGeoJSON()) === before, "線: uncombine で完全一致");
}

// ---- 異種混在は弾く ----
{
	const fc = { type: "FeatureCollection", features: [
		{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [sq(0, 0, 1, 1)] } },
		{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } },
	] };
	const model = createModel(buildTopology(fc, 6));
	const eids = [...model.feats.keys()];
	const r = model.applyCmd({ op: "combine", eids: [...eids] });
	ok(r == null && model.feats.size === 2, "異種(面+線)の combine は無効＝据え置き");
}

console.log(fails ? `\n${fails} 件失敗` : "\n全通過");
process.exit(fails ? 1 : 0);
