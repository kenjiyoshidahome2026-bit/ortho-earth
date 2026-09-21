// t-imagequad: 四隅で貼る画像（edit/imagequad）＝写像の正しさ・四隅の順が編集モデル/GeoPBF の往復で保たれるか（node tests/edit/t-imagequad.mjs）
import { quadMapping, cornersOf, quadPolygon, placeCorners, isImageFeature, apply3, IMAGE_KEY } from "../../src/edit/imagequad.js";
import { buildTopology } from "../../src/edit/topo-extract.js";
import { createModel } from "../../src/edit/model.js";
globalThis.ImageData ??= class ImageData { };
import { GeoPBF } from "../../src/pbf.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const near = (a, b, e = 1e-9) => Math.abs(a[0] - b[0]) < e && Math.abs(a[1] - b[1]) < e;
const C = [[139.70, 35.70], [139.80, 35.71], [139.79, 35.60], [139.71, 35.62]];   // 台形（左上→右上→右下→左下）

// ---- 写像 ----
const m = quadMapping(C);
ok([[0, 0], [1, 0], [1, 1], [0, 1]].every(([u, v], k) => near(m.uvToLonLat(u, v), C[k])), "uv の四隅が経緯度の四隅へ");
const back = apply3(m.Hi, ...apply3(m.H, 0.3, 0.7));
ok(near(back, [0.3, 0.7]), "逆写像で uv に戻る");
ok(m.bbox[0] <= 139.70 && m.bbox[2] >= 139.80 && m.bbox[1] <= 35.60 && m.bbox[3] >= 35.71, "bbox が四隅を含む");
{
	const x = quadMapping([[179.9, 10], [-179.9, 10], [-179.9, 9.9], [179.9, 9.9]]);   // 日付変更線を跨ぐ
	ok(x.mercBox[2] - x.mercBox[0] < 0.01, "日付変更線を跨いでも一続き（裏回りしない）");
}
const pc = placeCorners([139.7, 35.7], 1000, 0.5);
ok(pc[0][1] > pc[3][1] && pc[1][0] > pc[0][0], "placeCorners＝北向き・左上から");

// ---- 四隅の順 ----
ok(JSON.stringify(cornersOf(quadPolygon(C))) === JSON.stringify(C), "Polygon ⇄ 四隅（時計回り）");
ok(JSON.stringify(cornersOf({ type: "Polygon", coordinates: [[C[0], C[3], C[2], C[1], C[0]]] })) === JSON.stringify(C), "反時計回りに巻き直された環は先頭を保って戻す");
ok(cornersOf({ type: "Polygon", coordinates: [[...C, [139.75, 35.65], C[0]]] }) === null, "5 頂点は画像でない");
ok(isImageFeature({ type: "Feature", properties: { [IMAGE_KEY]: new Blob([new Uint8Array(4)]) }, geometry: quadPolygon(C) }), "isImageFeature");

// ---- 編集モデル（geoedit の真実源）の往復：頂点を 1 つ動かしても先頭（左上）と巡回の向きが崩れない ----
{
	const fc = { type: "FeatureCollection", features: [
		{ type: "Feature", properties: { [IMAGE_KEY]: "img" }, geometry: quadPolygon(C) },
		{ type: "Feature", properties: { n: "neighbour" }, geometry: { type: "Polygon", coordinates: [[C[1], [139.9, 35.71], [139.9, 35.60], C[2], C[1]]] } },   // 右辺を共有する隣
	] };
	const model = createModel(buildTopology(fc, 6));
	const img = () => model.toGeoJSON().features.find(f => f.properties[IMAGE_KEY] === "img");
	ok(JSON.stringify(cornersOf(img().geometry)) === JSON.stringify(C), "モデル往復で四隅の順が保たれる（共有辺あり）");
	// 左下（C[3]）を動かす
	let hit = null;
	for (const [id, a] of model.arcs) for (let i = 0; i < a.pts.length / 2; i++) if (near([a.pts[i * 2], a.pts[i * 2 + 1]], C[3], 1e-6)) hit = [id, i];
	model.applyCmd({ op: "move", addr: model.addrOf(hit[0], hit[1]), from: C[3], to: [139.705, 35.615] });
	const c2 = cornersOf(img().geometry);
	ok(!!c2 && near(c2[0], C[0], 1e-6) && near(c2[1], C[1], 1e-6) && near(c2[2], C[2], 1e-6) && near(c2[3], [139.705, 35.615], 1e-6), "頂点移動後も 左上→右上→右下→左下", JSON.stringify(c2));
}

// ---- GeoPBF の往復：画像の Blob と四隅 ----
{
	const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: "image/png" });
	const pbf = await new GeoPBF().set({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "map", [IMAGE_KEY]: png, "@opacity": 0.6 }, geometry: quadPolygon(C) }] });
	const f = (await new GeoPBF().set(pbf.arrayBuffer)).geojson.features[0];
	ok(f.properties[IMAGE_KEY] instanceof Blob && f.properties[IMAGE_KEY].size === 7, "GeoPBF 往復で画像（Blob）が残る");
	const c3 = cornersOf(f.geometry);
	ok(!!c3 && c3.every((p, k) => near(p, C[k], 1e-6)), "GeoPBF 往復で四隅の順が残る", JSON.stringify(c3));
	ok(f.properties["@opacity"] === 0.6, "@opacity が残る");
}

console.log(fails ? `\nFAIL ${fails}` : "\nPASS");
process.exit(fails ? 1 : 0);
