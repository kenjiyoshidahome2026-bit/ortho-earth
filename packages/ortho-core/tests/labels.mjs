// buildLabels（labels.js）の記号（段 3・2026-09-28）：icon-image だけの層もラベルになる（text ""）・icon の性質が焼かれる・文字も記号も無い層／名前が空の記号は出ない・同じ点の文字と記号は別のラベル
import assert from "node:assert/strict";
import { buildLabels } from "../src/labels.js";

const src = { extent: 4096, features: [{ type: "Point", props: { name: "Cafe", ic: "cafe" }, geom: { coords: [100, 200] } }] };
const style = { layers: [
	{ id: "ico", type: "symbol", "source-layer": "poi", layout: { "icon-image": ["get", "ic"], "icon-size": 2, "icon-anchor": "top", "icon-offset": [0, 5], "icon-rotate": 45, "icon-text-fit": "both", "icon-text-fit-padding": [1, 2, 3, 4], "text-optional": true, "icon-allow-overlap": true }, paint: { "icon-color": "#ff0000", "icon-opacity": 0.5 } },
	{ id: "txt", type: "symbol", "source-layer": "poi", layout: { "text-field": ["get", "name"] } },
	{ id: "both", type: "symbol", "source-layer": "poi", layout: { "text-field": ["get", "name"], "icon-image": ["image", "sq"] } },
	{ id: "none", type: "symbol", "source-layer": "poi", layout: {} },
	{ id: "missing", type: "symbol", "source-layer": "poi", layout: { "icon-image": ["get", "nope"] } },
	{ id: "fitnone", type: "symbol", "source-layer": "poi", layout: { "icon-image": "sq", "icon-text-fit": "none" } },
] };
const { labels } = buildLabels({ layers: { poi: src }, z: 14, x: 0, y: 0 }, style);
const by = Object.fromEntries(labels.map(L => [style.layers[L.li].id, L]));
assert.deepEqual(Object.keys(by).sort(), ["both", "fitnone", "ico", "txt"], "記号だけの層は出る・文字も記号も無い層と空の名前は出ない");

const I = by.ico;
assert.equal(I.text, ""); assert.equal(I.icon, "cafe");
assert.equal(I.isz, 2); assert.equal(I.ian, "top"); assert.deepEqual(I.ioff, [0, 5]); assert.equal(I.irot, 45); assert.equal(I.ipad, 2);
assert.equal(I.ifit, "both"); assert.deepEqual(I.ifp, [1, 2, 3, 4]);
assert.equal(I.topt, true); assert.equal(I.iopt, false); assert.equal(I.iov, true); assert.equal(I.iig, false);
assert.deepEqual(I.icol, [1, 0, 0, 1]); assert.equal(I.iop, 0.5);

assert.equal(by.txt.text, "Cafe"); assert.equal(by.txt.icon, undefined); assert.equal(by.txt.isz, undefined, "文字だけの層に記号の性質は付かない");
assert.equal(by.both.text, "Cafe"); assert.equal(by.both.icon, "sq", '["image", name] は名前');
assert.equal(by.fitnone.ifit, undefined, "fit none は焼かない"); assert.equal(by.fitnone.isz, 1);

// ── 線に沿う注記（段 4）：spacing 間隔の錨（タイルの中だけ）・line-center は中心 1 つ・折れ線（経緯度）の中に錨がある・折り返し無し・max-angle/keep-upright
const road = { extent: 4096, features: [{ type: "LineString", props: { name: "Main St" }, geom: { coords: [-200, 1000, 4300, 1000], ends: [4] } }] };   // 東西 4500 単位（バッファに食み出す）
const lstyle = { layers: [
	{ id: "rl", type: "symbol", "source-layer": "road", layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-size": 12, "symbol-spacing": 100, "text-max-angle": 30, "text-keep-upright": false } },   // 100px＝800 単位
	{ id: "rc", type: "symbol", "source-layer": "road", layout: { "symbol-placement": "line-center", "text-field": ["get", "name"] } },
	{ id: "rp", type: "symbol", "source-layer": "road", layout: { "text-field": ["get", "name"] } },   // 点の注記＝線には置かない
] };
const { labels: ll } = buildLabels({ layers: { road: road }, z: 14, x: 100, y: 200 }, lstyle);
const rl = ll.filter(L => L.li === 0), rc = ll.filter(L => L.li === 1), rp = ll.filter(L => L.li === 2);
assert.equal(rp.length, 0, "点の注記＝線の先頭が枠の外（−200）＝置かない");
const road1 = { extent: 4096, features: [{ type: "LineString", props: { name: "Elm" }, geom: { coords: [10, 20, 500, 20, 900, 20], ends: [6] } }] };
const rp1 = buildLabels({ layers: { road: road1 }, z: 14, x: 0, y: 0 }, { layers: [lstyle.layers[2]] }).labels;
assert.equal(rp1.length, 1, "点の注記は線の先頭の頂点に 1 つ（MapLibre）"); assert.equal(rp1[0].lp, undefined);
assert.equal(rc.length, 1, "line-center は 1 つ"); assert.equal(rc[0].lp, 1); assert.equal(rc[0].mw, 0); assert.equal(rc[0].ma, 45); assert.equal(rc[0].ku, true);
// 文字 "Main St"＝7 字×12×0.7＝58.8px＝941 単位（16 単位/px）・候補の間隔＝max(941/2, 100px/4＝400 単位)＝470・最初＝470＋384＝854 → 4300−470 まで＝約 7 個（タイルの中 [0,4096) だけ）
assert.ok(rl.length >= 6 && rl.length <= 8, "候補の錨は文字の半分ごと（タイルの中だけ）: " + rl.length);

assert.equal(rl[0].ma, 30); assert.equal(rl[0].ku, false); assert.equal(rl[0].sp, 100, "symbol-spacing（px）は描く側が課す"); assert.equal(rc[0].sp, undefined);
assert.ok(rl.every(L => L.lg === rl[0].lg) && /^14\/100\/200\/0\/1\/0$/.test(rl[0].lg), "spacing の群＝1 本の線: " + rl[0].lg);
// MapLibre 由来の層は同じ点・同じ文字・同じ記号でも層ごとに（後の層が勝つ）＝ネイティブは層またぎで 1 つ
const mlL = (id, extra = {}) => ({ id, type: "symbol", "source-layer": "poi", metadata: { "ortho:origin": "ml" }, layout: { "text-field": ["get", "name"], "icon-image": "bus", ...extra } });
const dup = buildLabels({ layers: { poi: src }, z: 14, x: 0, y: 0 }, { layers: [mlL("a"), mlL("b")] }).labels;
assert.equal(dup.length, 2, "ML の層＝両方");
const dupN = buildLabels({ layers: { poi: src }, z: 14, x: 0, y: 0 }, { layers: [{ id: "a", type: "symbol", "source-layer": "poi", layout: { "text-field": ["get", "name"] } }, { id: "b", type: "symbol", "source-layer": "poi", layout: { "text-field": ["get", "name"] } }] }).labels;
assert.equal(dupN.length, 1, "ネイティブの層＝1 つ");
for (const L of rl) { assert.ok(L.path instanceof Float64Array && L.path.length >= 4); assert.ok(L.ai >= 0 && L.ai * 2 < L.path.length); assert.equal(L.path[L.ai * 2], L.anchor[0]); assert.equal(L.path[L.ai * 2 + 1], L.anchor[1]); assert.ok(L.icon === undefined); }
const xs = rl.map(L => L.anchor[0]); assert.ok(xs.every((v, i) => i === 0 || v > xs[i - 1]), "錨は線に沿って並ぶ");
// 短い線（文字は収まるが最初の余白が取れない）＝中心に 1 つ
const short = { extent: 4096, features: [{ type: "LineString", props: { name: "Main St" }, geom: { coords: [100, 100, 700, 100], ends: [4] } }] };   // 600 単位・文字の見積もり 941 単位の半分以上＝中心に 1 つ（収まるかは描く側）
const { labels: sl } = buildLabels({ layers: { road: short }, z: 14, x: 0, y: 0 }, { layers: [lstyle.layers[0]] });
assert.equal(sl.length, 1, "短い線＝中心に 1 つ"); assert.equal(sl[0].path[sl[0].ai * 2], sl[0].anchor[0]);
// symbol-placement が式（zoom で point/line）・viewport の向き＝線の錨に点として（lp 無し・sp あり・記号あり）・線の記号だけの層（lp・icon）
const road2 = { extent: 4096, features: [{ type: "LineString", props: { ref: "I 80", net: "us-interstate" }, geom: { coords: [0, 500, 4096, 500], ends: [4] } }] };
const st2 = { layers: [
	{ id: "shield", type: "symbol", "source-layer": "road", layout: { "symbol-placement": ["step", ["zoom"], "point", 11, "line"], "symbol-spacing": 200, "icon-image": ["concat", ["get", "net"], "_2"], "icon-rotation-alignment": "viewport", "text-field": ["get", "ref"], "text-rotation-alignment": "viewport", "text-size": 10 } },
	{ id: "oneway", type: "symbol", "source-layer": "road", layout: { "symbol-placement": "line", "icon-image": "oneway", "icon-rotate": 90, "icon-rotation-alignment": "map", "symbol-spacing": 75 } },
] };
const z9 = buildLabels({ layers: { road: road2 }, z: 9, x: 0, y: 0 }, st2).labels.filter(L => L.li === 0), z14 = buildLabels({ layers: { road: road2 }, z: 14, x: 0, y: 0 }, st2).labels;
assert.equal(z9.length, 1, "z9＝point＝線の先頭の頂点に盾 1 つ（MapLibre の点置き）"); assert.equal(z9[0].lp, undefined); assert.equal(z9[0].icon, "us-interstate_2"); assert.equal(z9[0].sp, undefined);
const sh = z14.filter(L => L.li === 0), ow = z14.filter(L => L.li === 1);
assert.ok(sh.length >= 2, "z14＝line＝盾の錨: " + sh.length); assert.equal(sh[0].lp, undefined, "viewport＝回さない＝点として"); assert.equal(sh[0].sp, 200); assert.equal(sh[0].icon, "us-interstate_2"); assert.equal(sh[0].ira, "viewport"); assert.equal(sh[0].text, "I 80");
assert.ok(ow.length >= 5, "矢印の錨: " + ow.length); assert.equal(ow[0].lp, 1); assert.equal(ow[0].icon, "oneway"); assert.equal(ow[0].irot, 90); assert.equal(ow[0].ira, "map"); assert.equal(ow[0].text, "");
// 向き（段 5）＝text-rotate・rotation/pitch-alignment・icon-pitch-alignment を焼く（既定＝auto/0 は焼かない）
const ost = { layers: [
	{ id: "o1", type: "symbol", "source-layer": "poi", layout: { "text-field": ["get", "name"], "text-rotate": 30, "text-rotation-alignment": "map", "text-pitch-alignment": "viewport", "icon-image": "sq", "icon-rotation-alignment": "map", "icon-pitch-alignment": "map" } },
	{ id: "o0", type: "symbol", "source-layer": "poi", layout: { "text-field": ["get", "name"] } },
] };
const ol = buildLabels({ layers: { poi: src }, z: 14, x: 0, y: 0 }, ost).labels, o1 = ol.find(L => L.li === 0), o0 = ol.find(L => L.li === 1);
assert.equal(o1.rot, 30); assert.equal(o1.ra, "map"); assert.equal(o1.pa, "viewport"); assert.equal(o1.ira, "map"); assert.equal(o1.ipa, "map");
assert.equal(o0.rot, undefined); assert.equal(o0.ra, undefined); assert.equal(o0.pa, undefined);
console.log("labels.mjs: ok (", labels.length, "+", ll.length, "+", sl.length, "+", z14.length, "+", ol.length, "labels )");
