// 静岡県の点群の頁の図郭と座標（pointcloud-sheets.ts）の検定。node tests/t-pointcloud.mjs
//  ① VIII 系の換算＝geopbf/proj（EPSG:6676・エンジンの点群が使う式）と 1 mm 以内・往復が戻る
//  ② 図郭の番号 ⇄ 範囲（県の LAS のヘッダの範囲と合う 3 図郭）・小文字の階層名
import assert from "node:assert/strict";
import { crsFromWKT } from "geopbf/proj";
import { epsgToWKT } from "geopbf/epsg";
import { toPlane, toLonLat, sheetBox, sheetAt, sheetRing } from "../pointcloud-sheets.ts";

let tn = 0;
const t = (name, fn) => { fn(); tn++; console.log("  ✔", name); };
const ref = crsFromWKT(epsgToWKT(6676));
t("① VIII 系の換算＝geopbf/proj と 1 mm 以内・往復", () => {
	for (const [e, nn] of [[0, 0], [-40400, -72900], [35600, -67200], [-52800, -82500], [23000, -101000], [-150000, 250000]]) {
		const ll = toLonLat(e, nn), r = ref.toLonLat([e, nn]);
		const dLon = (ll[0] - r[0]) * 111320 * Math.cos(ll[1] * Math.PI / 180), dLat = (ll[1] - r[1]) * 110950;
		assert.ok(Math.hypot(dLon, dLat) < 1e-3, `${e},${nn}: ${dLon},${dLat}`);
		const back = toPlane(...ll);
		assert.ok(Math.hypot(back[0] - e, back[1] - nn) < 1e-3, `round trip ${back}`);
	}
	const o = toLonLat(0, 0); assert.ok(Math.abs(o[0] - 138.5) < 1e-8 && Math.abs(o[1] - 36) < 1e-8);
});
t("② 図郭の番号 ⇄ 範囲（県の LAS のヘッダ）", () => {
	// 08MC4919＝X −40138〜−40000・Y −72600〜−72441（図郭の一部だけに点）・08MC7648＝X −52800〜−52400・Y −82500〜−82200・08ME2849＝X 35600〜36000・Y −67500〜−67200
	assert.deepEqual(sheetBox("MC4919"), [-40400, -72600, -40000, -72300]);
	assert.deepEqual(sheetBox("mc7648"), [-52800, -82500, -52400, -82200]);
	assert.deepEqual(sheetBox("ME2849"), [35600, -67500, 36000, -67200]);
	assert.deepEqual(sheetBox("MC49"), [-44000, -75000, -40000, -72000]);
	assert.deepEqual(sheetBox("MC"), [-80000, -90000, -40000, -60000]);
	assert.equal(sheetBox("ZZ"), null); assert.equal(sheetBox("MC491"), null);
	for (const code of ["MC4919", "MC7648", "ME2849", "NF2392"]) { const b = sheetBox(code); assert.equal(sheetAt((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, "500"), code); assert.equal(sheetAt(b[0] + 1, b[3] - 1, "5000"), code.slice(0, 4)); }
	assert.equal(sheetAt(0, 400000, "500"), null);
	const ring = sheetRing(sheetBox("NF2392"));   // 熱海（見本の図郭）
	assert.equal(ring.length, 5); assert.ok(ring.every(([lon, lat]) => lon > 139.07 && lon < 139.1 && lat > 35.09 && lat < 35.12), JSON.stringify(ring));
});
console.log(`t-pointcloud: ${tn} 件 OK`);
