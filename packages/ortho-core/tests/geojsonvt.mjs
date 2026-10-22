#!/usr/bin/env node
// geojson を vector のタイルに切る（geojsonvt.ts・geojson vt plan G-1）の常設検定。
// 見るもの：①面＝4 枚に切った面積の和が元の面積（メルカトル）・枠＋buffer の外に出ない・外周と穴の向き（decode.ts の polygons で読める）
// ②線＝タイルをまたぐ線が枠で切れてつながる ③点＝枠の中だけ ④日付変更線をまたぐ線（±180 を越えて書く）が両側のタイルに出る ⑤id は数だけ・gt は元の型 ⑥タイルに何も無ければ {}。
import { createGeojsonIndex, GEOJSON_LAYER } from "../src/geojsonvt.ts";
import { polygons, signedArea } from "../src/decode.ts";

let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const F = (geometry, properties = {}, id) => ({ type: "Feature", ...(id != null ? { id } : {}), properties, geometry });
const E = 4096, B = 64;
const mx = lon => (lon + 180) / 360, my = lat => { const s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const feats = (tile) => tile[GEOJSON_LAYER]?.features ?? [];
const inBox = c => { for (let i = 0; i < c.length; i++) if (c[i] < -B || c[i] > E + B) return false; return true; };

// ① 穴あきの四角（z1 の 4 枚の真ん中＝経度 0・緯度 0 をまたぐ）
const outer = [[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]], hole = [[-5, -5], [-5, 5], [5, 5], [5, -5], [-5, -5]];
const idx = createGeojsonIndex({ type: "FeatureCollection", features: [F({ type: "Polygon", coordinates: [outer, hole] }, { k: "sq" }, 7)] }, { buffer: 0 });
const areaM = (lo0, la0, lo1, la1) => (mx(lo1) - mx(lo0)) * (my(la0) - my(la1));
const want = areaM(-20, -20, 20, 20) - areaM(-5, -5, 5, 5);
let got = 0, oriented = true, boxed = true, holes = 0;
for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
	for (const f of feats(idx.tile(1, x, y))) {
		boxed &&= inBox(f.geom.coords);
		for (const [ring, hs] of polygons(f.geom)) { holes += hs.length; }
		let s = 0; for (const e of f.geom.ends) { const a = signedArea(f.geom.coords, s, e); got += a; s = e; }
		const first = f.geom.ends[0]; oriented &&= signedArea(f.geom.coords, 0, first) > 0;
	}
}
const gotM = got / (E * E) / 4;   // z1＝タイル 1 枚が世界の 1/2 四方
t("面：4 枚の面積の和＝元の面積（穴を引いた）", Math.abs(gotM - want) / want < 0.01, `got=${gotM.toExponential(4)} want=${want.toExponential(4)}`);
t("面：外周は正の向き（polygons で外周として読める）", oriented);
t("面：枠（buffer 0）の外に出ない", boxed);
t("面：穴は 4 枚に分かれて残る（各タイルに 1 つずつ）", holes === 4, `holes=${holes}`);
const one = feats(idx.tile(1, 0, 0))[0];
t("id は数・gt は元の型・属性はそのまま", one?.id === 7 && one?.gt === "Polygon" && one?.props?.k === "sq");
t("何も無いタイル＝{}", Object.keys(idx.tile(3, 0, 0)).length === 0);

// ② タイルをまたぐ線（経度 −10→10・緯度 10）＝z1 の (0,0) と (1,0) に 1 本ずつ・枠の所で切れる
const li = createGeojsonIndex(F({ type: "LineString", coordinates: [[-10, 10], [10, 10]] }, {}, "s"));
const l0 = feats(li.tile(1, 0, 0)), l1 = feats(li.tile(1, 1, 0));
t("線：両側のタイルに 1 本ずつ", l0.length === 1 && l1.length === 1 && l0[0].geom.ends.length === 1);
t("線：buffer の端で切れる（x＝E+B）", l0[0]?.geom.coords[2] === E + B, JSON.stringify([...(l0[0]?.geom.coords ?? [])]));
t("線：文字の id は落とす（MVT と同じ）", l0[0]?.id === undefined && l0[0]?.gt === "LineString");

// ③ 点（多点）＝枠の中だけ
const pi = createGeojsonIndex(F({ type: "MultiPoint", coordinates: [[-90, 45], [90, 45], [90, -45]] }));
t("点：z1 の右上に 1 点・右下に 1 点", feats(pi.tile(1, 1, 0))[0]?.geom.ends.length === 1 && feats(pi.tile(1, 1, 1))[0]?.geom.ends.length === 1 && feats(pi.tile(1, 0, 1)).length === 0);

// ④ 日付変更線をまたぐ線（170 → 190＝±180 を越えて書く・MapLibre と同じ）＝西端と東端の両方のタイルに出る（間の 0 度の側には出ない）
const am = createGeojsonIndex(F({ type: "LineString", coordinates: [[170, 0], [190, 0]] }));
const east = feats(am.tile(2, 3, 1)), west = feats(am.tile(2, 0, 1)), mid = feats(am.tile(2, 1, 1));
t("日付変更線：東端と西端のタイルに出て、真ん中には出ない", east.length === 1 && west.length === 1 && mid.length === 0, `e=${east.length} w=${west.length} m=${mid.length}`);

// ⑤ タイルを覆う大きな面＝タイルの四角そのもの
const big = createGeojsonIndex(F({ type: "Polygon", coordinates: [[[-170, -80], [170, -80], [170, 80], [-170, 80], [-170, -80]]] }), { buffer: 0 });
const bf = feats(big.tile(4, 8, 7))[0];
t("覆う面＝タイルの四角（面積 E²）", !!bf && Math.abs(signedArea(bf.geom.coords, 0, bf.geom.ends[0]) - E * E) < 1, String(bf && signedArea(bf.geom.coords, 0, bf.geom.ends[0])));

// ⑥ 線の進み（G-3・line-gradient の ["line-progress"]）＝頂点ごとに geom.prog・タイルの境（切った端）で両側の値が続く・頭 0 尻 1
const gp = createGeojsonIndex(F({ type: "LineString", coordinates: [[-10, 10], [0, 10], [10, 10]] }));
const g0 = feats(gp.tile(1, 0, 0))[0], g1 = feats(gp.tile(1, 1, 0))[0];
const pr0 = g0?.geom.prog, pr1 = g1?.geom.prog;
t("進み：頂点の数だけ（Float32Array）", pr0 instanceof Float32Array && pr0.length === g0.geom.coords.length / 2 && pr1?.length === g1.geom.coords.length / 2);
t("進み：頭 0・尻 1", pr0?.[0] === 0 && Math.abs(pr1?.[pr1.length - 1] - 1) < 1e-6, `${pr0?.[0]} ${pr1?.[pr1.length - 1]}`);
// 0 度（x＝E）の頂点＝真ん中＝0.5。左のタイルは buffer の端（x＝E+B）まで＝0.5 より少し先・右のタイルは −B から＝0.5 より少し前
const xAt = (g, i) => g.geom.coords[i * 2];
const mid0 = [...pr0].findIndex((_, i) => xAt(g0, i) === E), mid1 = [...pr1].findIndex((_, i) => xAt(g1, i) === 0);
t("進み：0 度の頂点は両方のタイルで 0.5", Math.abs(pr0[mid0] - 0.5) < 1e-6 && Math.abs(pr1[mid1] - 0.5) < 1e-6, `${pr0[mid0]} ${pr1[mid1]}`);
const bk = (B / E) * 180 / 20;   // buffer の幅（タイル 180° の B/E）÷線の全長 20°
t("進み：切った端は線分の上で補う（buffer の端＝0.5±B の分）", Math.abs(pr0[pr0.length - 1] - (0.5 + bk)) < 1e-4 && Math.abs(pr1[0] - (0.5 - bk)) < 1e-4, `${pr0[pr0.length - 1]} ${pr1[0]}`);
const ml = createGeojsonIndex(F({ type: "MultiLineString", coordinates: [[[10, 10], [20, 10]], [[30, 10], [60, 10]]] }));
const mg = feats(ml.tile(0, 0, 0))[0];
t("進み：MultiLineString は 1 本ずつ 0..1", mg?.geom.ends.length === 2 && mg.geom.prog[0] === 0 && Math.abs(mg.geom.prog[1] - 1) < 1e-6 && mg.geom.prog[2] === 0 && Math.abs(mg.geom.prog[3] - 1) < 1e-6, JSON.stringify([...(mg?.geom.prog ?? [])]));
t("進み：面と点は持たない", one?.geom.prog === undefined && feats(pi.tile(1, 1, 0))[0]?.geom.prog === undefined);

console.log(ng ? `\nFAIL  ${ng} / ${ok + ng}` : `\nPASS  ${ok}`);
process.exit(ng ? 1 : 0);
