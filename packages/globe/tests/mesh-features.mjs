// 地物の番号と属性（W7）＝EXT_mesh_features／EXT_structural_metadata／b3dm の batch table・画面の当たり・feature state の色（DOM 無し）
import { featureSetOf, featureIdsOf, decodePropertyTables, batchTableOf, featureProperties, NO_FEATURE } from "../src/mesh-features.ts";
import { pickMeshes, tintColors, lngLatOfWorld } from "../src/meshpick.ts";
import { decodeModel } from "../src/meshdecode.ts";
globalThis.self ??= globalThis;
let fails = 0; const ok = (n, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${info ? " " + info : ""}`); if (!c) fails++; };
const J = v => JSON.stringify(v);
// ── glb を組む（bufferView を積む）──
function glbOf(json, views) {
	const parts = []; let off = 0; json.bufferViews = []; json.buffers = [{ byteLength: 0 }];
	for (const u8 of views) { while (off % 8) { parts.push(new Uint8Array(1)); off++; } json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: u8.byteLength }); parts.push(u8); off += u8.byteLength; }
	while (off % 4) { parts.push(new Uint8Array(1)); off++; }
	json.buffers[0].byteLength = off;
	const bin = new Uint8Array(off); let o = 0; for (const p of parts) { bin.set(p, o); o += p.byteLength; }
	const js = new TextEncoder().encode(JSON.stringify(json)), jl = (js.length + 3) & ~3;
	const glb = new ArrayBuffer(28 + jl + off), dv = new DataView(glb), u8 = new Uint8Array(glb);
	dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, glb.byteLength, true);
	dv.setUint32(12, jl, true); dv.setUint32(16, 0x4E4F534A, true); u8.set(js, 20); for (let i = 20 + js.length; i < 20 + jl; i++) u8[i] = 0x20;
	dv.setUint32(20 + jl, off, true); dv.setUint32(24 + jl, 0x004E4942, true); u8.set(bin, 28 + jl);
	return glb;
}
const B = a => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const enc = s => new TextEncoder().encode(s);
const strs = list => { const bs = list.map(enc), all = new Uint8Array(bs.reduce((n, b) => n + b.length, 0)), offs = new Uint32Array(list.length + 1); let o = 0; bs.forEach((b, i) => { all.set(b, o); o += b.length; offs[i + 1] = o; }); return [all, B(offs)]; };
// ── 表の型（純関数）──
{
	const [sv, so] = strs(["Alpha", "Beta", "Gamma"]), [av, ao] = strs(["a", "b", "c"]);
	const views = [sv, so, B(Uint16Array.of(100, 200, 0xFFFF)), B(Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9)), Uint8Array.of(0b101), B(Uint8Array.of(1, 0, 1)), B(Int32Array.of(10, 20, 30)), B(Uint32Array.of(0, 1, 1, 3)),
		B(Int8Array.of(127, -127, 0)), av, ao, B(Uint32Array.of(0, 2, 2, 3))];
	const bytesOf = i => views[i];
	const meta = { schema: { enums: { kind: { valueType: "UINT8", values: [{ name: "house", value: 0 }, { name: "shop", value: 1 }] } }, classes: { bld: { properties: {
		name: { type: "STRING" }, h: { type: "SCALAR", componentType: "UINT16", scale: 0.1, offset: 5, noData: 0xFFFF, default: -1 }, c: { type: "VEC3", componentType: "FLOAT32" }, flag: { type: "BOOLEAN" },
		kind: { type: "ENUM", enumType: "kind" }, floors: { type: "SCALAR", componentType: "INT32", array: true }, norm: { type: "SCALAR", componentType: "INT8", normalized: true }, tags: { type: "STRING", array: true }, absent: { type: "SCALAR", componentType: "FLOAT32", default: 7 } } } } },
		propertyTables: [{ name: "buildings", class: "bld", count: 3, properties: { name: { values: 0, stringOffsets: 1 }, h: { values: 2 }, c: { values: 3 }, flag: { values: 4 }, kind: { values: 5 }, floors: { values: 6, arrayOffsets: 7 }, norm: { values: 8 }, tags: { values: 9, stringOffsets: 10, arrayOffsets: 11 } } }] };
	const w = [], T = decodePropertyTables(meta, bytesOf, w)[0];
	ok("tbl.string", J(T.columns.name) === J(["Alpha", "Beta", "Gamma"]) && T.name === "buildings" && T.class === "bld" && T.count === 3);
	ok("tbl.scaleOffset", Math.abs(T.columns.h[0] - 15) < 1e-9 && Math.abs(T.columns.h[1] - 25) < 1e-9, J(T.columns.h));
	ok("tbl.noData", T.columns.h[2] === -1, J(T.columns.h));
	ok("tbl.vec3", J(T.columns.c) === J([[1, 2, 3], [4, 5, 6], [7, 8, 9]]));
	ok("tbl.boolean", J(T.columns.flag) === J([true, false, true]));
	ok("tbl.enum", J(T.columns.kind) === J(["shop", "house", "shop"]));
	ok("tbl.varArray", J(T.columns.floors) === J([[10], [], [20, 30]]), J(T.columns.floors));
	ok("tbl.normalized", T.columns.norm[0] === 1 && T.columns.norm[1] === -1 && T.columns.norm[2] === 0, J(T.columns.norm));
	ok("tbl.stringArray", J(T.columns.tags) === J([["a", "b"], [], ["c"]]), J(T.columns.tags));
	ok("tbl.default", J(T.columns.absent) === J([7, 7, 7]) && w.length === 0, J(w));
	ok("tbl.row", J(featureProperties(T, 1)) === J({ name: "Beta", h: 25, c: [4, 5, 6], flag: false, kind: "house", floors: [], norm: -1, tags: [], absent: 7 }) && J(featureProperties(T, 9)) === "{}");
	const w2 = []; decodePropertyTables({ schema: { classes: { x: { properties: { bad: { type: "SCALAR", componentType: "FLOAT32" } } } } }, propertyTables: [{ class: "x", count: 4, properties: { bad: { values: 0 } } }] }, () => new Uint8Array(4), w2);
	ok("tbl.shortWarns", w2.length === 1 && /too short/.test(w2[0]), J(w2));
}
// ── 番号の組 ──
{
	const pr = { attributes: { _FEATURE_ID_1: { value: Float32Array.of(0, 3, 5, 2) } }, extensions: { EXT_mesh_features: { featureIds: [{ featureCount: 4 }, { featureCount: 4, attribute: 1, nullFeatureId: 5, propertyTable: 2 }, { featureCount: 1, texture: { index: 0 } }] } } };
	const s0 = featureSetOf(pr, 0), s1 = featureSetOf(pr, 1), s2 = featureSetOf(pr, 2);
	ok("fid.implicit", s0.implicit && J([...featureIdsOf(s0, 4)]) === J([0, 1, 2, 3]));
	ok("fid.attrNull", s1.propertyTable === 2 && J([...featureIdsOf(s1, 4)]) === J([0, 3, NO_FEATURE, 2]));
	ok("fid.texture", s2.texture && featureIdsOf(s2, 4).every(v => v === NO_FEATURE));
	const b = featureSetOf({ attributes: { _BATCHID: { value: Uint16Array.of(1, 1, 0) } } });
	ok("fid.batchId", b.batchId && b.propertyTable === 0 && J([...featureIdsOf(b, 3)]) === J([1, 1, 0]) && featureSetOf({ attributes: {} }) === null);
	const bt = batchTableOf({ name: ["x", "y"], height: { byteOffset: 0, componentType: "FLOAT", type: "SCALAR" }, extras: {} }, B(Float32Array.of(3, 4)), 2);
	ok("batchTable", J(featureProperties(bt, 1)) === J({ name: "y", height: 4 }) && bt.count === 2);
}
// ── 当たり（正射の物差し：clip = (x, y, 1)・画面 100x100・目は +z の遠く）──
{
	const w0 = 5e5, view = { mvp: Float64Array.of(2 * w0, 0, 0, 0, 0, 2 * w0, 0, 0, 0, 0, 0, -1, -w0, -w0, 0, 1e6), W: 100, H: 100, eye: [0, 0, 1e6] };   // 世界 x∈[0,1] → 画面 0..100（z≈5e5 で）・w＝1e6−z（z 大＝手前）
	// 画面 (x/100, 1−y/100) の世界。三角形 2 枚：遠い（z=0）と近い（z=1）・番号は頂点ごと
	const quad = (z, ids) => ({ pos: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0), idx: Uint32Array.of(0, 1, 2, 1, 3, 2), origin: [0, 0, z], features: { ids: Uint32Array.from(ids) } });
	// 球の裏の判定（dot(P/|P|, eye) − 1 ≥ 0）を通るよう原点を大きく手前へ
	const far = quad(5e5, [7, 7, 7, 7]), near = quad(5e5 + 1, [3, 3, 4, 4]);
	let h = pickMeshes([far, near], view, 20, 70);
	ok("pick.nearest", h && h.item === 1 && h.featureId === 3 && Math.abs(h.w - (1e6 - (5e5 + 1))) < 1e-6, J(h && { item: h.item, f: h.featureId, w: h.w }));
	h = pickMeshes([far, near], view, 80, 20);
	ok("pick.vertexId", h && h.item === 1 && h.featureId === 4, J(h && { item: h.item, f: h.featureId }));
	h = pickMeshes([far, { ...near, hidden: true }], view, 20, 70);
	ok("pick.hidden", h && h.item === 0 && h.featureId === 7);
	ok("pick.miss", pickMeshes([far, near], view, 150, 50) === null);
	// 剛体変換（xf）＝x を +0.5 ずらす → 画面 x=20 は外れ・x=70 に当たる
	const shifted = { ...quad(5e5, [9, 9, 9, 9]), xf: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0, 0) };
	ok("pick.xf", pickMeshes([shifted], view, 20, 50) === null && pickMeshes([shifted], view, 70, 50)?.featureId === 9);
	// 持ち上げ（lift＝原点の向き＝+z）＝奥行きだけ変わる
	const lifted = { ...quad(5e5, [1, 1, 1, 1]), lift: 2 };
	ok("pick.lift", pickMeshes([near, lifted], view, 20, 70)?.featureId === 1);
	// 番号なし＝featureId null
	ok("pick.noIds", pickMeshes([{ ...far, features: null }], view, 50, 50)?.featureId === null);
	ok("lngLatOfWorld", J(lngLatOfWorld([1, 0, 0]).map(v => +v.toFixed(6))) === J([0, 0]) && Math.abs(lngLatOfWorld([0, 1, 0])[1] - 90) < 1e-9 && Math.abs(lngLatOfWorld([0, 0, 1])[0] - 90) < 1e-9);
}
// ── 色 ──
{
	const col0 = Uint8Array.of(10, 10, 10, 255, 20, 20, 20, 128, 30, 30, 30, 255), ids = Uint32Array.of(1, 2, NO_FEATURE);
	const out = tintColors(col0, ids, id => id === 2 ? [255, 0, 0] : null);
	ok("tint", J([...out]) === J([10, 10, 10, 255, 255, 0, 0, 128, 30, 30, 30, 255]) && col0[4] === 20);
	ok("tint.alpha", tintColors(col0, ids, () => [1, 2, 3, 4])[7] === 4 && tintColors(col0, null, () => [1, 2, 3])[0] === 10);
}
// ── decodeModel の結線（glb：2 枚・番号＝_FEATURE_ID_0・表＝建物 2 行／implicit の組 1）──
{
	const [sv, so] = strs(["Alpha", "Beta"]);
	const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0, _FEATURE_ID_0: 2 }, indices: 1, extensions: { EXT_mesh_features: { featureIds: [{ featureCount: 2, attribute: 0, propertyTable: 0 }, { featureCount: 4 }] } } }] }],
		accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [0, 0, 0], max: [10, 0, 10] }, { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" }, { bufferView: 2, componentType: 5126, count: 4, type: "SCALAR" }],
		extensionsUsed: ["EXT_mesh_features", "EXT_structural_metadata"],
		extensions: { EXT_structural_metadata: { schema: { id: "s", classes: { bld: { properties: { name: { type: "STRING" }, height: { type: "SCALAR", componentType: "FLOAT32" } } } } }, propertyTables: [{ class: "bld", count: 2, properties: { name: { values: 3, stringOffsets: 4 }, height: { values: 5 } } }] } } };
	const glb = glbOf(json, [B(Float32Array.of(0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10)), B(Uint16Array.of(0, 2, 1, 0, 3, 2)), B(Float32Array.of(0, 0, 1, 1)), sv, so, B(Float32Array.of(12.5, 30))]);
	const r = await decodeModel(glb.slice(0), { at: [139.7671, 35.6812] });
	const f = r.batches[0].features;
	ok("decode.ids", f && J([...f.ids]) === J([0, 0, 1, 1]) && f.table === 0 && f.tblV === null, J(f && [...f.ids]));
	ok("decode.tables", f.tables === r.features.tables && J(featureProperties(f.tables[0], 1)) === J({ name: "Beta", height: 30 }) && J(r.stats.features) === J({ primitives: 1, texture: 0, tables: 1 }));
	const r1 = await decodeModel(glb.slice(0), { at: [139.7671, 35.6812], featureIdSet: 1 });
	ok("decode.set1", J([...r1.batches[0].features.ids]) === J([0, 1, 2, 3]) && r1.batches[0].features.table === null);
	// 番号の無い glb＝features null
	const plain = glbOf({ ...json, accessors: json.accessors.slice(0, 2), meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], extensions: undefined, extensionsUsed: [] }, [B(Float32Array.of(0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10)), B(Uint16Array.of(0, 2, 1, 0, 3, 2))]);
	const r2 = await decodeModel(plain, { at: [139.7671, 35.6812] });
	ok("decode.none", r2.batches[0].features === null && r2.features === null && !r2.stats.features);
}
if (fails) { console.error(`${fails} failed`); process.exit(1); } else console.log("ALL PASS mesh-features");
