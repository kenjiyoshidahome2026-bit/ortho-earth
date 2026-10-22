// 計器 e（vt perf plan §2）の検定：createTileManager の shown（必要になった→画面の遅れ）。node packages/ortho-core/tests/tilemanager-latency.mjs
// 守るもの：①主層（role 0）として要ったタイルだけ数える（下地・毛布だけのタイルは出ない）②同じタイルは 1 回だけ ③worker の時間 t（fetch/build）が通り、wait＝ready−(fetch+build)（負にならない）
// ④読込中に下地→主層へ役が近づいたら、主層として要った時刻から数える ⑤reset で忘れる
import assert from "node:assert/strict";
import { createTileManager } from "../src/tilemanager.ts";
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ✔", name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1 枚ずつ手で解決できる buildTile（worker 経路の形＝メタ＋t）
const mk = () => {
	const pend = new Map();
	const buildTile = t => new Promise(res => pend.set(`${t.z}/${t.x}/${t.y}`, res));
	const tm = createTileManager({ style: { layers: [] }, tileUrl: () => "x", buildTile });
	const arrive = (key, t = { fetch: 3, build: 1 }) => { const r = pend.get(key); assert.ok(r, "pending " + key); pend.delete(key); r({ origin: [0, 0], labels: [], z: +key.split("/")[0], bytes: 10, t }); };
	return { tm, pend, arrive };
};
const cam = { center: [139.76, 35.68], zoom: 13, pitch: 0, bearing: 0, fovy: 0.8, dpr: 1 };

await t("主層として要ったタイルだけ・1 回だけ・t が通り wait は負にならない", async () => {
	const { tm, pend, arrive } = mk();
	const r = tm.update(cam, 1200, 800, {});
	assert.ok(pend.size > 0 && r.total > 0);
	// 役の記録＝選抜の鍵は 0・毛布（z4）は 2
	const roles = new Map([...tm.cache].map(([k, c]) => [k, c.role]));
	const z4 = [...roles].filter(([k]) => k.startsWith("4/")); assert.ok(z4.length && z4.every(([, r]) => r === 2), "毛布は役 2");
	const sel = [...roles].filter(([, r]) => r === 0).map(([k]) => k); assert.equal(sel.length, r.total, "主層の数＝選抜数");
	await sleep(5);
	for (const k of [...pend.keys()]) arrive(k, { fetch: 2, build: 1.5 });
	await sleep(0);
	const all = [...tm.cache.keys()];
	const lat = tm.shown(all);
	assert.equal(lat.length, sel.length, "主層だけ数える（下地・毛布は出ない）");
	for (const L of lat) { assert.ok(L.total >= L.ready && L.ready >= 4, `ready≥待った時間 ${L.ready}`); assert.deepEqual(L.t, { fetch: 2, build: 1.5 }); assert.ok(L.wait >= 0 && Math.abs(L.wait - (L.ready - 3.5)) < 1e-9); }
	assert.equal(tm.shown(all).length, 0, "2 度目は数えない");
});

await t("主層でない鍵を渡しても数えない・ready でない鍵は数えない", async () => {
	const { tm, pend, arrive } = mk();
	tm.update(cam, 1200, 800, {});
	const sel = [...tm.cache].filter(([, c]) => c.role === 0).map(([k]) => k);
	assert.equal(tm.shown(sel).length, 0, "まだ loading");
	arrive(sel[0]); await sleep(0);
	assert.equal(tm.shown(sel).length, 1);
	assert.equal(tm.shown(["4/14/6", "nope"]).length, 0);
	assert.ok(pend.size > 0);
});

await t("読込中に役が近づいたら主層になった時刻から数える", async () => {
	// 1 回目は遠くの視点（あるタイルが下地）→ 2 回目は近づいてそのタイルが主層になる状況を、cache を直接いじって再現
	const { tm, arrive } = mk();
	tm.update(cam, 1200, 800, {});
	const sel = [...tm.cache].filter(([, c]) => c.role === 0).map(([k]) => k);
	const k = sel[0], c = tm.cache.get(k);
	c.role = 1; c.needAt -= 1000;   // 「1 秒前に下地として要った」に書き換え
	tm.update({ ...cam, center: [...cam.center] }, 1200, 800, {});   // memo が当たる＝ensure は走るが loading はそのまま＝役だけ 0 に近づき needAt が今になる
	assert.equal(tm.cache.get(k).role, 0);
	assert.ok(performance.now() - tm.cache.get(k).needAt < 100, "needAt は主層になった時刻");
	arrive(k); await sleep(0);
	const [L] = tm.shown([k]);
	assert.ok(L && L.total < 100, `下地だった 1 秒は数えない ${L?.total}`);
});

await t("reset で忘れる（同じタイルをもう一度数えられる）", async () => {
	const { tm, arrive } = mk();
	tm.update(cam, 1200, 800, {});
	const k = [...tm.cache].find(([, c]) => c.role === 0)[0];
	arrive(k); await sleep(0);
	assert.equal(tm.shown([k]).length, 1);
	tm.reset();
	tm.update(cam, 1200, 800, {});
	arrive(k); await sleep(0);
	assert.equal(tm.shown([k]).length, 1);
});

console.log(`tilemanager-latency: ${n} ok`);
