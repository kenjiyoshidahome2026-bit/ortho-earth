// MapLibre の口（src/maplibre/・公式例の門 §8）の node の検定＝値の型・純粋な変換・記録・通訳の境界（呼ぶのは公開面だけ）。
// Map そのもの（エンジンを起こす）は公式例の門（scripts/verify-examples.mjs）が本物と並べて確かめる。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LngLat, LngLatBounds, MercatorCoordinate } from "../src/maplibre/geo.js";
import { lngArr, boundsArr, camOpts, viewOf } from "../src/maplibre/util.js";
import { mercatorDz } from "../src/zoomscale.js";
import { unsupported } from "../src/maplibre/report.js";
import { parseViewHash } from "../../ortho-core/src/viewurl.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const throws = f => { try { f(); return false; } catch { return true; } };

// ── LngLat ──
ok("LngLat.convert 配列・{lng}・{lon}・LngLat", [LngLat.convert([1, 2]), LngLat.convert({ lng: 1, lat: 2 }), LngLat.convert({ lon: 1, lat: 2 })].every(v => v.lng === 1 && v.lat === 2)
	&& LngLat.convert(new LngLat(1, 2)) instanceof LngLat);
ok("LngLat 緯度の範囲外と NaN は投げる", throws(() => new LngLat(0, 91)) && throws(() => new LngLat(NaN, 0)) && throws(() => LngLat.convert("x")));
ok("LngLat.wrap", new LngLat(190, 0).wrap().lng === -170 && new LngLat(-180, 0).wrap().lng === 180 && new LngLat(540, 0).wrap().lng === 180);
ok("LngLat.distanceTo 赤道の 1°＝111.195km", near(new LngLat(0, 0).distanceTo(new LngLat(1, 0)), 111195.08, 1), new LngLat(0, 0).distanceTo(new LngLat(1, 0)).toFixed(2));
ok("LngLat.toArray・toString", JSON.stringify(new LngLat(3, 4).toArray()) === "[3,4]" && new LngLat(3, 4).toString() === "LngLat(3, 4)");

// ── LngLatBounds ──
{
	const a = new LngLatBounds([-10, -5], [20, 15]), b = new LngLatBounds([-10, -5, 20, 15]), c = new LngLatBounds([[-10, -5], [20, 15]]);
	ok("LngLatBounds 3 つの作り方が同じ", [b, c].every(x => JSON.stringify(x.toArray()) === JSON.stringify(a.toArray())));
	ok("LngLatBounds の辺と中心", a.getWest() === -10 && a.getSouth() === -5 && a.getEast() === 20 && a.getNorth() === 15 && a.getCenter().lng === 5 && a.getCenter().lat === 5);
	const e = new LngLatBounds(); e.extend([1, 1]).extend(new LngLat(-2, 3)).extend([[5, -4], [6, 0]]);
	ok("LngLatBounds.extend（点・LngLat・範囲）", JSON.stringify(e.toArray()) === "[[-2,-4],[6,3]]", JSON.stringify(e.toArray()));
	// 西＞東の範囲は MapLibre 6.11.2 の実装どおり「東〜西の間」を含む（直感とは逆だが、物差しは同じ答え＝本物の dist で確かめた）
	ok("LngLatBounds.contains（西＞東は MapLibre と同じ答え）", a.contains([0, 0]) && !a.contains([30, 0]) && new LngLatBounds([170, -10], [-170, 10]).contains([0, 0]) && !new LngLatBounds([170, -10], [-170, 10]).contains([180, 0]));
	ok("LngLatBounds.isEmpty", new LngLatBounds().isEmpty() && !a.isEmpty());
	const r = LngLatBounds.fromLngLat([0, 0], 111195.08);
	ok("LngLatBounds.fromLngLat 半径", near(r.getNorth(), 1, 1e-3) && near(r.getEast(), 1, 1e-3));
}

// ── MercatorCoordinate ──
{
	const m0 = MercatorCoordinate.fromLngLat([0, 0]);
	ok("MercatorCoordinate (0,0)＝(0.5,0.5)", near(m0.x, 0.5) && near(m0.y, 0.5));
	const ll = MercatorCoordinate.fromLngLat([139.7, 35.7], 100).toLngLat();
	ok("MercatorCoordinate 往復", near(ll.lng, 139.7, 1e-9) && near(ll.lat, 35.7, 1e-9));
	ok("MercatorCoordinate 高さの往復", near(MercatorCoordinate.fromLngLat([10, 45], 1234).toAltitude(), 1234, 1e-6));
	ok("MercatorCoordinate.meterInMercatorCoordinateUnits（赤道）", near(m0.meterInMercatorCoordinateUnits(), 1 / (2 * Math.PI * 6371008.8), 1e-18));
}

// ── 純粋な変換 ──
{
	const v = parseViewHash(viewOf({ center: new LngLat(139.5, 35.25), zoom: 6, pitch: 45, bearing: -30 }));
	ok("viewOf＝エンジンの z（MapLibre の z＋dz）・緯度が先・度", near(v.zoom, 7) && v.lat === 35.25 && v.lon === 139.5 && near(v.pitch, 45 * Math.PI / 180) && near(v.bearing, -30 * Math.PI / 180));
	const vm = parseViewHash(viewOf({ center: new LngLat(0, 60), zoom: 6, pitch: 0, bearing: 0 }, mercatorDz(60)));
	ok("viewOf の mercator＝北緯 60° で +2（log2 sec 60°＝1）", near(vm.zoom, 8, 1e-6), vm.zoom.toFixed(4));
	const vx = parseViewHash(viewOf({ center: new LngLat(-121.403732, 40.492392), zoom: 10, pitch: 0, bearing: 0 }, mercatorDz(40.492392)));
	ok("viewOf は z を丸めない（戻すと 10 ちょうど＝1e-9 以内）", Math.abs(vx.zoom - mercatorDz(40.492392) - 10) < 1e-9, String(vx.zoom - mercatorDz(40.492392)));
	ok("lngArr", JSON.stringify(lngArr(new LngLat(1, 2))) === "[1,2]" && JSON.stringify(lngArr({ lon: 1, lat: 2 })) === "[1,2]");
	ok("boundsArr（LngLatBounds・[w,s,e,n]・[[w,s],[e,n]]）", [new LngLatBounds([1, 2], [3, 4]), [1, 2, 3, 4], [[1, 2], [3, 4]]].every(b => JSON.stringify(boundsArr(b)) === "[[1,2],[3,4]]"));
	const co = camOpts({ center: new LngLat(5, 6), zoom: 3 });
	ok("camOpts は center を配列に・他は写す", JSON.stringify(co.center) === "[5,6]" && co.zoom === 3 && JSON.stringify(camOpts({ zoom: 1 })) === '{"zoom":1}');
}

// ── 記録（1 口 1 回・地図ごと）──
{
	const seen = [], warn = console.warn;
	console.warn = m => seen.push(m);
	const a = {}, b = {};
	unsupported(a, "x()"); unsupported(a, "x()"); unsupported(b, "x()"); unsupported(a, "y", "cosmetic");
	console.warn = warn;
	ok("unsupported は地図ごと・口ごとに 1 回・書式", seen.length === 3 && seen[0] === "[mlshim] unsupported: x() (semantic)" && seen[2] === "[mlshim] unsupported: y (cosmetic)", JSON.stringify(seen));
}

// ── 通訳の境界：呼ぶのは ../globe.js の公開面だけ（RAW・core・内部の部品を import しない）──
{
	const dir = path.join(HERE, "../src/maplibre"), bad = [];
	for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".js"))) {
		const src = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\/.*$/gm, "");
		for (const m of src.matchAll(/\bfrom\s+["']([^"']+)["']/g)) if (!/^\.\/[\w-]+\.js$/.test(m[1]) && m[1] !== "../globe.js") bad.push(`${f}: ${m[1]}`);
		if (/\bRAW\b|Symbol\.for\(["']ortho-earth\.map\.raw/.test(src)) bad.push(`${f}: RAW`);
	}
	ok("通訳の import は ../globe.js と同じ家の部品だけ・RAW 無し", !bad.length, bad.join(" "));
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ mlshim 全 PASS");
// ── createTileMesh／細分の粒度（MapLibre 同名・custom 層のタイル格子）──
{
	const { createTileMesh, SubdivisionGranularityExpression, GRANULARITY_GLOBE, NORTH_POLE_Y, SOUTH_POLE_Y, EXTENT } = await import("../src/maplibre/tilemesh.js");
	const m1 = createTileMesh({ granularity: 1 }, "16bit"), v1 = new Int16Array(m1.vertices), i1 = new Uint16Array(m1.indices);
	ok("createTileMesh 粒度 1＝4 頂点・6 索引", v1.length === 8 && i1.length === 6 && !m1.uses32bitIndices, `${v1.length} ${i1.length}`);
	ok("createTileMesh 0..EXTENT", Math.min(...v1) === 0 && Math.max(...v1) === EXTENT);
	const m2 = createTileMesh({ granularity: 4, extendToNorthPole: true, extendToSouthPole: true }, "16bit"), v2 = new Int16Array(m2.vertices), i2 = new Uint16Array(m2.indices);
	ok("createTileMesh 極を足す＝(5)×(7) 頂点・4×6×6 索引", v2.length === 5 * 7 * 2 && i2.length === 4 * 6 * 6, `${v2.length} ${i2.length}`);
	ok("createTileMesh 極の y＝-32768／32767", v2[1] === NORTH_POLE_Y && v2[v2.length - 1] === SOUTH_POLE_Y, `${v2[1]} ${v2[v2.length - 1]}`);
	const m3 = createTileMesh({ granularity: 2, generateBorders: true }, "16bit"), v3 = new Int16Array(m3.vertices);
	ok("createTileMesh 縁＝-64／EXTENT+64", Math.min(...v3) === -64 && Math.max(...v3) === EXTENT + 64, `${Math.min(...v3)} ${Math.max(...v3)}`);
	ok("createTileMesh 16bit に収まらない粒度は投げる", throws(() => createTileMesh({ granularity: 300 }, "16bit")));
	ok("createTileMesh 32bit を強いる", createTileMesh({ granularity: 1 }, "32bit").uses32bitIndices === true);
	ok("粒度の式＝max(floor(base/2^z), min, 1)", new SubdivisionGranularityExpression(128, 32).getGranularityForZoomLevel(0) === 128 && new SubdivisionGranularityExpression(128, 32).getGranularityForZoomLevel(3) === 32 && new SubdivisionGranularityExpression(128, 32).getGranularityForZoomLevel(9) === 32 && new SubdivisionGranularityExpression(4, 0).getGranularityForZoomLevel(9) === 1);
	ok("球の既定＝tile (128, 32)", GRANULARITY_GLOBE.tile.getGranularityForZoomLevel(1) === 64 && GRANULARITY_GLOBE.circle === 3);
	ok("min > base は投げる", throws(() => new SubdivisionGranularityExpression(1, 2)));
}
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ mlshim 全 PASS");
process.exit(fail ? 1 : 0);
