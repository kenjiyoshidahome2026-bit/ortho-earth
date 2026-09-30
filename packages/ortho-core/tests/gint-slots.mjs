// gint のスロット束と受け取りの形の検定（gl/gint/state.js の SLOT_FIELDS/emptySlot・gl/gint/bake.js の gintDataOf）。node packages/ortho-core/tests/gint-slots.mjs
// 守るもの：①空束は退避/復元する欄を全部持つ（欠けると交替の後に前の層の値が残る＝旧 subB/span/spanB）②空束は毎回新品 ③gintDataOf は層別の塗り上限と低ズーム塗りを運ぶ
import assert from "node:assert/strict";
import { SLOT_FIELDS, emptySlot } from "../src/gl/gint/state.js";
import { gintDataOf } from "../src/gl/gint/bake.js";
const e = emptySlot();
assert.deepEqual(Object.keys(e).sort(), [...SLOT_FIELDS].sort(), "emptySlot と SLOT_FIELDS の欄が一致");
for (const f of ["subB", "span", "spanB"]) assert.ok(SLOT_FIELDS.includes(f), f);
assert.notEqual(emptySlot().lodTiers, e.lodTiers, "空束は毎回新品");
const g = gintDataOf({ arcBuffer: 1, polyStream: [], lineStream: [3], fillMaxEdges: 5, lowFill: true });
assert.equal(g.fillMaxEdges, 5); assert.equal(g.lowFill, true); assert.equal(g.polyStream, null); assert.deepEqual(g.lineStream, [3]); assert.equal(g.pointBuffer, null);
assert.equal(gintDataOf({}).lowFill, false);
console.log("✓ gint-slots 全項目 PASS");
