#!/usr/bin/env node
// t-common: 共通化した小道具（改良点 15・2026-10-12）＝ modules/varint.ts・modules/mercator.ts・modules/now.ts と、
//   convert/proj.js の本初子午線・角度単位・順変換（fromLonLat）。
import { readUvarint, readSvarint, writeUvarint, writeSvarint, zigzagEncode, zigzagDecode } from "../src/modules/varint.ts";
import { mercToLonLat, lonLatToMerc, worldToLonLat, lonLatToWorld, worldYToLat, latToWorldY, mercYToLat, R_MERC } from "../src/modules/mercator.ts";
import { now } from "../src/modules/now.ts";
import { crsFromWKT, tmForward, tmInverse } from "../src/convert/proj.js";
import { epsgToWKT } from "../src/convert/epsg.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const near = (a, b, eps) => Math.abs(a - b) <= eps;

{   // varint
	const vals = [0, 1, 127, 128, 300, 16383, 16384, 2 ** 31 - 1, 2 ** 32, 2 ** 53 - 1];
	const buf = new Uint8Array(vals.length * 10); let p = 0;
	for (const v of vals) p = writeUvarint(buf, p, v);
	const c = { pos: 0 }, back = vals.map(() => readUvarint(buf, c));
	ok(back.join() === vals.join() && c.pos === p, `uvarint 往復 ${vals.length} 値（${p} B・2^53−1 まで）`);
	ok(buf[0] === 0 && buf[1] === 1 && buf[2] === 127 && buf[3] === 0x80 && buf[4] === 1, "LEB128 のバイト並び（128 = 80 01）");
	const sv = [0, -1, 1, -2, 2, -(2 ** 31), 2 ** 31 - 1, -(2 ** 52), 2 ** 52];
	p = 0; for (const v of sv) p = writeSvarint(buf, p, v);
	c.pos = 0; ok(sv.map(() => readSvarint(buf, c)).join() === sv.join(), "svarint（zigzag）往復・負数");
	ok(zigzagEncode(-1) === 1 && zigzagEncode(1) === 2 && zigzagDecode(1) === -1 && zigzagDecode(2) === 1, "zigzag の対応（-1→1・1→2）");
	let threw = null; try { readUvarint(new Uint8Array([0x80, 0x80]), { pos: 0 }); } catch (e) { threw = e.message; }
	ok(threw && /truncated/.test(threw), `切れた varint は例外: ${threw}`);
}
{   // mercator
	const ll = [139.767125, 35.681236];
	const m = lonLatToMerc(ll), b = mercToLonLat(m);
	ok(near(m[0], 15558805.184639815, 1e-6) && near(b[0], ll[0], 1e-12) && near(b[1], ll[1], 1e-12), "メートル: 往復 1e-12 度・東京駅 x＝15558805.18");
	const w = lonLatToWorld(ll), wb = worldToLonLat(w);
	ok(near(wb[0], ll[0], 1e-12) && near(wb[1], ll[1], 1e-12) && w[0] > 0.888 && w[0] < 0.889 && w[1] > 0.39 && w[1] < 0.40, "世界座標 0..1: 往復 1e-12 度");
	ok(worldYToLat(0.5) === 0 && near(worldYToLat(0), 85.05112878, 1e-7) && near(latToWorldY(90), 0, 1e-9) && near(latToWorldY(-90), 1, 1e-9), "世界座標の端: y=0.5→0°・y=0→85.0511°・±90° は留める");
	ok(near(mercYToLat(0), 0, 0) && near(mercYToLat(Math.PI * R_MERC), 85.05112878, 1e-7), "mercYToLat（proj.js / featureservice の旧式と同値）");
	// 旧式（各所にあった写し）と同値
	const D = 180 / Math.PI, oldW = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * D, oldM = ([x, y]) => [x / R_MERC * D, (2 * Math.atan(Math.exp(y / R_MERC)) - Math.PI / 2) * D];
	let worst = 0; for (let i = 0; i <= 100; i++) { const y = i / 100; worst = Math.max(worst, Math.abs(oldW(y) - worldYToLat(y))); const q = oldM([i * 1e5, (i - 50) * 2e5]), r = mercToLonLat([i * 1e5, (i - 50) * 2e5]); worst = Math.max(worst, Math.abs(q[0] - r[0]), Math.abs(q[1] - r[1])); }
	ok(worst === 0, `旧式と bit 同一（最大差 ${worst}）`);
}
{   // now
	const a = now(), b = now();
	ok(typeof a === "number" && b >= a, "now(): 数値・単調");
}
{   // proj: fromLonLat / PRIMEM / angular unit / Karney TM
	for (const code of [6677, 2443, 32654, 32754, 3857, 3395]) {
		const wkt = code === 3395 ? 'PROJCS["WGS 84 / World Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","3395"]]' : epsgToWKT(code);
		const c = crsFromWKT(wkt);
		let worst = 0;
		for (const ll of [[139.767125, 35.681236], [141, -35], [138.2, 37.9], [135, 34.7]]) { if (code === 32754 && ll[1] > 0) continue; const b = c.toLonLat(c.fromLonLat(ll)); worst = Math.max(worst, Math.abs(b[0] - ll[0]), Math.abs(b[1] - ll[1])); }
		ok(c.kind === "projected" && typeof c.fromLonLat === "function" && worst < 1e-9, `${c.label}: fromLonLat→toLonLat 往復 ${worst.toExponential(1)} 度 < 1e-9`);
	}
	const ix = crsFromWKT(epsgToWKT(6677));
	const o = ix.fromLonLat([139 + 50 / 60, 36]), t = ix.fromLonLat([139.767125, 35.681236]);
	ok(near(o[0], 0, 1e-6) && near(o[1], 0, 1e-6), "平面直角 IX: 原点 (36N, 139°50′E) → (0, 0)");
	ok(near(t[0], -5992.9196, 5e-4) && near(t[1], -35363.2377, 5e-4), `平面直角 IX: 東京駅 → Y=${t[0].toFixed(4)} X=${t[1].toFixed(4)}（GSI の値 −5992.9196 / −35363.2377 と 0.5 mm 以内）`);
	const paris = crsFromWKT('GEOGCS["NTF (Paris)",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Paris",2.5969213],UNIT["grad",0.01570796326794897]]');
	const p = paris.toLonLat([0, 50]), q = paris.fromLonLat(p);
	ok(paris.toLonLat && near(p[0], 2.33722917, 1e-6) && near(p[1], 45, 1e-9) && near(q[0], 0, 1e-9) && near(q[1], 50, 1e-9), `PRIMEM Paris（2.5969213 grad）＋grad: [0, 50 grad] → [${p[0].toFixed(6)}, ${p[1]}]・往復`);
	const parisTM = crsFromWKT('PROJCS["NTF (Paris) / Lambert-ish TM",GEOGCS["NTF (Paris)",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Paris",2.5969213],UNIT["grad",0.01570796326794897]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",50],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]');
	const ll0 = parisTM.toLonLat([0, 0]);
	ok(near(ll0[0], 2.33722917, 1e-6) && near(ll0[1], 45, 1e-9), `投影のパラメタも grad・Paris 基準で読む: 原点 → [${ll0[0].toFixed(6)}, ${ll0[1]}]`);
	const deg = crsFromWKT(epsgToWKT(4326));
	ok(deg.kind === "lonlat" && !deg.toLonLat, "degree・Greenwich の経緯度は lonlat のまま（変換なし）");
	// Karney TM: 中央経線から 3° 離れた点でも往復が機械精度・lat0 付きの北距＝原点で 0
	const K = { a: 6378137, f: 1 / 298.257222101, k0: 0.9999, lat0: 36, lon0: 139 + 50 / 60, fe: 0, fn: 0 };
	const f = tmForward(K), i = tmInverse(K), bk = i(...f([142.9, 40.2]));
	ok(near(bk[0], 142.9, 1e-11) && near(bk[1], 40.2, 1e-11) && f([K.lon0, K.lat0])[1] === 0, "Krüger 6 次: 中央経線から 3° で往復 1e-11 度・原点の北距 0");
}
if (fails) { console.error(`${fails} 件失敗`); process.exit(1); }
console.log("全件通過");
