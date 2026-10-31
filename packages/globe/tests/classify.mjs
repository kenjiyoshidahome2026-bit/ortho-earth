#!/usr/bin/env node
// 面の貼り付け（分類・P0 #1・2026-10-25）の柱を組む純関数（src/classify.ts）の常設検定：
//   ・柱が閉じている（有向辺がちょうど逆向きと対になる＝多様体・向きが揃う）＝z-fail の巻き数が柱の外で 0 に戻る条件
//   ・向き＝与えた輪の回りに依らず、全部の柱で符号付き体積の符号が同じ（裏面 +1・表面 −1 が全部の柱で同じ向き）
//   ・穴・線の帯（区間＋折れ目）・日付変更線を跨ぐ面・高さ（上の蓋＝maxHeight）
// GPU の経路（深度に当てて塗る）は tests/t-classify.html（verify:ui）。
// 使い方：node packages/globe/tests/classify.mjs
import { classifyGeometry, classifyShapes } from "../src/classify.ts";
import { flatOrigin } from "../../ortho-core/src/classify.ts";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓ " + m); else { fails++; console.error("  ✗ " + m); } };
const EARTH_M = 6371008.8;
const geom = (d, o = {}) => classifyGeometry(d, { earthM: EARTH_M, ell: false, ...o });
// 有向辺の対（閉じている＋向きが揃う）
const closed = g => { const m = new Map(); for (let i = 0; i < g.idx.length; i += 3) for (let k = 0; k < 3; k++) { const a = g.idx[i + k], b = g.idx[i + (k + 1) % 3], key = a + "," + b; m.set(key, (m.get(key) || 0) + 1); } for (const [key, n] of m) { const [a, b] = key.split(","); if (n !== 1 || m.get(b + "," + a) !== 1) return false; } return true; };
// 符号付き体積（原点相対のまま＝閉じていれば原点の取り方に依らない）
const vol = g => { let v = 0; const P = i => [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]]; for (let i = 0; i < g.idx.length; i += 3) { const [a, b, c] = [P(g.idx[i]), P(g.idx[i + 1]), P(g.idx[i + 2])]; v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]); } return v / 6; };
const sq = (lng, lat, d) => [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]];

console.log("classifyShapes");
{
	const s = classifyShapes({ type: "FeatureCollection", features: [
		{ type: "Feature", geometry: { type: "Polygon", coordinates: [sq(139, 35, 0.01)] } },
		{ type: "Feature", geometry: { type: "MultiLineString", coordinates: [[[139, 35], [139.01, 35]], [[139, 35.01], [139.01, 35.01]]] } },
		{ type: "Feature", geometry: { type: "Point", coordinates: [139, 35] } },
		{ type: "Feature", geometry: null }] });
	ok(s.polys.length === 1 && s.lines.length === 2, `面 1・線 2・点は無視（${s.polys.length}/${s.lines.length}）`);
}

console.log("classifyGeometry");
{
	const ccw = geom({ type: "Polygon", coordinates: [sq(139.76, 35.68, 0.001)] });
	const cw = geom({ type: "Polygon", coordinates: [sq(139.76, 35.68, 0.001).reverse()] });
	ok(ccw && closed(ccw), "四角＝閉じている");
	ok(ccw.volumes === 1 && ccw.idx.length === (2 * 2 + 4 * 2) * 3, `四角＝蓋 2×2＋壁 4×2 の三角形（${ccw.idx.length / 3}）`);
	ok(Math.sign(vol(ccw)) === Math.sign(vol(cw)) && vol(ccw) !== 0, "輪の回りに依らず向きが同じ");
	const hole = geom({ type: "Polygon", coordinates: [sq(139.76, 35.68, 0.002), sq(139.7605, 35.6805, 0.001)] });
	ok(hole && closed(hole), "穴あき＝閉じている");
	ok(Math.sign(vol(hole)) === Math.sign(vol(ccw)) && Math.abs(vol(hole)) < Math.abs(vol(geom({ type: "Polygon", coordinates: [sq(139.76, 35.68, 0.002)] }))), "穴の分だけ体積が減る・向きは同じ");
	const line = geom({ type: "LineString", coordinates: [[139.76, 35.68], [139.761, 35.68], [139.761, 35.681]] }, { width: 6 });
	ok(line && line.volumes === 3 && closed(line), `線＝区間 2＋折れ目 1・閉じている（${line?.volumes}）`);
	ok(Math.sign(vol(line)) === Math.sign(vol(ccw)), "線の柱も同じ向き");
	const am = geom({ type: "Polygon", coordinates: [[[179.9, 10], [-179.9, 10], [-179.9, 10.1], [179.9, 10.1], [179.9, 10]]] });
	ok(am && closed(am) && Math.abs(vol(am)) < 1e-3, "日付変更線を跨ぐ面＝閉じている・地球を一周しない");
	const tall = geom({ type: "Polygon", coordinates: [sq(139.76, 35.68, 0.001)] }, { minHeight: 0, maxHeight: 500 });
	let rMax = 0, rMin = Infinity;
	for (let i = 0; i < tall.pos.length; i += 3) { const r = Math.hypot(tall.pos[i] + tall.origin[0], tall.pos[i + 1] + tall.origin[1], tall.pos[i + 2] + tall.origin[2]); rMax = Math.max(rMax, r); rMin = Math.min(rMin, r); }
	ok(Math.abs((rMax - 1) * EARTH_M - 500) < 0.5 && Math.abs((rMin - 1) * EARTH_M) < 0.5, `高さ＝0〜500m（${((rMin - 1) * EARTH_M).toFixed(2)}〜${((rMax - 1) * EARTH_M).toFixed(2)}）`);
	const big = geom({ type: "Polygon", coordinates: [sq(139, 35, 0.2)] }, { maxSegM: 2000 });
	ok(big && closed(big) && big.idx.length / 3 > 4 * 10 * 2, `辺を刻む（${big.idx.length / 3} 三角形）`);
	ok(geom({ type: "Point", coordinates: [0, 0] }) === null && geom(null) === null, "点・空＝null");
	const ell = classifyGeometry({ type: "Polygon", coordinates: [sq(139.76, 35.68, 0.001)] }, { earthM: 6378137, ell: true });
	ok(ell && closed(ell), "楕円体でも閉じている");
}

// 真俯瞰の平ら化（renderer の pf）に柱を合わせる（ortho-core classify.ts flatOrigin・2026-10-31）：原点の高さ h0 の flat 割を法線方向に下げる
{
	const R = 6378137, n = [0.6, 0.8, 0], h0 = 430 / R, o = n.map(x => x * (1 + h0));
	const hOf = p => Math.hypot(p[0], p[1], p[2]) - 1;
	ok(Math.abs(hOf(flatOrigin(o, 1)) * R) < 1e-6, `平ら（flat 1）＝原点を 0 m へ（${(hOf(flatOrigin(o, 1)) * R).toFixed(3)} m）`);
	ok(Math.abs(hOf(flatOrigin(o, 0.5)) * R - 215) < 1e-6, `半分（flat 0.5）＝215 m（${(hOf(flatOrigin(o, 0.5)) * R).toFixed(3)} m）`);
	ok(flatOrigin(o, 0).every((x, i) => x === o[i]), "flat 0＝そのまま");
	const f = flatOrigin(o, 1); ok(Math.abs(f[0] / f[1] - 0.75) < 1e-12 && f[2] === 0, "向き（法線）は変わらない");
	const far = n.map(x => x * 1.02); ok(flatOrigin(far, 1).every((x, i) => x === far[i]), "地表から 64 km を越える原点（全球の柱など）は動かさない");
	// 柱 [150, 711] m・地面 300 m：pf（＝1−flat）ごとに地面 pf·300 m が下げた柱の中にある
	for (const pf of [0, 0.25, 0.5, 1]) { const sh = (1 - pf) * 430; ok(150 - sh <= pf * 300 && pf * 300 <= 711 - sh, `pf ${pf}：地面 ${pf * 300} m が柱 [${150 - sh}, ${711 - sh}] の中`); }
}

if (fails) { console.error(`classify: ${fails} 件 NG`); process.exit(1); }
console.log("classify: 全部 OK");
