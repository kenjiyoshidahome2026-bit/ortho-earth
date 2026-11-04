// keepFine（ズームアウトの子孫代打）で建物だけは親の密度に揃える検定（2026-11-05・本人報告「引いたときに基図らしきものが十字型に残る」）。
// node packages/ortho-core/tests/tilemanager-keepfine.mjs
// 守るもの：①親が未着＝子孫がそのまま（bld 無し＝建物も子孫）②親が ready＝子孫は bld:"no"・親は bld:"only" で混ざる
// ③labels は "only" の親を読まない ④mergeTiles は "only"＝建物だけ・"no"＝線塗りだけ
import assert from "node:assert/strict";
import { createTileManager } from "../src/tilemanager.ts";
import { mergeTiles } from "../src/scene.ts";
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ✔", name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mk = () => {
	const pend = new Map();
	const buildTile = t => new Promise(res => pend.set(`${t.z}/${t.x}/${t.y}`, res));
	const tm = createTileManager({ style: { layers: [] }, tileUrl: () => "x", buildTile });
	const arrive = key => { const r = pend.get(key); assert.ok(r, "pending " + key); pend.delete(key); r({ origin: [0, 0], labels: [{ text: key, anchor: [0, 0] }], z: +key.split("/")[0], bytes: 10 }); };
	return { tm, pend, arrive };
};
const cam = { center: [139.76, 35.68], zoom: 15.2, pitch: 0, bearing: 0, fovy: 0.8, dpr: 1 };   // 真俯瞰＝選抜が 1 段だけ（遠近 LOD で段が混ざらない）＝親は全部未着から始まる。keepFine は引数で渡す（pitch のゲートは app 側）
const parentOf = k => { const [z, x, y] = k.split("/").map(Number); return `${z - 1}/${x >> 1}/${y >> 1}`; };

await t("親が未着＝子孫がそのまま（建物も子孫）／親が ready＝子孫は bld:no・親は bld:only", async () => {
	const { tm, pend, arrive } = mk();
	tm.update(cam, 1200, 800, {});
	const fine = [...tm.cache].filter(([, c]) => c.role === 0).map(([k]) => k);
	for (const k of fine) arrive(k);
	await sleep(0);
	// 一段引く＝親が選抜される。親は未着（ensure で読み始める）→ 常駐の子孫で覆える枠は子孫のまま・bld は付かない
	const out = { ...cam, zoom: cam.zoom - 1 };
	const r1 = tm.update(out, 1200, 800, { keepFine: 2 });
	assert.ok(r1.order.length > 0 && r1.order.every(o => !o.bld), "親が未着の間は従来どおり（bld 無し）");
	const kids = r1.order.filter(o => o.z === Math.max(...r1.order.map(o => o.z)));
	assert.ok(kids.length > 0, "子孫が描かれている");
	// 親（＝子孫の親の鍵のうち読込中の物）を届ける
	const parents = [...new Set(kids.map(o => parentOf(o.key)))].filter(k => pend.has(k));
	assert.ok(parents.length > 0, "親が読込中");
	for (const k of parents) arrive(k);
	await sleep(0);
	const r2 = tm.update({ ...out, center: [...out.center] }, 1200, 800, { keepFine: 2 });
	const only = r2.order.filter(o => o.bld === "only"), no = r2.order.filter(o => o.bld === "no");
	assert.ok(only.length > 0 && no.length > 0, `親 only=${only.length}・子孫 no=${no.length}`);
	for (const p of only) {
		const under = no.filter(o => { let k = o.key; while (k.split("/")[0] > p.key.split("/")[0]) { k = parentOf(k); } return k === p.key; });
		assert.ok(under.length >= 4, `only の親 ${p.key} の下に子孫 ${under.length} 枚（≥4）`);
		assert.ok(!r2.order.some(o => o.key === p.key && o.bld !== "only"), "親は only としてだけ混ざる");
	}
	// labels は only の親を読まない（注記は子孫が持つ）
	const L = tm.labels(r2.order).map(l => l.text);
	assert.ok(only.every(p => !L.includes(p.key)) && no.some(o => L.includes(o.key)), "labels は子孫の分だけ");
});

await t("mergeTiles：only＝建物だけ・no＝線塗りだけ・無印＝両方", () => {
	const op = { kind: "fill", li: 1, pos: new Float32Array([0, 0, 1, 0, 0, 1]), col: new Uint8Array(12), idx: new Uint32Array([0, 1, 2]) };
	const bld = { pos: new Float32Array([0, 0, 5, 1, 0, 5, 0, 1, 5]), shade: new Float32Array([1, 1, 1]), anchor: new Float32Array(6) };
	const geom = () => ({ ops: [op], buildings: bld });
	const o = (key, bldRole) => ({ key, origin: [0, 0], ...(bldRole ? { bld: bldRole } : {}) });
	const both = mergeTiles([o("14/0/0")], geom);
	assert.equal(both.layers.length, 1); assert.equal(both.buildings.pos.length, 9);
	const only = mergeTiles([o("14/0/0", "only")], geom);
	assert.equal(only.layers.length, 0, "only＝線塗り無し"); assert.equal(only.buildings.pos.length, 9, "only＝建物あり");
	const no = mergeTiles([o("15/0/0", "no")], geom);
	assert.equal(no.layers.length, 1, "no＝線塗りあり"); assert.equal(no.buildings, null, "no＝建物無し");
	const mixed = mergeTiles([o("15/0/0", "no"), o("15/1/0", "no"), o("14/0/0", "only")], geom);
	assert.equal(mixed.buildings.pos.length, 9, "混在＝建物は親の 1 枚分"); assert.equal(mixed.layers[0].pos.length, 12, "混在＝線塗りは子孫 2 枚分");
});
console.log(`tilemanager-keepfine: ${n} ok`);
