#!/usr/bin/env node
// t-shape: Shapefile（zip）→ GeoPBF の worker（src/decoder/shape.js）を Node で直に回す。
// 自治体の地番図で踏んだ 4 点の回帰：① M 値付き（PolygonM=25）② 外周が反時計回り（仕様と逆）③ 拡張子が大文字＋平面直角座標系の .prj
// ④ null shape が混ざっても DBF とずれない。加えて .prj 無し＋opts.crs（EPSG 番号）で経緯度へ戻ること。
globalThis.ImageData ??= class ImageData { };
import { GeoPBF } from "../src/pbf.js";
import { encodeZIP } from "../src/modules/encodeZIP.js";
import { epsgToWKT } from "../src/convert/epsg.js";
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// ── 最小 Shapefile の組み立て ──
// 平面直角 IX 系（EPSG 6677・原点 36°N 139°50′E）の原点付近に 100 m 角の筆を 2 つ＋null shape 1 つ
const SQ = (x0, y0, ccw) => { const r = [[x0, y0], [x0 + 100, y0], [x0 + 100, y0 + 100], [x0, y0 + 100], [x0, y0]]; return ccw ? r : r.reverse(); };
const records = [{ ring: SQ(0, 0, true) }, null, { ring: SQ(200, 0, false) }];   // ① 反時計回り ② null shape ③ 時計回り（仕様どおり）
function shp(type) {
	const bodies = records.map(r => {
		if (!r) { const b = new DataView(new ArrayBuffer(4)); b.setInt32(0, 0, true); return b.buffer; }
		const n = r.ring.length, bytes = 4 + 32 + 4 + 4 + 4 + 16 * n + 16 + 8 * n;   // PolygonM＝XY の後ろに M 範囲と M 配列
		const b = new DataView(new ArrayBuffer(bytes)); let o = 0;
		b.setInt32(o, type, true); o += 4;
		const xs = r.ring.map(p => p[0]), ys = r.ring.map(p => p[1]);
		[Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach(v => { b.setFloat64(o, v, true); o += 8; });
		b.setInt32(o, 1, true); o += 4; b.setInt32(o, n, true); o += 4; b.setInt32(o, 0, true); o += 4;
		r.ring.forEach(([x, y]) => { b.setFloat64(o, x, true); b.setFloat64(o + 8, y, true); o += 16; });
		b.setFloat64(o, 0, true); b.setFloat64(o + 8, 9, true); o += 16;
		r.ring.forEach((_, i) => { b.setFloat64(o, i, true); o += 8; });
		return b.buffer;
	});
	const total = 100 + bodies.reduce((s, b) => s + 8 + b.byteLength, 0);
	const out = new Uint8Array(total), h = new DataView(out.buffer);
	h.setInt32(0, 9994, false); h.setInt32(24, total / 2, false); h.setInt32(28, 1000, true); h.setInt32(32, type, true);
	[0, 0, 300, 100].forEach((v, i) => h.setFloat64(36 + i * 8, v, true));
	let p = 100;
	bodies.forEach((b, i) => { h.setInt32(p, i + 1, false); h.setInt32(p + 4, b.byteLength / 2, false); out.set(new Uint8Array(b), p + 8); p += 8 + b.byteLength; });
	return out;
}
function dbf(names) {
	const fl = 10, rec = 1 + fl, head = 32 + 32 + 1, out = new Uint8Array(head + rec * names.length + 1), d = new DataView(out.buffer);
	out[0] = 3; d.setUint32(4, names.length, true); d.setUint16(8, head, true); d.setUint16(10, rec, true);
	out.set(new TextEncoder().encode("NAME"), 32); out[32 + 11] = "C".charCodeAt(0); out[32 + 16] = fl; out[64] = 0x0d;
	names.forEach((s, i) => { const o = head + i * rec; out[o] = 0x20; out.set(new TextEncoder().encode(s.padEnd(fl)), o + 1); });
	out[out.length - 1] = 0x1a;
	return out;
}

// ── worker を Node で回す（onmessage / postMessage の差し替え）──
let resolveMsg;
globalThis.postMessage = m => resolveMsg(m);
globalThis.onmessage = null;   // worker の「onmessage = …」代入先（module は strict＝未宣言の代入は ReferenceError）
await import("../src/decoder/shape.js");
const run = data => new Promise(r => { resolveMsg = r; globalThis.onmessage({ data }); });
const decode = async (files, extra = {}) => {
	const zip = await encodeZIP(files, "t.zip");
	const m = await run({ file: zip, encoding: "utf8", precision: 7, ...extra });
	return m?.data ? new GeoPBF().set(m.data) : null;
};
const lonlat = pbf => pbf.getGeometry(0).coordinates[0][0];

// ① ② ③ ④：PolygonM・反時計回り・大文字拡張子＋ .prj（JGD2011 平面直角 IX 系）・null shape
{
	const pbf = await decode([
		new File([shp(25)], "T/POLY.SHP"),
		new File([dbf(["A", "B", "C"])], "T/POLY.DBF"),
		new File([epsgToWKT(6677)], "T/POLY.PRJ"),
	]);
	ok(pbf && pbf.length === 2, `PolygonM＋null shape＝形のある 2 件（${pbf?.length}）`);
	ok(pbf?.getProperties(0).NAME === "A" && pbf?.getProperties(1).NAME === "C", `null shape の後も属性がずれない（A, C ＝ ${pbf?.getProperties(0).NAME}, ${pbf?.getProperties(1).NAME}）`);
	ok(pbf?.getGeometry(0).type === "Polygon", "反時計回りの外周も面として拾う");
	const [lon, lat] = pbf ? lonlat(pbf) : [0, 0];
	ok(Math.abs(lon - (139 + 50 / 60)) < 1e-4 && Math.abs(lat - 36) < 1e-4, `平面直角 IX 系の原点付近 → 経緯度（${lon.toFixed(5)}, ${lat.toFixed(5)}）`);
}
// .prj 無し＋ opts.crs（EPSG 番号）
{
	const pbf = await decode([new File([shp(5)], "T/p.shp"), new File([dbf(["A", "B", "C"])], "T/p.dbf")], { crs: 6677 });
	const [lon, lat] = pbf ? lonlat(pbf) : [0, 0];
	ok(pbf?.length === 2 && Math.abs(lat - 36) < 1e-4, `.prj 無しは opts.crs で経緯度へ（${pbf?.length} 件・${lat.toFixed(5)}）`);
}
// 経緯度の .prj は無変換
{
	const deg = records.map(r => r && { ring: r.ring.map(([x, y]) => [135 + x / 1e4, 35 + y / 1e4]) });
	records.splice(0, 3, ...deg);
	const pbf = await decode([new File([shp(5)], "g.shp"), new File([dbf(["A", "B", "C"])], "g.dbf"), new File([epsgToWKT(6668)], "g.prj")]);
	const [lon, lat] = pbf ? lonlat(pbf) : [0, 0];
	ok(Math.abs(lon - 135) < 1e-6 && Math.abs(lat - 35) < 1e-6, `JGD2011 経緯度はそのまま（${lon}, ${lat}）`);
}
console.log(fails ? `\n✗ ${fails} failed` : "\nPASS");
process.exit(fails ? 1 : 0);
