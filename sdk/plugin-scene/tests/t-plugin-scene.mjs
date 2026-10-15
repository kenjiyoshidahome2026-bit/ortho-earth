// node の検定：@ortho-earth/plugin-scene の純関数（形・glb・束・焼き・色・錨・向きの基底・plugin の形）。描画は packages/globe の頁 t-pscene。
import { box, cylinder, cone, sphere, parseGlb, packAtlas, normMesh, bakeInstances, parseColor, anchorOf, items, scenePlugin } from "../src/index.ts";
import { basisOf } from "../src/scene-gl.ts";
let fail = 0;
const ok = (name, cond, note = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${note ? " " + note : ""}`); if (!cond) fail++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
// 形
const inRange = m => { let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let i = 0; i < m.pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], m.pos[i + k]); hi[k] = Math.max(hi[k], m.pos[i + k]); } return [lo, hi]; };
const unitN = m => { for (let i = 0; i < m.nrm.length; i += 3) if (!near(Math.hypot(m.nrm[i], m.nrm[i + 1], m.nrm[i + 2]), 1, 1e-5)) return false; return true; };
for (const [name, m] of [["box", box()], ["cylinder", cylinder()], ["cone", cone()], ["sphere", sphere()]]) {
	const [lo, hi] = inRange(m);
	ok(`shape.${name}`, near(lo[0], -0.5, 1e-6) && near(hi[0], 0.5, 1e-6) && near(lo[2], 0, 1e-6) && near(hi[2], 1, 1e-6) && unitN(m) && m.idx.length % 3 === 0 && Math.max(...m.idx) < m.pos.length / 3, `${m.pos.length / 3} v ${m.idx.length / 3} t`);
}
// 箱の法線は外向き（面の中心から見て）
{ const m = box(); let out = true; for (let t = 0; t < m.idx.length; t += 3) { const a = m.idx[t] * 3; const c = [m.pos[a], m.pos[a + 1], m.pos[a + 2] - 0.5]; if (c[0] * m.nrm[a] + c[1] * m.nrm[a + 1] + c[2] * m.nrm[a + 2] <= 0) out = false; } ok("box.outward", out); }
// 自前の mesh：法線を面から作る・範囲外の index は投げる
{ const m = normMesh({ pos: [0, 0, 0, 1, 0, 0, 0, 1, 0] }); ok("mesh.faceNormal", near(m.nrm[2], 1) && m.idx.length === 3); }
{ let th = false; try { normMesh({ pos: [0, 0, 0], idx: [0, 1, 2] }); } catch { th = true; } ok("mesh.badIndex", th); }
// glb：y 上 → z 上・node の平行移動・材質の色・巻きの保持
function glb(json, bin) {
	const js = new TextEncoder().encode(JSON.stringify(json)), jl = (js.length + 3) & ~3, bl = (bin.byteLength + 3) & ~3;
	const out = new ArrayBuffer(12 + 8 + jl + 8 + bl), dv = new DataView(out), u8 = new Uint8Array(out);
	dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.byteLength, true);
	dv.setUint32(12, jl, true); dv.setUint32(16, 0x4E4F534A, true); u8.set(js, 20); for (let i = 20 + js.length; i < 20 + jl; i++) u8[i] = 0x20;
	dv.setUint32(20 + jl, bl, true); dv.setUint32(24 + jl, 0x004E4942, true); u8.set(new Uint8Array(bin), 28 + jl);
	return out;
}
{
	const P = new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]), I = new Uint16Array([0, 1, 2, 0]);   // y 上に 2 m の三角形
	const bin = new Uint8Array(36 + 8); bin.set(new Uint8Array(P.buffer)); bin.set(new Uint8Array(I.buffer), 36);
	const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: [0, 0, -5] }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
		buffers: [{ byteLength: 44 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
		accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }] };
	const m = parseGlb(glb(json, bin.buffer));
	ok("glb.axes", near(m.pos[7], 5) && near(m.pos[8], 2) && near(m.pos[3], 1), JSON.stringify([...m.pos]));   // 2 番目の頂点 (0,2,0)gltf → (0, 5, 2)：−z の平行移動 5 m＝北へ 5 m
	ok("glb.color", m.col[0] === 255 && m.col[1] === 0 && m.col[3] === 255);
	ok("glb.normal", near(Math.hypot(m.nrm[0], m.nrm[1], m.nrm[2]), 1, 1e-5));
	let th = false; try { parseGlb(glb({ ...json, extensionsRequired: ["KHR_draco_mesh_compression"] }, bin.buffer)); } catch (e) { th = /compressed/.test(e.message); } ok("glb.draco", th);
	th = false; try { parseGlb(new ArrayBuffer(24)); } catch { th = true; } ok("glb.magic", th);
}
// 束：重ならない・枠の中・2 の冪
{
	const sizes = [{ w: 30, h: 10 }, { w: 100, h: 40 }, { w: 20, h: 20 }, { w: 64, h: 64 }, { w: 5, h: 70 }], A = packAtlas(sizes);
	let okR = (A.w & (A.w - 1)) === 0 && (A.h & (A.h - 1)) === 0;
	A.rects.forEach((r, i) => { if (r.w !== sizes[i].w || r.x < 0 || r.y < 0 || r.x + r.w > A.w || r.y + r.h > A.h) okR = false; A.rects.forEach((q, j) => { if (i < j && r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h) okR = false; }); });
	ok("atlas.pack", okR, `${A.w}x${A.h}`);
	let th = false; try { packAtlas([{ w: 5000, h: 4 }]); } catch { th = true; } ok("atlas.tooWide", th);
}
// 焼き：位置の無い物は飛ばし keep に元の番号・色・大きさ・向き
{
	const data = [{ p: [139, 35, 10], c: "#ff0000", s: 2 }, { p: null }, { p: [140, 36], c: [0, 255, 0], s: [1, 2, 3] }];
	const b = bakeInstances(data, { getPosition: d => d.p, getColor: d => d.c, getScale: d => d.s, getOrientation: [90, 0, 0], sizeScale: 10 });
	ok("bake.skip", b.n === 2 && b.keep.join() === "0,2");
	ok("bake.values", b.ll[2] === 10 && b.ll[5] === 0 && b.scl[0] === 20 && b.scl[5] === 30 && b.ori[0] === 90 && b.rgba[0] === 255 && b.rgba[5] === 255);
	const fc = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [1, 2, 3] }, properties: {} }] };
	ok("bake.geojson", bakeInstances(fc).n === 1 && items(fc).length === 1);
}
ok("color", JSON.stringify(parseColor("#f00")) === "[255,0,0,255]" && JSON.stringify(parseColor("rgba(0, 128, 255, 0.5)")) === "[0,128,255,128]" && JSON.stringify(parseColor([1, 2, 3])) === "[1,2,3,255]");
ok("anchor", JSON.stringify(anchorOf("bottom")) === "[0.5,1]" && JSON.stringify(anchorOf(null, "center")) === "[0.5,0.5]" && JSON.stringify(anchorOf([0.2, 0.3])) === "[0.2,0.3]");
{ let th = false; try { anchorOf("middle"); } catch { th = true; } ok("anchor.bad", th); }
// 向きの基底：heading 90° で局所の北（列 1）が東を向く・大きさは m/R
{
	const B0 = basisOf(0, 0, 10, 20, 30, 0, 0, 0, 1), B90 = basisOf(0, 0, 10, 20, 30, 90, 0, 0, 1), k = 1 / 6371000;
	// 経度 0・緯度 0：上＝(1,0,0)・東＝(0,0,1)・北＝(0,1,0)（x＝cosφcosλ・y＝sinφ・z＝cosφsinλ）
	ok("basis.enu", near(B0[0][2], 10 * k, 1e-12) && near(B0[1][1], 20 * k, 1e-12) && near(B0[2][0], 30 * k, 1e-12));
	ok("basis.heading", near(B90[1][2], 20 * k, 1e-12) && near(B90[0][1], -10 * k, 1e-12), JSON.stringify(B90));
}
// plugin の形
{
	const added = [], removed = [];
	const map = { registry: { dataKinds: { add: (n, impl) => added.push([n, typeof impl.create]), remove: n => removed.push(n) } } };
	const p = scenePlugin(), off = p.install(map);
	ok("plugin.install", p.name === "plugin-scene" && added.map(a => a[0]).join() === "instanced,billboards,labels3d" && added.every(a => a[1] === "function"));
	off(); ok("plugin.uninstall", removed.join() === "instanced,billboards,labels3d");
	let th = false; try { scenePlugin({ kinds: ["boxes"] }); } catch { th = true; } ok("plugin.badKind", th);
}
console.log(fail ? `FAILED ${fail}` : "ALL PASS plugin-scene");
process.exit(fail ? 1 : 0);
