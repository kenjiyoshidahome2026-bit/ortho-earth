// 図郭を並べる時の純関数（pc-sheet.ts・2026-11-07）の検定。node tests/t-pc-sheet.mjs
//  ① 分類の組 → 残す表・分類で落とす（借りた点の数も合わせる）
//  ② 隣の図郭（8 近傍）
//  ③ 隣の縁の点を借りる＝自分の錨の東北上に置き直す（1 mm 以内）・自分の範囲の内と margin の外は借りない・隣が借りていた点は借りない
import assert from "node:assert/strict";
import { CLASS_GROUPS, classKeep, filterClasses, neighborCodes, edgeMargin, edgePoints, withGhosts } from "../pc-sheet.ts";
import { sheetBox, toLonLat } from "../pointcloud-sheets.ts";

let tn = 0;
const t = (name, fn) => { fn(); tn++; console.log("  ✔", name); };
const R = 6371000, D2R = Math.PI / 180;
// 図郭（平面直角 VIII 系の範囲）に格子の点（間隔 step m）を置く＝錨は図郭の中心・東北上は dumpEnu と同じ式
function sheetPoints(code, step = 5, cls = () => 2) {
	const b = sheetBox(code), c = toLonLat((b[0] + b[2]) / 2, (b[1] + b[3]) / 2), anchor = [c[0], c[1], 50];
	const ce = Math.cos(anchor[1] * D2R) * D2R * R, cn = D2R * R, P = [], E = [], C = [];
	for (let x = b[0] + step / 2; x < b[2]; x += step) for (let y = b[1] + step / 2; y < b[3]; y += step) {
		const ll = toLonLat(x, y), e = (ll[0] - anchor[0]) * ce, n = (ll[1] - anchor[1]) * cn, h = 50 + 0.01 * x;
		P.push(e, n, h - anchor[2] - (e * e + n * n) / (2 * R)); E.push(h); C.push(cls(x, y));
	}
	const n = E.length, pts = new Float32Array(P), bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { bb[k] = Math.min(bb[k], pts[i * 3 + k]); bb[k + 3] = Math.max(bb[k + 3], pts[i * 3 + k]); }
	return { n, anchor, pts, elev: new Float32Array(E), rgb: null, intensity: new Uint16Array(n), cls: new Uint8Array(C), bb };
}
t("① 分類の組 → 残す表・分類で落とす", () => {
	assert.equal(classKeep(CLASS_GROUPS.map(g => g.id)), null);
	const k = classKeep(["building", "other"]);
	assert.ok(k[6] && !k[2] && !k[3] && k[0] && k[1] && k[7] && !k[9] && !k[17]);
	const d = sheetPoints("MC4919", 10, x => (Math.floor(x) % 2 ? 6 : 2));
	const g = withGhosts(d, [{ n: 3, pts: new Float32Array(9), elev: new Float32Array(3), rgb: null, intensity: new Uint16Array(3), cls: new Uint8Array([6, 2, 6]) }]);
	assert.equal(g.ghost, 3); assert.equal(g.n, d.n + 3);
	const f = filterClasses(g, classKeep(["building"]));
	assert.ok(f.cls.every(c => c === 6)); assert.equal(f.ghost, 2);
	assert.equal(f.n, Array.from(d.cls).filter(c => c === 6).length + 2);
	assert.equal(filterClasses(d, null), d);
	assert.equal(filterClasses(d, classKeep(["water"])).n, 0);
});
t("② 隣の図郭（8 近傍）", () => {
	const nb = neighborCodes("MC4919");
	assert.equal(nb.length, 8); assert.equal(new Set(nb).size, 8);
	const b = sheetBox("MC4919");
	for (const c of nb) { const o = sheetBox(c); assert.ok(Math.abs(o[0] - b[0]) <= 400 && Math.abs(o[1] - b[1]) <= 300 && !(o[0] === b[0] && o[1] === b[1]), c); }
	assert.ok(neighborCodes("MC4910").includes("MC4909") || neighborCodes("MC4910").length === 8);   // 5000 の区画の境を越える
	assert.deepEqual(neighborCodes("ZZ0000"), []);
});
t("③ 隣の縁の点を借りる＝自分の錨に置き直す・範囲の内と外は借りない", () => {
	const b = sheetBox("MC4919"), east = neighborCodes("MC4919").find(c => sheetBox(c)[0] === b[2] && sheetBox(c)[1] === b[1]);
	const own = sheetPoints("MC4919"), nb = sheetPoints(east), margin = edgeMargin(own.bb);
	assert.ok(margin >= 4 && margin <= 40, String(margin));
	const e = edgePoints(own, nb, margin);
	assert.ok(e.n > 0 && e.n < nb.n / 4, `${e.n} of ${nb.n}`);
	// 借りた点＝自分の東の縁の外 margin m 以内・北南は自分の範囲（＋margin）
	for (let i = 0; i < e.n; i++) { const x = e.pts[i * 3], y = e.pts[i * 3 + 1]; assert.ok(x > own.bb[3] && x <= own.bb[3] + margin && y >= own.bb[1] - margin && y <= own.bb[4] + margin, `${x},${y}`); }
	// 置き直しが正しい＝隣の点を平面直角の座標から直に自分の錨の東北上へ置いた物と 1 mm 以内（借りる物の数も同じ）
	const ce = Math.cos(own.anchor[1] * D2R) * D2R * R, cn = D2R * R, want = [];
	for (let x = sheetBox(east)[0] + 2.5; x < sheetBox(east)[2]; x += 5) for (let y = b[1] + 2.5; y < b[3]; y += 5) {
		const ll = toLonLat(x, y), ee = (ll[0] - own.anchor[0]) * ce, nn = (ll[1] - own.anchor[1]) * cn;
		if (ee > own.bb[3] + margin || nn < own.bb[1] - margin || nn > own.bb[4] + margin || (ee <= own.bb[3] && nn >= own.bb[1] && nn <= own.bb[4])) continue;
		want.push([ee, nn, 50 + 0.01 * x - own.anchor[2] - (ee * ee + nn * nn) / (2 * R)]);
	}
	assert.equal(e.n, want.length);
	const key = p => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`, got = new Map();
	for (let i = 0; i < e.n; i++) got.set(key([e.pts[i * 3], e.pts[i * 3 + 1]]), [e.pts[i * 3], e.pts[i * 3 + 1], e.pts[i * 3 + 2]]);
	let worst = 0; for (const w of want) { const g = got.get(key(w)); assert.ok(g, key(w)); worst = Math.max(worst, Math.hypot(g[0] - w[0], g[1] - w[1], g[2] - w[2])); }
	assert.ok(worst < 1e-3, `worst ${worst} m`);
	// 隣が借りていた点（ghost）は借りない
	const nbG = withGhosts(nb, [{ n: 1, pts: new Float32Array([own.bb[3] + 1 - 0, 0, 0]), elev: new Float32Array(1), rgb: null, intensity: new Uint16Array(1), cls: new Uint8Array(1) }]);
	assert.equal(edgePoints(own, nbG, margin).n, e.n);
	// 遠い図郭からは何も借りない
	assert.equal(edgePoints(own, sheetPoints("MC4900"), margin).n, 0);
});
console.log(`t-pc-sheet: ${tn} 件 OK`);
