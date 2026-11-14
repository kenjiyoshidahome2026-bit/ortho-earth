// 過拡大（overzoomTile）の検定：祖先のタイルを子の枠の座標へ写す・枠に掛からない地物を落とす・点は枠の中だけ。
// node packages/ortho-core/tests/overzoom.mjs
import { overzoomTile } from "../src/overzoom.ts";
let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const E = 4096;
const tile = {
	earth: { extent: E, features: [{ type: "Polygon", id: 1, props: {}, geom: { coords: new Int32Array([0, 0, E, 0, E, E, 0, E, 0, 0]), ends: [10] } }] },
	roads: { extent: E, features: [
		{ type: "LineString", id: 2, props: {}, geom: { coords: new Int32Array([100, 100, 200, 200]), ends: [4] } },          // 左上の 1/4 だけ
		{ type: "LineString", id: 3, props: {}, geom: { coords: new Int32Array([3000, 3000, 4000, 3900]), ends: [4] } },      // 右下だけ
	] },
	places: { extent: E, features: [{ type: "Point", id: 4, props: { name: "A" }, geom: { coords: new Int32Array([1000, 1000, 3000, 1000]), ends: [2, 4] } }] },
};
{
	const t = overzoomTile(tile, 1, 0, 0);   // 左上の子
	const c = t.earth.features[0].geom.coords;
	ok("面：2 倍に伸ばし子の枠へ（左上）", c[0] === 0 && c[2] === 2 * E && c[5] === 2 * E);
	ok("線：枠に掛かる物だけ", t.roads.features.length === 1 && t.roads.features[0].id === 2 && t.roads.features[0].geom.coords[2] === 400);
	ok("多点：枠の中の点だけ・1 点ごとに ends", t.places.features[0].geom.coords.length === 2 && t.places.features[0].geom.coords[0] === 2000 && t.places.features[0].geom.ends.join() === "2");
}
{
	const t = overzoomTile(tile, 1, 1, 1);   // 右下の子
	ok("右下：面は −E から E", t.earth.features[0].geom.coords[0] === -E && t.earth.features[0].geom.coords[4] === E);
	ok("右下：右下の線だけ・左上の線は落とす", t.roads.features.length === 1 && t.roads.features[0].id === 3 && t.roads.features[0].geom.coords[0] === 2 * 3000 - E);
	ok("右下：点は無い＝層ごと落とす", !t.places);
}
{
	const t = overzoomTile(tile, 3, 0, 0);   // 8 倍
	ok("3 段：8 倍", t.roads.features[0].geom.coords[0] === 800 && t.earth.features[0].geom.coords[2] === 8 * E);
	ok("元は書き換えない", tile.roads.features[0].geom.coords[0] === 100);
}
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ overzoom 全 PASS");
process.exit(fail ? 1 : 0);
