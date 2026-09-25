// line-dasharray の検定（src/build.js・2026-09-25）。node packages/ortho-core/tests/dasharray.mjs
// 守るもの：①内蔵 style の [5,4]（px）は従来どおりの刻み ②外来 MapLibre style の式（literal/step/旧式関数）でも線が消えない
// ③外来は線幅の倍数 ④読めない値は実線に倒す
import assert from "node:assert/strict";
import { buildTileDrawList, dashPattern } from "../src/build.js";
import { convertLayer } from "../src/mlstyle.js";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };

// 1 本の直線（タイル左端→右端・extent 4096）＝256px 相当。線幅 2
const tile = { z: 10, x: 900, y: 400, layers: { road: { extent: 4096, features: [{ type: "LineString", props: {}, geom: { coords: [0, 2048, 4096, 2048], ends: [4] } }] } } };
const pieces = paint => {
	const { ops } = buildTileDrawList(tile, { layers: [{ id: "r", type: "line", "source-layer": "road", paint: { "line-width": 2, ...paint } }] }, [0, 0]);
	return ops[0] ? ops[0].half.length : 0;
};
const piecesML = paint => {
	const L = convertLayer({ id: "r", type: "line", "source-layer": "road", paint: { "line-width": 2, ...paint } });
	const { ops } = buildTileDrawList(tile, { layers: [L] }, [0, 0]);
	return ops[0] ? ops[0].half.length : 0;
};

t("dashPattern：数の配列だけ・奇数は 2 回・合計 0 と負は null", () => {
	assert.deepEqual(dashPattern([5, 4]), [5, 4]);
	assert.deepEqual(dashPattern([2]), [2, 2]);
	assert.equal(dashPattern([0, 0]), null);
	assert.equal(dashPattern([1, -1]), null);
	assert.equal(dashPattern(["step", 1]), null);
	assert.equal(dashPattern(null), null);
});
t("内蔵 [5,4] px は従来どおり 256/9 の刻み＝29 片", () => assert.equal(pieces({ "line-dasharray": [5, 4] }), 29));
t("dasharray なしは細分だけ（破線にならない）", () => assert.ok(pieces({}) >= 1 && pieces({}) < 29));
t("★外来 [\"literal\",[2,1]] は線幅倍＝(2×2+1×2)=6px 周期＝43 片", () => assert.equal(piecesML({ "line-dasharray": ["literal", [2, 1]] }), 43));
t("★外来の数の配列 [2,1] も同じ（線幅倍）", () => assert.equal(piecesML({ "line-dasharray": [2, 1] }), 43));
t("★外来の step 式が評価される（z10 → [4,4]＝16px 周期＝16 片）", () =>
	assert.equal(piecesML({ "line-dasharray": ["step", ["zoom"], ["literal", [1, 1]], 5, ["literal", [4, 4]]] }), 16));
t("★外来の旧式関数 {stops} も消えない", () => assert.ok(piecesML({ "line-dasharray": { stops: [[5, [1, 1]], [15, [4, 4]]] } }) > 0));
t("★4 要素の模様 [2,1,0.5,1]（線幅倍＝9px 周期に 2 片）", () => assert.equal(piecesML({ "line-dasharray": [2, 1, 0.5, 1] }), 57));
t("★読めない値は実線に倒す（線を消さない）", () => assert.equal(pieces({ "line-dasharray": ["get", "nope"] }), pieces({})));

console.log(`\n✅ dasharray ${n} 件`);
