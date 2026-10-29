// タイル選抜の memo の検定（src/tilemanager.js の update・src/tilecover.js の selectLOD）。node packages/ortho-core/tests/tilemanager-lod.mjs
// 守るもの：①sticky＝前回の結果の祖先集合で解き直しても結果は同じ（memo の前提）②同じ入力の update は memo でも毎回解いた時と同じ枠
// ③カメラ・画面・zOf が変われば解き直す ④key の無い zOf は memo しない ⑤mlTileZoomOf の key は同じ入力で同じ・違う入力で違う
import assert from "node:assert/strict";
import { selectLOD } from "../src/tilecover.ts";
import { createTileManager } from "../src/tilemanager.ts";
import { mlTileZoomOf } from "../src/mlcover.ts";
import { tileId } from "../src/tile.ts";
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
// 未着の枠の代打（2026-10-20・止まった時の白抜き）：選びが細かくなっても、兄弟がそろうまでは描いていた親のまま。
// 子がそろえば子へ。粗くなる側は、未着の親の代わりに常駐の子孫で覆う。祖先も子孫も無い枠は従来どおり落ちる（下地が見える）
const readyAll = (a, keys) => { for (const k of keys) a.cache.set(k, { status: "ready", origin: [0, 0], z: +k.split("/")[0], dl: null, labels: [] }); };
const keysOf = r => r.order.map(o => o.key).sort();
const kidsOf = k => { const [z, x, y] = k.split("/").map(Number); return [0, 1, 2, 3].map(i => `${z + 1}/${x * 2 + (i & 1)}/${y * 2 + (i >> 1)}`); };
const parentOf = k => { const [z, x, y] = k.split("/").map(Number); return `${z - 1}/${x >> 1}/${y >> 1}`; };
t("代打：細かくなった枠が未着の間は親のまま・兄弟がそろったら子へ", () => {
	const a = mgr(), cam = { center: [139.7671, 35.6812], zoom: 15, pitch: 0, bearing: 0 };
	const zKeys = z => [...a.cache.keys()].filter(k => +k.split("/")[0] === z);
	a.update(cam, 960, 600, { tilePx: 560 });
	readyAll(a, zKeys(14));
	const r0 = a.update(cam, 960, 600, { tilePx: 560 });
	assert.ok(r0.covered && r0.order.length > 0 && keysOf(r0).every(k => k.startsWith("14/")), "粗い段（z14）が全部そろう");
	const fine = a.update(cam, 960, 600, { tilePx: 384 });
	assert.ok(!fine.covered, "細かい段は未着");
	assert.deepEqual(keysOf(fine), keysOf(r0), "未着の間は親（今描いている物）のまま＝穴を作らない");
	const split = zKeys(15).sort();   // 割れて選ばれた子（未着）
	assert.ok(split.length >= 4);
	const p0 = split.map(parentOf).sort((x, y) => kidsOf(y).filter(k => split.includes(k)).length - kidsOf(x).filter(k => split.includes(k)).length)[0];   // 子が一番多く選ばれた親
	const sib = kidsOf(p0).filter(k => split.includes(k));
	assert.ok(sib.length >= 2);
	readyAll(a, sib.slice(0, sib.length - 1));   // 兄弟の 1 枚だけ未着
	const r1 = a.update(cam, 960, 600, { tilePx: 384 });
	assert.ok(keysOf(r1).includes(p0) && !sib.some(k => keysOf(r1).includes(k)), "兄弟が欠けている間は親（そろった子と重ねない）");
	readyAll(a, sib);
	const r2 = a.update(cam, 960, 600, { tilePx: 384 });
	assert.ok(!keysOf(r2).includes(p0) && sib.every(k => keysOf(r2).includes(k)), "兄弟がそろえば子へ");
	readyAll(a, split);
	const r3 = a.update(cam, 960, 600, { tilePx: 384 });
	assert.ok(r3.covered && keysOf(r3).some(k => k.startsWith("15/")));
});
t("代打：粗くなった枠が未着なら常駐の子孫で覆う・何も無い枠は落ちる", () => {
	const a = mgr(), cam = { center: [139.7671, 35.6812], zoom: 15, pitch: 0, bearing: 0 };
	a.update(cam, 960, 600, { tilePx: 384 });
	const fineKeys = [...a.cache.keys()].filter(k => +k.split("/")[0] === 15);
	readyAll(a, fineKeys);
	const r0 = a.update(cam, 960, 600, { tilePx: 384 });
	assert.ok(r0.covered);
	const r1 = a.update(cam, 960, 600, { tilePx: 560 });   // 一段粗い枠（z14）は未着
	assert.ok(!r1.covered);
	assert.ok(keysOf(r1).every(k => !k.startsWith("14/")), "未着の z14 は出さない");
	const full = keysOf(r1).filter(k => k.startsWith("15/"));
	assert.ok(full.length > 0, "子孫で覆える所は子孫");
	// 何も手元に無いカメラ＝全部落ちる（従来どおり）
	const b = mgr(), r = b.update({ ...cam, center: [135.5, 34.7] }, 960, 600, {});
	assert.equal(r.order.length, 0); assert.ok(!r.covered);
});
t("地下の目（海面球の内側・Cesium の underground）でも裏から見る地面のタイルを選ぶ（旧＝標本が全部空振り＝0 枚）", () => {
	const cam = { center: [-3.83, 53.12], centerAlt: -600, zoom: 16, pitch: 1.45, bearing: 1.97, dpr: 1 };
	const sel = selectLOD(cam, 800, 600, { tilePx: 400, maxZ: 18 });
	assert.ok(sel.length > 0, "no tiles");
	const lon2 = (x, z) => x / (1 << z) * 360 - 180;
	for (const q of sel) assert.ok(Math.abs(lon2(q.x + 0.5, q.z) + 3.83) < 20, `far tile ${q.z}/${q.x}/${q.y}`);   // 地球の裏側（UNDER_REACH の外）は選ばない
	assert.ok(Math.max(...sel.map(q => q.z)) >= 12, "near tiles are fine");
});
console.log(`tilemanager-lod: ${n} 件 OK`);
