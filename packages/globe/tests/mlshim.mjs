// MapLibre の口（src/maplibre/・公式例の門 §8）の node の検定＝値の型・純粋な変換・記録・通訳の境界（呼ぶのは公開面だけ）。
// Map そのもの（エンジンを起こす）は公式例の門（scripts/verify-examples.mjs）が本物と並べて確かめる。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LngLat, LngLatBounds, MercatorCoordinate } from "../src/maplibre/geo.js";
import { lngArr, boundsArr, camOpts, viewOf } from "../src/maplibre/util.js";
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
	ok("viewOf＝エンジンの z（MapLibre の z＋1）・緯度が先・度", near(v.zoom, 7) && v.lat === 35.25 && v.lon === 139.5 && near(v.pitch, 45 * Math.PI / 180) && near(v.bearing, -30 * Math.PI / 180));
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
process.exit(fail ? 1 : 0);
