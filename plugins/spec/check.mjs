// 受け渡しの約束（anchor.schema.json・attributes.schema.json）を、両方のプラグインの見本と ortho-export の出力の形で検める（依存ゼロ）。
//   実行：node plugins/spec/check.mjs
//   検める物：Unity と Unreal の見本の anchor.json が同じ中身か・schema に合うか／attributeTable（features.mjs）の出力が schema に合うか／
//   LAS（pc-las.ts）と PLY（pc-ply.ts）が同じ点を同じ錨で書くか（向きだけが違う）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attributeTable } from "../../sdk/ortho-export/src/features.mjs";
import { dumpToLas } from "../../apps/pointcloud/pc-las.ts";
import { dumpToPly } from "../../apps/pointcloud/pc-ply.ts";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, "../..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

/** JSON Schema の小さな部分集合（type・required・properties・items・const・minimum/maximum・minItems/maxItems・uniqueItems）。 */
function validate(schema, v, at = "$") {
	const errs = [];
	const t = schema.type;
	const is = { object: x => x && typeof x === "object" && !Array.isArray(x), array: Array.isArray, number: x => typeof x === "number" && Number.isFinite(x), string: x => typeof x === "string" };
	if ("const" in schema && v !== schema.const) errs.push(`${at}: expected ${JSON.stringify(schema.const)}`);
	if (t && !is[t](v)) { errs.push(`${at}: expected ${t}`); return errs; }
	if (t === "number") { if (schema.minimum != null && v < schema.minimum) errs.push(`${at}: < ${schema.minimum}`); if (schema.maximum != null && v > schema.maximum) errs.push(`${at}: > ${schema.maximum}`); }
	if (t === "object") {
		for (const k of schema.required || []) if (!(k in v)) errs.push(`${at}.${k}: required`);
		for (const [k, s] of Object.entries(schema.properties || {})) if (k in v) errs.push(...validate(s, v[k], `${at}.${k}`));
	}
	if (t === "array") {
		if (schema.minItems != null && v.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems}`);
		if (schema.maxItems != null && v.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems}`);
		if (schema.uniqueItems && new Set(v.map(x => JSON.stringify(x))).size !== v.length) errs.push(`${at}: not unique`);
		if (schema.items) v.forEach((x, i) => errs.push(...validate(schema.items, x, `${at}[${i}]`)));
	}
	return errs;
}

let pass = 0; const ok = (n, f) => { f(); pass++; console.log("✓", n); };
const anchorSchema = read("plugins/spec/anchor.schema.json"), attrSchema = read("plugins/spec/attributes.schema.json");

ok("見本の anchor.json：Unity と Unreal で同じ・schema に合う", () => {
	const u = read("plugins/unity/com.ortho-earth.unity/Samples~/Marunouchi/anchor.json"), r = read("plugins/unreal/Samples/Marunouchi/anchor.json");
	assert.deepEqual(u, r);
	assert.deepEqual(validate(anchorSchema, u), []);
	assert.deepEqual(r.unreal.axes, { x: "east", y: "south", z: "up" });
});
ok("schema は壊れた錨を落とす", () => {
	assert.ok(validate(anchorSchema, { anchor: { lon: 200, lat: 35 } }).length >= 2);
	assert.ok(validate(anchorSchema, { anchor: { lon: 139, lat: 35, height: 1 }, frame: "ecef" }).length === 1);
});
ok("attributeTable の出力が schema に合う", () => {
	const t = attributeTable([{ id: "b1", row: { "bldg:usage": "業務施設", nested: { a: 1 } } }, { id: "b2", row: { "bldg:measuredHeight": 12.5 } }]);
	const table = { ...t, source: "test", glb: "buildings.glb" };
	assert.deepEqual(validate(attrSchema, table), [], JSON.stringify(table));
	assert.equal(table.buildings.length, 2); assert.deepEqual(table.keys, ["bldg:usage", "nested/a", "bldg:measuredHeight"]); assert.deepEqual(table.buildings[1].values, ["", "", "12.5"]);
});
ok("LAS と PLY：同じ点・同じ錨（LAS は (E, N, U)・PLY は (E, U, −N)）", () => {
	const d = { n: 2, anchor: [139.7, 35.6, 3], pts: new Float32Array([1.5, 2.25, 3, -4, 5, -6]), rgb: null, cls: new Uint8Array([2, 6]) };
	const las = dumpToLas(d), ply = dumpToPly(d);
	const lv = new DataView(las.buffer), off = lv.getUint32(96, true);
	const txt = new TextDecoder().decode(ply), body = txt.indexOf("end_header\n") + 11, pv = new DataView(ply.buffer, body);
	for (let k = 0; k < 2; k++) {
		const [e, n, u] = [0, 4, 8].map(o => lv.getInt32(off + k * 26 + o, true) / 1000);
		const [x, y, z] = [0, 4, 8].map(o => pv.getFloat32(k * 16 + o, true));
		assert.deepEqual([e, n, u], [x, -z, y]);
	}
	assert.ok(txt.includes("orthoEarth anchor 139.7 35.6 3 orthometric"));
	assert.ok(new TextDecoder().decode(las).includes('"anchor":{"lon":139.7,"lat":35.6,"height":3,"datum":"orthometric"}'));
});
console.log(`plugins/spec: ${pass} ok`);
