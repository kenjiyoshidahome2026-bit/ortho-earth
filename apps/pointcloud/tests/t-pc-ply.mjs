// pc-ply.ts の検定：PLY の見出し・(E, N, U) → (E, U, −N)・色と分類・間引き・錨の comment
import assert from "node:assert/strict";
import { dumpToPly } from "../pc-ply.ts";

let pass = 0; const ok = (n, f) => { f(); pass++; console.log("✓", n); };
const dump = { n: 3, anchor: [139.1, 35.1, 12.5], pts: new Float32Array([1, 2, 3, -4, -5, -6, 7, 8, 9]), rgb: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90]), cls: new Uint8Array([2, 6, 5]) };
const parse = (bytes) => {
	const txt = new TextDecoder().decode(bytes), end = txt.indexOf("end_header\n") + "end_header\n".length;
	const header = txt.slice(0, end).split("\n"), body = bytes.subarray(new TextEncoder().encode(txt.slice(0, end)).length);
	return { header, body, dv: new DataView(body.buffer, body.byteOffset, body.byteLength) };
};
ok("見出し：binary little endian・7 属性・錨の comment", () => {
	const { header } = parse(dumpToPly(dump));
	assert.equal(header[0], "ply"); assert.equal(header[1], "format binary_little_endian 1.0");
	assert.ok(header.includes("element vertex 3"));
	assert.ok(header.includes("comment orthoEarth anchor 139.1 35.1 12.5 orthometric"));
	assert.deepEqual(header.filter(l => l.startsWith("property")).map(l => l.split(" ")[2]), ["x", "y", "z", "red", "green", "blue", "classification"]);
});
ok("点：(E,N,U)=(1,2,3) → (1, 3, −2)・色・分類", () => {
	const { body, dv } = parse(dumpToPly(dump));
	assert.equal(body.length, 3 * 16);
	assert.equal(dv.getFloat32(0, true), 1); assert.equal(dv.getFloat32(4, true), 3); assert.equal(dv.getFloat32(8, true), -2);
	assert.deepEqual([...body.subarray(12, 16)], [10, 20, 30, 2]);
	assert.equal(dv.getFloat32(16 + 8, true), 5);   // 2 点目：N=−5 → z=+5
	assert.deepEqual([...body.subarray(32 + 12, 48)], [70, 80, 90, 5]);
});
ok("色なし＝白", () => { const { body } = parse(dumpToPly({ ...dump, rgb: null })); assert.deepEqual([...body.subarray(12, 15)], [255, 255, 255]); });
ok("間引き：maxPoints=2 で 2 点（1 点目と 2 点目）", () => {
	const { header, body, dv } = parse(dumpToPly(dump, { maxPoints: 2 }));
	assert.ok(header.includes("element vertex 2")); assert.equal(body.length, 32);
	assert.equal(dv.getFloat32(0, true), 1); assert.equal(dv.getFloat32(16, true), -4);
});
ok("出典の comment（改行は潰す）", () => { const { header } = parse(dumpToPly(dump, { source: "a\nb" })); assert.ok(header.includes("comment source a b")); });
console.log(`\nPASS  ${pass}`);
