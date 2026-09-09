// t-antimeridian: encode（setFeature→antimeridianFeature）の跨ぎ切断。
// 混符号の正規化表現（±179.9…＝エディタの normLon 産）でも、範囲外の連続表現（179.9→180.1）でも同じ結果に切れること。
// ±180の縫い目に「接するだけ」のリング（南極型）は切断器に入れず無傷が正解（fix() が +180→-180 に書き換えるため）。
import { GeoPBF } from "../src/pbf-base.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const enc = async features => (await new GeoPBF({ name: "t-am" }).set({ type: "FeatureCollection", features })).features;
const lons = g => { const out = []; const walk = a => typeof a[0] === "number" ? out.push(a[0]) : a.forEach(walk); walk(g.coordinates); return out; };
const span = r => Math.max(...r) - Math.min(...r);
const F = (type, coordinates, properties = {}) => ({ type: "Feature", properties, geometry: { type, coordinates } });

// ① 混符号ポリゴン（エディタ作図/移動産）＝2片の MultiPolygon・各片は縫い目の同じ側で局所的
const mixed = [[[179.9, 35.0], [-179.9, 35.0], [-179.9, 35.2], [179.9, 35.2], [179.9, 35.0]]];
{
	const [f] = await enc([F("Polygon", structuredClone(mixed))]);
	const g = f.geometry;
	ok(g.type === "MultiPolygon" && g.coordinates.length === 2, `混符号ポリゴン＝2片に切断（実際: ${g.type}×${g.coordinates.length ?? "?"}）`);
	const spans = (g.coordinates || []).map(p => span(lons({ coordinates: p })));
	ok(spans.every(s => s <= 0.11), `各片は局所的（span ${spans.map(s => s.toFixed(3)).join("/")}）`);
	ok(lons(g).every(x => x >= -180 && x <= 180), "全経度が [-180,180] 内");
}
// ② 同じ箱の連続表現（範囲外）＝従来経路。①と同じ2片になる
{
	const cont = [[[179.9, 35.0], [180.1, 35.0], [180.1, 35.2], [179.9, 35.2], [179.9, 35.0]]];
	const [f] = await enc([F("Polygon", cont)]);
	ok(f.geometry.type === "MultiPolygon" && f.geometry.coordinates.length === 2, "連続表現（範囲外）も2片（従来経路の不変）");
}
// ③ 混符号ライン＝2本の MultiLineString
{
	const [f] = await enc([F("LineString", [[179.9, 35.0], [-179.9, 35.1], [-179.8, 35.2]])]);
	const g = f.geometry;
	ok(g.type === "MultiLineString" && g.coordinates.length === 2, `混符号ライン＝2本（実際: ${g.type}×${g.coordinates.length ?? "?"}）`);
	ok(lons(g).every(x => x >= -180 && x <= 180), "ライン全経度が [-180,180] 内");
}
// ④ 縫い目接触リング（南極型＝+180 と -180 の両方を含むが跨がない）＝無傷（切断も書き換えもしない）
{
	// 実データの南極型＝隣接差は小さく、縫い目は ±180 の同値ペアで降りる（1頂点だけの巨大差は最短経路規約で跨ぎ扱いが正当＝ここには入れない）
	const ring = [[-180, -85], [-90, -70], [0, -70], [90, -70], [180, -85], [180, -89], [-180, -89], [-180, -85]];
	const [f] = await enc([F("Polygon", [structuredClone(ring)])]);
	const g = f.geometry;
	ok(g.type === "Polygon" && g.coordinates.length === 1, `縫い目接触リング＝切断しない（実際: ${g.type}×${g.coordinates.length}）`);
	ok(lons(g).includes(180) && lons(g).includes(-180), "±180 の頂点が書き換えられていない");
}
// ⑤ 縫い目から遠い普通のポリゴン＝完全無変換
{
	const sq = [[[139.75, 35.68], [139.76, 35.68], [139.76, 35.69], [139.75, 35.69], [139.75, 35.68]]];
	const [f] = await enc([F("Polygon", structuredClone(sq))]);
	ok(f.geometry.type === "Polygon" && span(lons(f.geometry)) < 0.02, "縫い目と無関係なポリゴンは素通り");
}

console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
