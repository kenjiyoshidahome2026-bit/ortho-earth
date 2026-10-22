// 優先付き共有キュー（vt perf plan §3.1）の検定。node packages/ortho-core/tests/tilequeue.mjs
// 守るもの：①空きがあれば即発送・空きが無ければ待つ ②待ちは役（主層 0 < 下地 1 < 毛布 2）→距離の順で出る ③setPriority で待ちの順が変わる
// ④remove は待ちだけ取り下げる（発送済みは undefined） ⑤done で次が出る・最も空いている slot へ ⑥同じ key の二重 enqueue は拒む
import assert from "node:assert/strict";
import { createTileQueue } from "../src/tilequeue.ts";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ✔", name); };
const mk = (slots = 2, perSlot = 2) => { const sent = []; const q = createTileQueue({ slots, perSlot, dispatch: (item, slot) => sent.push([item, slot]) }); return { q, sent }; };
const P = (role, dist) => ({ role, dist });

t("空きがあれば即発送・尽きたら待つ", () => {
	const { q, sent } = mk(2, 2);
	for (let i = 0; i < 6; i++) q.enqueue("k" + i, P(0, i), "k" + i);
	assert.equal(sent.length, 4); assert.deepEqual(q.stats(), { queued: 2, inflight: 4 });
	assert.deepEqual(sent.map(s => s[1]).sort(), [0, 0, 1, 1], "2 slot × 2 本");
});
t("待ちは役→距離の順で出る", () => {
	const { q, sent } = mk(1, 1);
	q.enqueue("busy", P(0, 0), "busy");   // slot を塞ぐ
	q.enqueue("blanket-near", P(2, 0.1), "blanket-near");
	q.enqueue("main-far", P(0, 9), "main-far");
	q.enqueue("coarse", P(1, 1), "coarse");
	q.enqueue("main-near", P(0, 1), "main-near");
	const order = []; while (q.stats().queued) { q.done(0); order.push(sent[sent.length - 1][0]); }
	assert.deepEqual(order, ["main-near", "main-far", "coarse", "blanket-near"]);
});
t("setPriority で待ちの順が変わる（発送済みは false）", () => {
	const { q, sent } = mk(1, 1);
	q.enqueue("busy", P(0, 0), "busy");
	q.enqueue("a", P(2, 1), "a"); q.enqueue("b", P(2, 2), "b");
	assert.equal(q.setPriority("b", P(0, 0)), true);
	assert.equal(q.setPriority("busy", P(0, 0)), false, "発送済み");
	assert.equal(q.setPriority("nope", P(0, 0)), false);
	q.done(0); assert.equal(sent[sent.length - 1][0], "b");
});
t("remove は待ちだけ取り下げる", () => {
	const { q, sent } = mk(1, 1);
	q.enqueue("busy", P(0, 0), "busy"); q.enqueue("w", P(0, 1), "w");
	assert.equal(q.remove("busy"), undefined); assert.equal(q.remove("w"), "w"); assert.equal(q.remove("w"), undefined);
	q.done(0); assert.equal(sent.length, 1); assert.deepEqual(q.stats(), { queued: 0, inflight: 0 });
});
t("done で最も空いている slot へ出る", () => {
	const { q, sent } = mk(2, 2);
	for (let i = 0; i < 5; i++) q.enqueue("k" + i, P(0, i), "k" + i);
	q.done(1);   // slot 1 が 1 本空く → 待ちの k4 は slot 1 へ
	assert.deepEqual(sent[sent.length - 1], ["k4", 1]);
	q.done(0); assert.equal(sent.length, 5, "待ちが無ければ出ない"); assert.deepEqual(q.stats(), { queued: 0, inflight: 3 });
});
t("同じ key の二重 enqueue は拒む・done の過剰呼びで負にならない", () => {
	const { q } = mk(1, 1);
	q.enqueue("busy", P(0, 0), "busy");
	assert.equal(q.enqueue("w", P(0, 1), "w"), true); assert.equal(q.enqueue("w", P(0, 1), "w2"), false);
	q.done(0); q.done(0); q.done(0); assert.deepEqual(q.stats(), { queued: 0, inflight: 0 });   // 1 回目で w が出て 2 回目で終わり・3 回目は負にならない
});
console.log(`tilequeue: ${n} ok`);
