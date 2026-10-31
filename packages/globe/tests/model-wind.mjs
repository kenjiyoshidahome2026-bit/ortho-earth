// Cesium の表裏（2026-10-31・AEC の Site の塊）：glTF の束の wind（法線あり・doubleSided でない材質＝巻き順で裏を捨てる）・
// 背中合わせの 2 枚を重複として捨てない・鏡の置き方（det < 0）で巻き順と法線を正す
import { decodeModel } from "../src/meshdecode.ts";
globalThis.self ??= globalThis;
let fails = 0; const ok = (n, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${info ? " " + info : ""}`); if (!c) fails++; };
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
// 縦の板（x–y 面・法線 +z＝反時計回りの表）。idx＝表の 1 枚と、同じ 3 点の裏向きの 1 枚
const model = ({ ds = false, normals = true, scale = null, rotation = null, back = true } = {}) => {
	const attrs = { POSITION: 0, ...(normals && { NORMAL: 2 }) };
	const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, ...(scale && { scale }), ...(rotation && { rotation }) }],
		materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] }, ...(ds && { doubleSided: true }) }],
		meshes: [{ primitives: [{ attributes: attrs, indices: 1, material: 0 }] }],
		accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [10, 10, 0] }, { bufferView: 1, componentType: 5123, count: back ? 6 : 3, type: "SCALAR" },
			...(normals ? [{ bufferView: 2, componentType: 5126, count: 3, type: "VEC3" }] : [])] };
	return glbOf(json, [B(Float32Array.of(0, 0, 0, 10, 0, 0, 0, 10, 0)), B(Uint16Array.of(...(back ? [0, 1, 2, 0, 2, 1] : [0, 1, 2]))), ...(normals ? [B(Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1))] : [])]);
};
const at = { at: [139.7671, 35.6812] };
// 出力の 1 枚目の面（位置の巻き順の外積）と頂点の法線の内積の符号
const side = m => { const p = m.pos, n = m.nrm, [a, b, c] = m.idx; const u = [0, 1, 2].map(k => p[b*3+k] - p[a*3+k]), v = [0, 1, 2].map(k => p[c*3+k] - p[a*3+k]);
	const f = [u[1]*v[2] - u[2]*v[1], u[2]*v[0] - u[0]*v[2], u[0]*v[1] - u[1]*v[0]]; return Math.sign(f[0] * n[a*4] + f[1] * n[a*4+1] + f[2] * n[a*4+2]); };
{
	const r = await decodeModel(model(), at), b = r.batches[0];
	ok("wind.single", b.wind === true);
	ok("wind.keepOpposite", b.mesh.idx.length === 6, String(b.mesh.idx.length));   // 背中合わせの 2 枚は両方残す（Cesium は表の 1 枚ずつを描く）
	const d = await decodeModel(model({ ds: true }), at), bd = d.batches[0];
	ok("wind.doubleSided", bd.wind === false && bd.mesh.idx.length === 3, `${bd.wind} ${bd.mesh.idx.length}`);   // 両面＝従来どおり重複を捨てる
	const nn = await decodeModel(model({ normals: false }), at);
	ok("wind.noNormals", nn.batches[0].wind === false && nn.batches[0].pbr.unlit === true);
	const s0 = side((await decodeModel(model({ back: false }), at)).batches[0].mesh);
	const s1 = side((await decodeModel(model({ back: false, scale: [-1, 1, 1] }), at)).batches[0].mesh);
	ok("wind.mirror", s0 !== 0 && s0 === s1, `${s0} ${s1}`);
	// rotations are not mirrors (2026-10-31: the det was read off the wrong column and turned S2 globe tiles inside out)
	const h = Math.SQRT1_2, rots = [[0.5, 0.5, 0.5, 0.5], [-0.5, -0.5, -0.5, 0.5], [h, 0, 0, h], [0, h, 0, h], [0, 0, h, h], [h, h, 0, 0], [0, h, h, 0], [h, 0, h, 0]];
	const ss = []; for (const rotation of rots) ss.push(side((await decodeModel(model({ back: false, rotation }), at)).batches[0].mesh));
	ok("wind.rotationNotMirror", ss.every(v => v === s0), `${s0} ${ss}`);   // 鏡の置き方でも表（巻き順）と法線の向きの関係が変わらない
	// 回転は鏡でない＝1 枚の板の巻き順（idx）を返さない（誤った det は回転を鏡と見て巻き順と法線を一緒に返した＝side では見えない）
	const i0 = Array.from((await decodeModel(model({ back: false }), at)).batches[0].mesh.idx).join(), bad = [];
	for (let k = 0; k < 24; k++) { const t = k * 2.399, ax = [Math.cos(t) * Math.sin(k + 1), Math.sin(t) * Math.sin(k + 1), Math.cos(k + 1)], an = 0.3 + k * 0.25, sn = Math.sin(an / 2);
		const rotation = [ax[0] * sn, ax[1] * sn, ax[2] * sn, Math.cos(an / 2)];
		if (Array.from((await decodeModel(model({ back: false, rotation }), at)).batches[0].mesh.idx).join() !== i0) bad.push(k); }
	ok("wind.rotationKeepsWinding", bad.length === 0, `${i0} bad=${bad}`);
}
if (fails) { console.log(`${fails} FAIL`); process.exit(1); }
console.log("model-wind: all pass");
