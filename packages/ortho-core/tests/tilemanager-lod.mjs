// タイル選抜の memo の検定（src/tilemanager.js の update・src/tilecover.js の selectLOD）。node packages/ortho-core/tests/tilemanager-lod.mjs
// 守るもの：①sticky＝前回の結果の祖先集合で解き直しても結果は同じ（memo の前提）②同じ入力の update は memo でも毎回解いた時と同じ枠
// ③カメラ・画面・zOf が変われば解き直す ④key の無い zOf は memo しない ⑤mlTileZoomOf の key は同じ入力で同じ・違う入力で違う
import assert from "node:assert/strict";
import { selectLOD } from "../src/tilecover.js";
import { createTileManager } from "../src/tilemanager.js";
import { mlTileZoomOf } from "../src/mlcover.js";
import { tileId } from "../src/tile.js";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const anc = sel => { const s = new Set(); for (const t of sel) { let { z, x, y } = t; while (z > 4) { z--; x >>= 1; y >>= 1; const k = tileId(z, x, y); if (s.has(k)) break; s.add(k); } } return s; };
const cams = Array.from({ length: 60 }, (_, i) => ({ center: [120 + rnd() * 30, 25 + rnd() * 20], zoom: 6 + rnd() * 11, pitch: rnd() * 1.2, bearing: rnd() * 6.28, dpr: 1 + (i & 1) }));

t("sticky＝前回の結果の祖先で解き直しても同じ（前回の sticky が別のカメラの物でも）", () => {
	for (let i = 0; i < cams.length; i++) {
		const opts = { groundR: i & 1 ? 1.0003 : 1, floorZ: i % 3 ? 0 : 8, tilePx: 400 };
		const prev = anc(selectLOD(cams[(i + 1) % cams.length], 1600, 1000, opts));
		const A = selectLOD(cams[i], 1600, 1000, { ...opts, sticky: prev });
		const B = selectLOD(cams[i], 1600, 1000, { ...opts, sticky: anc(A) });
		assert.deepEqual(B, A);
	}
});

const mgr = () => createTileManager({ style: { layers: [] }, tileUrl: () => "", buildTile: () => new Promise(() => {}) });
t("同じ入力の update は memo でも毎回解いた時と同じ枠", () => {
	const a = mgr();
	for (let i = 0; i < 20; i++) {
		const cam = cams[i], opts = { tilePx: 500, groundR: i & 1 ? 1.0002 : 1 };
		const r1 = a.update(cam, 1600, 1000, opts), k1 = [...a.cache.keys()].sort();
		const r2 = a.update({ ...cam, center: [...cam.center] }, 1600, 1000, { ...opts });   // 値が同じ別物のカメラ＝memo が当たる
		assert.deepEqual(r2, r1); assert.deepEqual([...a.cache.keys()].sort(), k1);
		const b = mgr(); b.update(cams[i - 1] || cam, 1600, 1000, opts);   // memo の無い素の経路（sticky も同じ前歴）
		assert.deepEqual(b.update(cam, 1600, 1000, opts).total, r1.total);
	}
});
t("カメラ・画面が変われば解き直す", () => {
	const a = mgr(), cam = cams[3];
	const r1 = a.update(cam, 1600, 1000, {});
	const r2 = a.update({ ...cam, zoom: cam.zoom + 1.5 }, 1600, 1000, {});
	assert.notEqual(r2.total, r1.total);
	const r3 = a.update(cam, 400, 300, {});
	assert.ok(r3.total < r1.total);
});
t("key の無い zOf は memo しない（毎回その zOf で解く）", () => {
	const a = mgr(), cam = { center: [139.7, 35.6], zoom: 12, pitch: 0, bearing: 0 };
	const zs = r => [...a.cache.keys()].map(k => +k.split("/")[0]);
	a.update(cam, 800, 600, { zOf: () => 9 }); const hi1 = Math.max(...zs());
	a.cache.clear();
	a.update(cam, 800, 600, { zOf: () => 11 }); const hi2 = Math.max(...zs());
	assert.equal(hi1, 9); assert.equal(hi2, 11);
});
t("mlTileZoomOf の key：同じ入力で同じ・違う入力で違う", () => {
	const cam = { center: [139.7, 35.6], zoom: 12.3, pitch: 1.2, bearing: 0.3 };
	const k = c => mlTileZoomOf(c, 600, { dz: 1.3, terrain: true }).key;
	assert.equal(k(cam), k({ ...cam }));
	assert.notEqual(k(cam), k({ ...cam, bearing: 0.31 }));
	assert.notEqual(mlTileZoomOf(cam, 600, { dz: 1.3 }).key, mlTileZoomOf({ ...cam, pitch: 0 }, 600, { dz: 1.3 }).key);
});
console.log(`tilemanager-lod: ${n} 件 OK`);
