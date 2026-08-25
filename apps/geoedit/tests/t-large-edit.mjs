// t-large-edit: 大規模モード Phase2＝GintBUF 背骨のジオメトリ編集検定（Node・WASM無し＝JSフォールバックで実GintBUFを焼く）。
//   ①共有arcのlift（隣接ポリが同一arcを参照・refs） ②moveVertex＝arcBuffer in-place＋鏡像＋隣も動く
//   ③端点weld（同座標の全arc端が一括で動く・環の閉性維持） ④L2頂点＝weight保存（8単位丸め）
//   ⑤refreshDirty＝arcMeta/fid別bboxの部分再計算＋identifyAtの正気 ⑥toPbf＝変更fidだけ再エンコード・無変更はバイト複写
//   ⑦undo（invertCmd適用で原座標へ）
globalThis.ImageData ??= class ImageData { };   // makeKeys が instanceof で参照（ブラウザ専用API）
import { GeoPBF } from "geopbf/pbf-base";
import { gint } from "geopbf/gint";
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
import { identifyAt } from "geopbf/identify";
import { createLargeModel, listsOf } from "../src/large-model.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SCALE = 1e7;

// A/B＝共有辺（8分割＝直線内部点はVWでL2化される）を持つ隣接正方形＋孤立ポリC＋線L
const edge = (x, y0, y1, k) => { const out = []; for (let i = 0; i <= k; i++) out.push([x, +(y0 + (y1 - y0) * i / k).toFixed(6)]); return out; };
const K = 8;
const shared = edge(1, 0, 1, K);                             // x=1 の共有辺（下→上）
const ringA = [[0, 0], [1, 0], ...shared.slice(1, -1).map(p => [...p]), [1, 1], [0, 1], [0, 0]];
const ringB = [[1, 0], [2, 0], [2, 1], [1, 1], ...shared.slice(1, -1).reverse().map(p => [...p]), [1, 0]];
const fc = {
	type: "FeatureCollection",
	features: [
		{ type: "Feature", properties: { n: "A" }, geometry: { type: "Polygon", coordinates: [ringA] } },
		{ type: "Feature", properties: { n: "B" }, geometry: { type: "Polygon", coordinates: [ringB] } },
		{ type: "Feature", properties: { n: "C" }, geometry: { type: "Polygon", coordinates: [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]] } },
		{ type: "Feature", properties: { n: "L" }, geometry: { type: "LineString", coordinates: [[3, 3], [3.5, 3.2], [4, 3]] } },
	],
};

const pbf = await new GeoPBF({ name: "t-edit", precision: 6 }).set(structuredClone(fc));
const GINT = topology(pbf);                    // JS経路（WASM無し）＝VW/L2込みの実GintBUF
pbf.unPackGint = unPackGintBuffer(GINT);
ok(!!pbf.unPackGint?.arcBuffer, "GintBUF焼き（JS経路）");

const model = createLargeModel(pbf);
const u = pbf.unPackGint;

// ---- ① 共有arcのlift ----
const aidsOf = f => { const s = new Set(); for (const { list } of listsOf(f)) for (const v of list) s.add(v < 0 ? ~v : v); return s; };
const A = model.feats.get(0), B = model.feats.get(1);
const sharedAids = [...aidsOf(A)].filter(a => aidsOf(B).has(a));
ok(sharedAids.length === 1, `共有arc＝1本（実際 ${sharedAids.length}）`);
const sa = sharedAids[0];
ok(eq([...model.arcs.get(sa).refs].sort(), [0, 1]), "共有arcの refs=[A,B]");
const saLen = u.arcMeta[sa * 8 + 1];
ok(saLen === K + 1, `共有arcの頂点数=${K + 1}（実際 ${saLen}）`);

// ---- ② 内部頂点の移動＝両方の形が変わる ----
const midIdx = Math.floor(saLen / 2);
const res1 = model.applyCmd({ op: "move", addr: model.addrOf(sa, midIdx), from: [1, 0.5], to: [1.1, 0.52] });
ok(res1?.dirty?.includes(sa), "applyCmd move 適用（dirtyに共有arc）");
ok(model.geomDirty === true, "geomDirty が立つ");
const hasPt = (f, lng, lat) => listsOf(f).some(({ list }) => model.stitch(list).some(([x, y]) => Math.abs(x - lng) < 1e-6 && Math.abs(y - lat) < 1e-6));
ok(hasPt(A, 1.1, 0.52) && hasPt(B, 1.1, 0.52), "移動が A/B 両方の縫合形に現れる（共有＝隣も動く）");
const off = u.arcMeta[sa * 8];
ok(eq(gint.unpackToInt(u.arcBuffer[off + midIdx]), [Math.round(181.1 * SCALE), Math.round(90.52 * SCALE)]), "arcBuffer の u64 が新座標（L1）");

// ---- ③ 端点weld：共有arcの上端（1,1）＝A/B/外周arcの合流点 ----
const before = [];
for (let aid = 0; aid < u.arcCount; aid++) {
	const o = u.arcMeta[aid * 8], l = u.arcMeta[aid * 8 + 1];
	for (const vi of [0, l - 1]) {
		const [ix, iy] = gint.unpackToInt(u.arcBuffer[o + vi]);
		if (ix === Math.round(181 * SCALE) && iy === Math.round(91 * SCALE)) before.push([aid, vi]);
	}
}
ok(before.length >= 3, `(1,1)に集まる arc端 ≥3（実際 ${before.length}）`);
model.applyCmd({ op: "move", addr: model.addrOf(before[0][0], before[0][1]), from: [1, 1], to: [1.05, 1.08] });
let welded = true;
for (const [aid, vi] of before) {
	const o = u.arcMeta[aid * 8];
	if (!eq(gint.unpackToInt(u.arcBuffer[o + vi]), [Math.round(181.05 * SCALE), Math.round(91.08 * SCALE)])) welded = false;
}
ok(welded, "端点weld＝合流する全arc端が一括で動く");
const ringsClosed = f => listsOf(f).every(({ list, ring }) => { if (!ring) return true; const cs = model.stitch(list); return eq(cs[0], cs[cs.length - 1]); });
ok(ringsClosed(A) && ringsClosed(B), "weld後も環は閉じている");

// ---- ④ L2頂点＝weight保存 ----
let l2 = null;
for (let i = 0; i < saLen; i++) { const v = u.arcBuffer[off + i]; if (!(v & gint.TERMINAL_BIT)) { l2 = i; break; } }
if (l2 == null) ok(true, "（L2頂点なし＝小データでは全L1もあり得る＝スキップ）");
else {
	const w0 = gint.getWeight(u.arcBuffer[off + l2]);
	model.moveVertex(sa, l2, 1.12, 0.61);
	const v = u.arcBuffer[off + l2];
	ok(!(v & gint.TERMINAL_BIT) && gint.getWeight(v) === w0, `L2形式とweight(${w0})が保存される`);
	const [ix, iy] = gint.unpackToInt(v);
	ok(Math.abs(ix - Math.round(181.12 * SCALE)) <= 4 && Math.abs(iy - Math.round(90.61 * SCALE)) <= 4, "L2＝8単位丸めの範囲で新座標");
}

// ---- ⑤ bbox部分再計算＋VW再重み付け＋identify ----
model.refreshDirty();
{   // reweight＝dirty arcのweightが新形状で焼き直される（stale weightのLOD弦=「余計な線」の根治 8/26）
	const o2 = u.arcMeta[sa * 8], l2n = u.arcMeta[sa * 8 + 1];
	ok((u.arcBuffer[o2] & gint.TERMINAL_BIT) !== 0n && (u.arcBuffer[o2 + l2n - 1] & gint.TERMINAL_BIT) !== 0n, "reweight後も両端はL1");
	const [mx, my] = gint.unpackToInt(u.arcBuffer[o2 + midIdx]);
	ok(Math.abs(mx - Math.round(181.1 * SCALE)) <= 4 && Math.abs(my - Math.round(90.52 * SCALE)) <= 4, "reweight後も移動座標は保持（L2丸め≤8単位）");
}
const m = sa * 8;
ok(u.arcMeta[m + 6] >= Math.round(181.1 * SCALE), "arcMeta bbox が新座標を含む");
const bbA = u.polyBboxByFid.get(0);
ok(bbA && bbA[2] >= Math.round(181.1 * SCALE), "fid別bbox が更新される");
ok(identifyAt(pbf, 0.5, 0.5, {}) === 0 && identifyAt(pbf, 1.5, 0.5, {}) === 1, "identifyAt が編集後も正答");
ok(identifyAt(pbf, 1.05, 0.5, {}) === 0, "膨らんだ境界の内側＝A と識別（移動が識別幾何に反映）");

// ---- ⑥ 書き出し：変更fid再エンコード・無変更バイト複写 ----
const out = await model.toPbf();
ok(out.length === 4 && out._precision === pbf._precision, "全フィーチャ・precision継承");
const g2 = out.getGeometry(0);
ok(g2.coordinates[0].some(([x, y]) => Math.abs(x - 1.1) < 1e-6 && Math.abs(y - 0.52) < 1e-6), "書き出しに移動後の座標（A再エンコード）");
const cleanSame = eq(out.getGeometry(2).coordinates, pbf.getGeometry(2).coordinates) && eq(out.getGeometry(3).coordinates, pbf.getGeometry(3).coordinates);
ok(cleanSame, "無変更フィーチャ（C/L）はバイト複写で一致");
const gOut = out.getGeometry(1);
ok(gOut.coordinates[0].some(([x, y]) => Math.abs(x - 1.1) < 1e-6 && Math.abs(y - 0.52) < 1e-6), "隣（B）の書き出しにも共有辺の移動が現れる");

// ---- ⑦ undo ----
const cmd = { op: "move", addr: model.addrOf(sa, midIdx), from: [1, 0.5], to: [1.1, 0.52] };
model.applyCmd(model.invertCmd(cmd));
ok(eq(gint.unpackToInt(u.arcBuffer[off + midIdx]), [Math.round(181 * SCALE), Math.round(90.5 * SCALE)]), "invertCmd 適用で原座標へ戻る");

process.exit(fails ? 1 : 0);
