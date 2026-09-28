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
console.log("labels.mjs: ok (", labels.length, "labels )");
