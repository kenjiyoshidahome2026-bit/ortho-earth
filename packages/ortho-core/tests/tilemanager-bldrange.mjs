// bldRange（注視点から遠い枠の建物を立てない）の検定（2026-11-06）。
// node packages/ortho-core/tests/tilemanager-bldrange.mjs
// 守るもの：①無指定＝bld 無し（従来）②bldRange=KM＝遠い枠は bld:"no"・近い枠は無印 ③タイル集合（鍵）は変わらない（線・塗りは全枠）④covered は bld の書き換えに影響されない
import assert from "node:assert/strict";
import { createTileManager } from "../src/tilemanager.ts";
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ✔", name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mk = () => {
	const pend = new Map();
	const buildTile = t => new Promise(res => pend.set(`${t.z}/${t.x}/${t.y}`, res));
	const tm = createTileManager({ style: { layers: [] }, tileUrl: () => "x", buildTile });
	const arrive = key => { const r = pend.get(key); assert.ok(r, "pending " + key); pend.delete(key); r({ origin: [0, 0], labels: [], z: +key.split("/")[0], bytes: 10 }); };
	return { tm, pend, arrive };
};
const cam = { center: [139.76, 35.68], zoom: 16.8, pitch: 1.2, bearing: 0, fovy: 0.8, dpr: 1 };   // 高チルト＝遠景まで枠が並ぶ
const kmOf = (key, c) => { const [z, x, y] = key.split("/").map(Number), nn = 1 << z, lon = ((x + 0.5) / nn) * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / nn))) * 180 / Math.PI; return 111.32 * Math.hypot((lon - c[0]) * Math.cos(c[1] * Math.PI / 180), lat - c[1]); };

await t("無指定＝bld 無し／bldRange=1＝遠い枠だけ bld:no・鍵の集合は同じ", async () => {
	const { tm, arrive } = mk();
	tm.update(cam, 800, 1200, {});
	for (const k of [...tm.cache].filter(([, c]) => c.role === 0).map(([k]) => k)) arrive(k);
	await sleep(0);
	const r0 = tm.update({ ...cam, center: [...cam.center] }, 800, 1200, {});
	assert.ok(r0.order.length > 3 && r0.order.every(o => !o.bld), `従来＝bld 無し（${r0.order.length} 枠）`);
	const r1 = tm.update({ ...cam, center: [...cam.center] }, 800, 1200, { bldRange: 1 });
	assert.deepEqual(r1.order.map(o => o.key).sort(), r0.order.map(o => o.key).sort(), "枠の集合は不変（線・塗りは全枠）");
	const far = r1.order.filter(o => o.bld === "no"), near = r1.order.filter(o => !o.bld);
	assert.ok(far.length > 0 && near.length > 0, `遠 ${far.length}・近 ${near.length}`);
	for (const o of far) assert.ok(kmOf(o.key, cam.center) > 1, `${o.key} は 1 km より遠い`);
	for (const o of near) assert.ok(kmOf(o.key, cam.center) <= 1, `${o.key} は 1 km 以内`);
	const r2 = tm.update({ ...cam, center: [...cam.center] }, 800, 1200, { bldRange: 1000 });
	assert.ok(r2.order.every(o => !o.bld), "範囲が十分広い＝全部立つ");
	// ④ covered＝「全枠 ready」の判定は bldRange の書き換えに影響されない（旧＝遠い枠が混ざると常に false＝idle が来ない・2026-11-07 実機）
	assert.equal(r0.covered, true, "従来＝全枚 ready なら covered");
	assert.equal(r1.covered, true, "bldRange=1（遠い枠あり）でも全枚 ready なら covered");
});
await t("bldRange 中に未着の枠があれば covered=false のまま（判定の向きは従来どおり）", async () => {
	const { tm } = mk();
	const r = tm.update(cam, 800, 1200, { bldRange: 1 });
	assert.equal(r.covered, false, "何も届いていない＝covered でない");
});
console.log(`tilemanager-bldrange: ${n} ok`);
