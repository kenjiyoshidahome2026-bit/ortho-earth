// 3D Tiles の Gaussian splat（glTF の KHR_gaussian_splatting・2026-10-18）の検定試料（t-tiles3d-splat・tiles3d-splat.mjs）を作る＝node tests/fixtures/tiles3d-splat/make.mjs
// 東京駅（139.7671, 35.6812・楕円体高 40m）に ENU の根（tiles3d と同じ）。glTF は Y-up＝x が東・y が上・z が南。
//   親＝橙の大きな splat 200 個（σ 6m・粗い・REPLACE）
//   子 0（南西）＝赤・仕様の属性名（KHR_gaussian_splatting:SCALE／ROTATION／OPACITY・SH_DEGREE_0_COEF_0）・COLOR_0 の fallback つき
//   子 1（南東）＝緑・仕様の属性名＋1 次の SH（上から見ると青へ寄る係数）
//   子 2（北西）＝青・Cesium の草案の名（_SCALE（log）／_ROTATION／_OPACITY）・COLOR_0 だけ（SH 無し）・正規化した短整数の回転
//   子 3（北東）＝白・SPZ 圧縮（KHR_gaussian_splatting_compression_spz_2＝bufferView に .spz v2 の本体・属性の accessor は bufferView 無し）
// 各子＝40×40 の格子（2.5m 間隔・σ 1.2m・高さ 3〜9m の波）＝1600 個。
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { ENU, pad4 } from "../tiles3d-lib.mjs";
const SH_C0 = 0.28209479177387814;
const dcOf = rgb => rgb.map(c => (c - 0.5) / SH_C0);   // sRGB の色 → DC の係数（0.282×dc＋0.5＝色）
const F32 = a => Buffer.from(new Float32Array(a).buffer);
const lin = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;   // sRGB → 線形（COLOR_0 は glTF の決まりで線形）
function glb(json, parts) {   // parts＝Buffer の列（bufferView を順に・4 byte 詰め）
	const views = [], chunks = []; let off = 0;
	for (const b of parts) { const p = pad4(b, 0); views.push({ buffer: 0, byteOffset: off, byteLength: b.length }); chunks.push(p); off += p.length; }
	const bin = Buffer.concat(chunks);
	const J = pad4(Buffer.from(JSON.stringify({ ...json, buffers: [{ byteLength: bin.length }], bufferViews: views })));
	const head = Buffer.alloc(12); head.write("glTF", 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + J.length + 8 + bin.length, 8);
	const cj = Buffer.alloc(8); cj.writeUInt32LE(J.length, 0); cj.writeUInt32LE(0x4E4F534A, 4);
	const cb = Buffer.alloc(8); cb.writeUInt32LE(bin.length, 0); cb.writeUInt32LE(0x004E4942, 4);
	return Buffer.concat([head, cj, J, cb, bin]);
}
const minmax = (a, k) => { const mn = Array(k).fill(Infinity), mx = Array(k).fill(-Infinity); for (let i = 0; i < a.length; i++) { mn[i % k] = Math.min(mn[i % k], a[i]); mx[i % k] = Math.max(mx[i % k], a[i]); } return { min: mn, max: mx }; };
// 格子の splat（glTF の座標）＝{ pos（x,y,z）, sigma, rgb（0..1）, a }
function grid(cx, cz, half, n, sigma, rgb) {
	const out = [];
	for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
		const x = cx - half + (i + 0.5) * (2 * half / n), z = cz - half + (j + 0.5) * (2 * half / n), y = 6 + 3 * Math.sin(i / 4) * Math.cos(j / 4);
		out.push({ pos: [x, y, z], sigma, rgb, a: 1 });
	}
	return out;
}
// 仕様の属性名の glb（opts.sh1＝1 次の SH の係数 [c0,c1,c2]（それぞれ RGB）・opts.color0＝COLOR_0 も付ける）
function specGlb(S, { sh1 = null, color0 = false } = {}) {
	const n = S.length, pos = S.flatMap(s => s.pos), scale = S.flatMap(s => [s.sigma, s.sigma * 0.6, s.sigma]), rot = S.flatMap(() => [0, 0, 0, 1]), op = S.map(s => s.a), dc = S.flatMap(s => dcOf(s.rgb));
	const parts = [F32(pos), F32(scale), F32(rot), F32(op), F32(dc)];
	const attributes = { POSITION: 0, "KHR_gaussian_splatting:SCALE": 1, "KHR_gaussian_splatting:ROTATION": 2, "KHR_gaussian_splatting:OPACITY": 3, "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0": 4 };
	const accessors = [{ bufferView: 0, componentType: 5126, count: n, type: "VEC3", ...minmax(pos, 3) }, { bufferView: 1, componentType: 5126, count: n, type: "VEC3" }, { bufferView: 2, componentType: 5126, count: n, type: "VEC4" }, { bufferView: 3, componentType: 5126, count: n, type: "SCALAR" }, { bufferView: 4, componentType: 5126, count: n, type: "VEC3" }];
	if (sh1) for (let k = 0; k < 3; k++) { attributes[`KHR_gaussian_splatting:SH_DEGREE_1_COEF_${k}`] = accessors.length; accessors.push({ bufferView: parts.length, componentType: 5126, count: n, type: "VEC3" }); parts.push(F32(S.flatMap(() => sh1[k]))); }
	if (color0) { attributes.COLOR_0 = accessors.length; accessors.push({ bufferView: parts.length, componentType: 5126, count: n, type: "VEC4" }); parts.push(F32(S.flatMap(s => [...s.rgb.map(lin), s.a]))); }   // 線形の RGB＋α
	return glb({ asset: { version: "2.0" }, extensionsUsed: ["KHR_gaussian_splatting"], scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ attributes, mode: 0, extensions: { KHR_gaussian_splatting: { kernel: "ellipse", colorSpace: "srgb_rec709_display" } } }] }], accessors }, parts);
}
// 草案の名（_SCALE＝log の尺・_ROTATION＝正規化した short・_OPACITY）＋COLOR_0（線形・float）
function draftGlb(S) {
	const n = S.length, pos = S.flatMap(s => s.pos), logs = S.flatMap(s => [Math.log(s.sigma), Math.log(s.sigma * 0.6), Math.log(s.sigma)]), op = S.map(s => s.a), col = S.flatMap(s => [...s.rgb.map(lin), s.a]);
	const rot = new Int16Array(n * 4); for (let i = 0; i < n; i++) rot[i * 4 + 3] = 32767;
	const parts = [F32(pos), F32(logs), Buffer.from(rot.buffer), F32(op), F32(col)];
	return glb({ asset: { version: "2.0" }, extensionsUsed: ["KHR_gaussian_splatting"], scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0, _SCALE: 1, _ROTATION: 2, _OPACITY: 3, COLOR_0: 4 }, mode: 0, extensions: { KHR_gaussian_splatting: { kernel: "ellipse", colorSpace: "srgb_rec709_display" } } }] }],
		accessors: [{ bufferView: 0, componentType: 5126, count: n, type: "VEC3", ...minmax(pos, 3) }, { bufferView: 1, componentType: 5126, count: n, type: "VEC3" }, { bufferView: 2, componentType: 5122, normalized: true, count: n, type: "VEC4" }, { bufferView: 3, componentType: 5126, count: n, type: "SCALAR" }, { bufferView: 4, componentType: 5126, count: n, type: "VEC4" }] }, parts);
}
// .spz v2 の本体（sdk/plugin-splat/tests の makeSpz と同じ目）＝位置 24 bit 固定小数・α・DC（0.15 の目）・log の尺（1/16）・回転 3 byte
function spz(S) {
	const n = S.length, frac = 12, b = new Uint8Array(16 + n * (9 + 1 + 3 + 3 + 3)), dv = new DataView(b.buffer);
	dv.setUint32(0, 0x5053474e, true); dv.setUint32(4, 2, true); dv.setUint32(8, n, true); b[12] = 0; b[13] = frac;
	let o = 16;
	for (const s of S) for (const v of s.pos) { const q = Math.round(v * (1 << frac)) & 0xffffff; b[o++] = q & 255; b[o++] = (q >> 8) & 255; b[o++] = (q >> 16) & 255; }
	for (const s of S) b[o++] = Math.round(s.a * 255);
	for (const s of S) for (const c of dcOf(s.rgb)) b[o++] = Math.max(0, Math.min(255, Math.round((c * 0.15 + 0.5) * 255)));
	for (const s of S) for (const v of [s.sigma, s.sigma * 0.6, s.sigma]) b[o++] = Math.round((Math.log(v) + 10) * 16);
	for (let i = 0; i < n; i++) { b[o++] = 128; b[o++] = 128; b[o++] = 128; }   // x,y,z＝0 → w＝1
	return gzipSync(b);
}
function spzGlb(S) {
	const n = S.length, pos = S.flatMap(s => s.pos);
	return glb({ asset: { version: "2.0" }, extensionsUsed: ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"], extensionsRequired: ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"], scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0, "KHR_gaussian_splatting:SCALE": 1, "KHR_gaussian_splatting:ROTATION": 2, "KHR_gaussian_splatting:OPACITY": 3, "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0": 4 }, mode: 0,
			extensions: { KHR_gaussian_splatting: { kernel: "ellipse", colorSpace: "srgb_rec709_display" }, KHR_gaussian_splatting_compression_spz_2: { bufferView: 0 } } }] }],
		accessors: [{ componentType: 5126, count: n, type: "VEC3", ...minmax(pos, 3) }, { componentType: 5126, count: n, type: "VEC3" }, { componentType: 5126, count: n, type: "VEC4" }, { componentType: 5126, count: n, type: "SCALAR" }, { componentType: 5126, count: n, type: "VEC3" }] }, [spz(S)]);
}
const box = (cx, cy, cz, hx, hy, hz) => ({ box: [cx, cy, cz, hx, 0, 0, 0, hy, 0, 0, 0, hz] });   // ENU（東・北・上）
// 親＝橙・200 個（σ 6m）
const parent = []; for (let i = 0; i < 200; i++) parent.push({ pos: [-90 + (i % 20) * 9.5, 6, -90 + Math.floor(i / 20) * 19], sigma: 6, rgb: [1, 0.55, 0.1], a: 1 });
writeFileSync("parent.glb", specGlb(parent));
// 子（glTF の z＝−北）
writeFileSync("child0.glb", specGlb(grid(-50, 50, 50, 40, 1.2, [1, 0.1, 0.1]), { color0: true }));                       // 南西・赤
writeFileSync("child1.glb", specGlb(grid(50, 50, 50, 40, 1.2, [0.1, 0.9, 0.1]), { sh1: [[-0.25, -0.25, 0.4], [0, 0, 0], [0, 0, 0]] }));   // 南東・緑（1 次の SH＝m＝−1（y＝glTF の上）の係数＝上から見るとわずかに青へ寄るが緑のまま＝WebGPU は SH を評価する）
writeFileSync("child2.glb", draftGlb(grid(-50, -50, 50, 40, 1.2, [0.1, 0.2, 1])));                                      // 北西・青（草案の名・log の尺）
writeFileSync("child3.glb", spzGlb(grid(50, -50, 50, 40, 1.2, [1, 1, 1])));                                               // 北東・白（SPZ）
const kid = (ex, ny, uri) => ({ boundingVolume: box(ex, ny, 6, 52, 52, 6), geometricError: 0, content: { uri } });
writeFileSync("tileset.json", JSON.stringify({
	asset: { version: "1.1" }, geometricError: 400, extensionsUsed: ["KHR_gaussian_splatting"],
	root: { transform: ENU, boundingVolume: box(0, 0, 6, 110, 110, 12), geometricError: 150, refine: "REPLACE", content: { uri: "parent.glb" },
		children: [kid(-50, -50, "child0.glb"), kid(50, -50, "child1.glb"), kid(-50, 50, "child2.glb"), kid(50, 50, "child3.glb")] },
}, null, 1));
console.log("ok");
