// 注記の差分配達（labelsync.js）：並びと中身が全送りと同じ・worker が持つ物は送らない・外れた物は捨てる・欠けは数えて reset で全部送り直す
import assert from "node:assert/strict";
import { createLabelSender, createLabelReceiver, labelKey } from "../src/labelsync.js";

let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pool = [...Array(300)].map((_, i) => ({ anchor: [139 + rnd(), 35 + rnd()], text: "L" + i, size: 12, color: [0, 0, 0, 1], li: i % 7 }));
const send = createLabelSender(), recv = createLabelReceiver();
let prevList = null, prevHeld = null, sentTotal = 0;
for (let round = 0; round < 40; round++) {
	// 窓＝pool の一部（前の回と大半が重なる）＋写し（新しい物）＋同じ物が二度
	const a = Math.floor(rnd() * 150), list = pool.slice(a, a + 120);
	if (round % 3 === 0) list.push({ ...pool[a], text: pool[a].text + "'" });
	if (round % 5 === 0) list.push(list[0]);
	const msg = send(list);
	sentTotal += msg.add.length / 2;
	const got = recv(structuredClone(msg));
	assert.equal(got.missing, 0);
	assert.equal(got.list.length, list.length, "並びの長さ");
	for (let i = 0; i < list.length; i++) assert.deepEqual(got.list[i], list[i], `中身 ${round}/${i}`);
	if (prevList) {   // 前の回にもあった物は worker 側でも同じ物（identity が保たれる＝__k などの覚えが生きる）
		for (let i = 0; i < list.length; i++) { const j = prevList.indexOf(list[i]); if (j >= 0) assert.equal(got.list[i], prevHeld[j], "持ち越し"); }
		const fresh = list.filter(L => !prevList.includes(L)).length;
		assert.ok(msg.add.length / 2 <= fresh + 1, `送るのは新しい物だけ: ${msg.add.length / 2} ≤ ${fresh}`);
	}
	prevList = list; prevHeld = got.list;
}
assert.ok(sentTotal < 40 * 120, "全送りより少ない: " + sentTotal);
// 空＝全部捨てる・その後は全部送る
assert.deepEqual(recv(structuredClone(send([]))).list, []);
const m2 = send(pool.slice(0, 10)); assert.equal(m2.add.length, 20);
// worker が集合を失った（受け手を作り直し）→ missing が立つ → 送り手を reset すると全部届く
const recv2 = createLabelReceiver();
const m3 = send(pool.slice(0, 10)); assert.equal(m3.add.length, 0, "送り手は持っていると思っている");
const g3 = recv2(structuredClone(m3)); assert.equal(g3.missing, 10); assert.equal(g3.list.length, 0);
send.reset();
const g4 = recv2(structuredClone(send(pool.slice(0, 10)))); assert.equal(g4.missing, 0); assert.equal(g4.list.length, 10);
// 旧形（配列）もそのまま通る
assert.equal(recv2(pool.slice(0, 3)).list.length, 3);
// 鍵：焼いた key があればそれ・無ければ式（labels2d の keyOf と同じ）
assert.equal(labelKey({ text: "A", anchor: [1, 2] }), "A@1.00000,2.00000");
assert.equal(labelKey({ text: "A", anchor: [1, 2], icon: "x", mlp: true, li: 3 }), "3\u0002A\u0001x@1.00000,2.00000");
assert.equal(labelKey({ key: "k", text: "A", anchor: [1, 2] }), "k");
console.log("labelsync: ok");
