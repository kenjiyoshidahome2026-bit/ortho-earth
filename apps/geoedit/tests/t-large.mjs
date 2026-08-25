// t-large: 大規模モード（Phase1）＝createLargeModel の facade 検定。
//   ①位相抽出なしで feats（type/properties）が立つ ②遅延lift＝listsOf/stitch が pop 錨計算と互換
//   ③props コマンドの適用/反転（undo） ④toPbf＝ストリーム置換複写（幾何バイト複写・属性再エンコード・precision継承）
globalThis.ImageData ??= class ImageData { };   // makeKeys が instanceof で参照（ブラウザ専用API）＝Nodeでは空クラスで足りる
import { GeoPBF } from "geopbf/pbf-base";
import { topology, unPackGintBuffer } from "geopbf/topology";
import { gint as _g } from "geopbf/gint";
// Node で gint WASM を初期化（web ターゲット init は fetch 前提＝バイト列を直接渡す。init はメモ化済み＝
// gint.initialize() の再呼びは素通り）。JS位相フォールバックは共有点/角を落とすバグがあり検定に使えない（8/26実測）。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
{
	const req = createRequire(import.meta.url);
	const wasmJs = req.resolve("geopbf/pbf-base").replace(/src\/pbf-base\.js$/, "wasm/pkg/gint_wasm.js");
	const mod = await import(wasmJs);
	await mod.default({ module_or_path: readFileSync(wasmJs.replace(/\.js$/, "_bg.wasm")) });
	await _g.initialize();
}
import { createLargeModel, listsOf } from "../src/large-model.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
// ⚠(0,0)を含む形は避ける＝gint位相（JS/WASM両経路）に「null island が環始点/junctionキーだと頂点が落ちる」
//   既知バグあり（キー0=空セル番兵の衝突・8/26実測）。実データではほぼ踏まないが検定データでは踏んでいた。
const fc = {
	type: "FeatureCollection",
	features: [
		{ type: "Feature", properties: { n: "A", "@fill": "#a04040" }, geometry: { type: "Polygon", coordinates: [sq(10, 10, 11, 11)] } },
		{ type: "Feature", properties: { n: "B" }, geometry: { type: "Polygon", coordinates: [sq(11, 10, 12, 11)] } },   // Aと辺共有
		{ type: "Feature", properties: { n: "MP" }, geometry: { type: "MultiPolygon", coordinates: [[sq(15, 15, 16, 16), sq(15.2, 15.2, 15.8, 15.8)]] } },   // 穴付き
		{ type: "Feature", properties: { n: "L", "@tip": "みち" }, geometry: { type: "LineString", coordinates: [[10, 10], [10.5, 9.5], [11, 10]] } },
		{ type: "Feature", properties: { n: "P" }, geometry: { type: "Point", coordinates: [10.5, 10.5] } },
	],
};

const E = 1e6, q = v => Math.round(v * E) / E;
const qDeep = c => Array.isArray(c[0]) ? c.map(qDeep) : [q(c[0]), q(c[1])];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 環＝回転＋向き不変で正規化（GintBUF位相＝arc分割点始まり・向き揃えあり）。線＝向き不変。
const canonRing = ring => {
	const r = ring.slice(0, -1).map(p => qDeep(p));
	const key = p => p[0] + "," + p[1];
	const rot = a => { let b = 0; for (let i = 1; i < a.length; i++) if (key(a[i]) < key(a[b])) b = i; return a.slice(b).concat(a.slice(0, b)); };
	const fwd = rot(r), rev = rot(r.slice().reverse());
	return JSON.stringify(fwd) < JSON.stringify(rev) ? fwd : rev;
};
const canonLine = cs => { const a = cs.map(p => qDeep(p)); const r = a.slice().reverse(); return JSON.stringify(a) < JSON.stringify(r) ? a : r; };

const src = await new GeoPBF({ name: "t-large", precision: 6 }).set(structuredClone(fc));
src.unPackGint = unPackGintBuffer(topology(src));   // Phase2以降＝ジオメトリの真実源はGintBUF（実行時はloadLargeがpbf.gint()を先に焼く）
const model = createLargeModel(src);

// ---- ① facade ----
ok(model.large === true, "large フラグ");
ok(model.feats.size === 5, "feats=5（eid=fid恒等）");
ok(model.feats.get(0).type === "Polygon" && model.feats.get(4).type === "Point", "type が fmap 直引きで立つ");
ok(model.feats.get(0).properties["@fill"] === src.getProperties(0)["@fill"] && model.feats.get(0).properties.n === "A", "properties が pbf 読み戻しと一致（#hexはCOLOR型→rgb()正規化）");
ok(model.feats.get(3).properties["@tip"] === "みち", "@tip が読める");
ok(model.familyOf(model.feats.get(2).type) === "poly" && model.familyOf("LineString") === "line", "familyOf");
ok(model.stats().features === 5, "stats.features");

// ---- ② 遅延lift（pop 錨互換：listsOf + stitch）----
ok(Object.getOwnPropertyDescriptor(model.feats.get(0), "arcs").get !== undefined, "lift はアクセスまで起きない（getter のまま）");
const fA = model.feats.get(0);
const listsA = listsOf(fA);
ok(listsA.length === 1 && listsA[0].ring === true, "listsOf: Polygon＝1リング");
ok(eq(canonRing(model.stitch(listsA[0].list)), canonRing(src.getGeometry(0).coordinates[0])), "stitch が pbf のリングを再現（回転・向き不変・1e-6量子化）");
const fMP = model.feats.get(2);
const listsMP = listsOf(fMP);
ok(listsMP.length === 2, "listsOf: 穴付きMultiPolygon＝外環+内環");
const fL = model.feats.get(3);
ok(eq(canonLine(model.stitch(listsOf(fL)[0].list)), canonLine(src.getGeometry(3).coordinates)), "stitch がラインを再現（向き不変）");
ok(eq(qDeep(model.feats.get(4).coords), [[10.5, 10.5]]), "点の coords 遅延lift");

// ---- ③ props コマンド ----
const from = model.feats.get(1).properties;
const to = { ...from, "@fill": "#3355aa", memo: "hello" };
ok(model.applyCmd({ op: "props", eid: 1, from, to }) === true, "applyCmd props 適用");
ok(model.feats.get(1).properties["@fill"] === "#3355aa", "適用後の値（facade上は生値）");
const inv = model.invertCmd({ op: "props", eid: 1, from, to });
model.applyCmd(inv);
ok(model.feats.get(1).properties["@fill"] === undefined && model.feats.get(1).properties.n === "B", "invertCmd で undo");
model.applyCmd({ op: "props", eid: 1, from, to });   // 書き出し検定用に再適用
ok(model.applyCmd({ op: "del", eid: 1 }) === null, "props 以外の op は受けない（null）");

// ---- ④ toPbf＝ストリーム置換複写 ----
const out = await model.toPbf();
ok(out._precision === src._precision, "precision 継承");
ok(out.length === 5, "全フィーチャ複写");
ok(out.getProperties(1)["@fill"] === "rgb(51,85,170)" && out.getProperties(1).memo === "hello", "変更属性が新値（COLOR型正規化込み）");
ok(eq(out.getProperties(0), src.getProperties(0)), "無変更フィーチャの属性は原値と一致");
let geomSame = true;
for (let i = 0; i < 5; i++) if (!eq(qDeep(out.getGeometry(i).coordinates), qDeep(src.getGeometry(i).coordinates))) geomSame = false;
ok(geomSame, "全ジオメトリがバイト複写で一致");

process.exit(fails ? 1 : 0);
