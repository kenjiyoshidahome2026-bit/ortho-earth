// GLB → 中立な「シーン」へ。ここが唯一の読み口で、書き出し側（OBJ/PLY/STL/USDZ/glTF）は全部これだけを見る。
//
//   scene = {
//     rtc: [x,y,z] | null,              // CESIUM_RTC＝ECEF の原点（3D Tiles 由来の模型が持つ）。頂点はこの原点からの相対
//     prims: [{ positions, normals|null, uvs|null, colors|null, indices, material }]
//     bbox: [minx,miny,minz, maxx,maxy,maxz]
//   }
//   material = { name, baseColor:[r,g,b,a], doubleSided, image: { mime, bytes } | null }
//
// 頂点はノードの行列を畳んだ後の座標（＝シーンの座標系）。法線は余因子行列で回す（非等方スケールでも向きが狂わない）。
// Draco（KHR_draco_mesh_compression）は自前で解かない＝呼び手が decodeDraco を渡す（注入口）。
//   decodeDraco(bytes, attrIds) → { attributes: { POSITION: {value,size}, … }, indices: { value } }
import { parseGlb, viewBytes } from "./glb.js";

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const DEQ = { 5120: 1 / 127, 5121: 1 / 255, 5122: 1 / 32767, 5123: 1 / 65535, 5125: 1, 5126: 1 };

// 列優先 4x4（glTF の並び）
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a, b) => { const o = new Array(16);
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
	return o; };
const trs = (t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) => {
	const [x, y, z, w] = q, xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
	return [(1 - 2 * (yy + zz)) * s[0], (2 * (xy + wz)) * s[0], (2 * (xz - wy)) * s[0], 0,
		(2 * (xy - wz)) * s[1], (1 - 2 * (xx + zz)) * s[1], (2 * (yz + wx)) * s[1], 0,
		(2 * (xz + wy)) * s[2], (2 * (yz - wx)) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
		t[0], t[1], t[2], 1];
};

function readAccessor(json, bin, index) {
	const a = json.accessors?.[index];
	if (!a) return null;
	const n = NCOMP[a.type] || 1, C = COMP[a.componentType];
	if (!C) throw new Error("unknown componentType " + a.componentType);
	const out = new (a.componentType === 5126 || a.normalized ? Float32Array : C)(a.count * n);
	if (a.bufferView == null) return out;   // 全部ゼロ（sparse は未対応＝実データでは稀）
	const bv = json.bufferViews[a.bufferView];
	const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
	const stride = bv.byteStride || C.BYTES_PER_ELEMENT * n;
	const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
	const q = a.normalized ? DEQ[a.componentType] : 1;
	const get = { 5120: (o) => dv.getInt8(o), 5121: (o) => dv.getUint8(o), 5122: (o) => dv.getInt16(o, true),
		5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true), 5126: (o) => dv.getFloat32(o, true) }[a.componentType];
	for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) {
		const v = get(base + i * stride + c * C.BYTES_PER_ELEMENT);
		out[i * n + c] = a.normalized ? Math.max(v * q, a.componentType === 5120 || a.componentType === 5122 ? -1 : 0) : v;
	}
	return out;
}

const imageOf = (json, bin, texIndex) => {
	const t = json.textures?.[texIndex]; if (!t) return null;
	const src = t.source ?? t.extensions?.EXT_texture_webp?.source ?? t.extensions?.KHR_texture_basisu?.source;
	const im = json.images?.[src]; if (!im) return null;
	if (im.bufferView != null) return { mime: im.mimeType || "image/png", bytes: viewBytes(json, bin, im.bufferView) };
	if (typeof im.uri === "string" && im.uri.startsWith("data:")) {
		const m = im.uri.match(/^data:([^;]+);base64,(.*)$/s); if (!m) return null;
		const b = atob(m[2]), u = new Uint8Array(b.length);
		for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
		return { mime: m[1], bytes: u };
	}
	return null;   // 外部ファイル参照は読まない（GLB は自己完結が前提）
};

const materialOf = (json, bin, index, i) => {
	const m = json.materials?.[index] || null;
	const mr = m?.pbrMetallicRoughness, sg = m?.extensions?.KHR_materials_pbrSpecularGlossiness;
	const ti = mr?.baseColorTexture || sg?.diffuseTexture || null;
	return {
		name: (m?.name || `material_${index ?? i}`).replace(/[^\w.-]+/g, "_"),
		baseColor: mr?.baseColorFactor || sg?.diffuseFactor || [1, 1, 1, 1],
		doubleSided: !!m?.doubleSided,
		image: ti ? imageOf(json, bin, ti.index) : null,
	};
};

// 三角形列へ（mode 4=TRIANGLES / 5=STRIP / 6=FAN）。それ以外（点・線）は捨てる
function triIndices(mode, idx, vertexCount) {
	const src = idx || Uint32Array.from({ length: vertexCount }, (_, i) => i);
	if (mode === 4 || mode == null) return Uint32Array.from(src);
	const out = [];
	if (mode === 5) for (let i = 2; i < src.length; i++) (i & 1) ? out.push(src[i - 1], src[i - 2], src[i]) : out.push(src[i - 2], src[i - 1], src[i]);
	else if (mode === 6) for (let i = 2; i < src.length; i++) out.push(src[0], src[i - 1], src[i]);
	else return null;
	return Uint32Array.from(out);
}

export async function glbToScene(bytes, { decodeDraco = null, images = true } = {}) {
	const { json, bin } = parseGlb(bytes);
	const rtc = json.extensions?.CESIUM_RTC?.center || null;
	const nodes = json.nodes || [];
	const roots = json.scenes?.[json.scene ?? 0]?.nodes
		?? (() => { const kids = new Set(); for (const n of nodes) for (const c of n.children || []) kids.add(c); return nodes.map((_, i) => i).filter(i => !kids.has(i)); })();
	const jobs = [];
	const visit = (i, P, depth) => {
		const nd = nodes[i]; if (!nd || depth > 64) return;
		const W = mul(P, nd.matrix ? [...nd.matrix] : trs(nd.translation, nd.rotation, nd.scale));
		if (nd.mesh != null) jobs.push({ mesh: nd.mesh, W });
		for (const c of nd.children || []) visit(c, W, depth + 1);
	};
	for (const r of roots) visit(r, I4, 0);

	const prims = [];
	const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (const { mesh, W } of jobs) {
		// 法線用の余因子（W の 3x3 部分）
		const L = [W[0], W[1], W[2], W[4], W[5], W[6], W[8], W[9], W[10]];
		const cof = [L[4] * L[8] - L[5] * L[7], L[5] * L[6] - L[3] * L[8], L[3] * L[7] - L[4] * L[6],
			L[7] * L[2] - L[8] * L[1], L[8] * L[0] - L[6] * L[2], L[6] * L[1] - L[7] * L[0],
			L[1] * L[5] - L[2] * L[4], L[2] * L[3] - L[0] * L[5], L[0] * L[4] - L[1] * L[3]];
		for (const [pi, pr] of (json.meshes?.[mesh]?.primitives || []).entries()) {
			let P = null, N = null, UV = null, C = null, IDX = null;
			const dr = pr.extensions?.KHR_draco_mesh_compression;
			if (dr) {
				if (!decodeDraco) throw new Error("this GLB is Draco-compressed: pass decodeDraco");
				const d = await decodeDraco(viewBytes(json, bin, dr.bufferView), dr.attributes);
				const at = d.attributes || {};
				const val = k => at[k]?.value ?? at[k] ?? null;
				P = val("POSITION"); N = val("NORMAL"); UV = val("TEXCOORD_0"); C = val("COLOR_0");
				IDX = d.indices?.value ?? d.indices ?? null;
			} else {
				if (pr.attributes?.POSITION == null) continue;
				P = readAccessor(json, bin, pr.attributes.POSITION);
				N = pr.attributes.NORMAL != null ? readAccessor(json, bin, pr.attributes.NORMAL) : null;
				UV = pr.attributes.TEXCOORD_0 != null ? readAccessor(json, bin, pr.attributes.TEXCOORD_0) : null;
				C = pr.attributes.COLOR_0 != null ? readAccessor(json, bin, pr.attributes.COLOR_0) : null;
				IDX = pr.indices != null ? readAccessor(json, bin, pr.indices) : null;
			}
			if (!P || !P.length) continue;
			const idx = triIndices(pr.mode, IDX, P.length / 3);
			if (!idx || !idx.length) continue;
			const n = P.length / 3;
			const pos = new Float32Array(n * 3);
			for (let i = 0; i < n; i++) {
				const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
				const wx = L[0] * x + L[3] * y + L[6] * z + W[12], wy = L[1] * x + L[4] * y + L[7] * z + W[13], wz = L[2] * x + L[5] * y + L[8] * z + W[14];
				pos[i * 3] = wx; pos[i * 3 + 1] = wy; pos[i * 3 + 2] = wz;
				if (wx < bbox[0]) bbox[0] = wx; if (wy < bbox[1]) bbox[1] = wy; if (wz < bbox[2]) bbox[2] = wz;
				if (wx > bbox[3]) bbox[3] = wx; if (wy > bbox[4]) bbox[4] = wy; if (wz > bbox[5]) bbox[5] = wz;
			}
			let nrm = null;
			if (N && N.length >= n * 3) {
				nrm = new Float32Array(n * 3);
				for (let i = 0; i < n; i++) {
					const x = N[i * 3], y = N[i * 3 + 1], z = N[i * 3 + 2];
					let a = cof[0] * x + cof[3] * y + cof[6] * z, b = cof[1] * x + cof[4] * y + cof[7] * z, c = cof[2] * x + cof[5] * y + cof[8] * z;
					const l = Math.hypot(a, b, c) || 1;
					nrm[i * 3] = a / l; nrm[i * 3 + 1] = b / l; nrm[i * 3 + 2] = c / l;
				}
			}
			let uvs = null;
			if (UV && UV.length >= n * 2) { uvs = new Float32Array(n * 2); uvs.set(UV.subarray(0, n * 2)); }
			let cols = null;
			if (C) {
				const k = C.length / n | 0;   // VEC3 か VEC4
				cols = new Uint8Array(n * 4);
				for (let i = 0; i < n; i++) {
					const f = C instanceof Float32Array ? 255 : 1;
					cols[i * 4] = Math.min(255, Math.round((C[i * k] || 0) * f));
					cols[i * 4 + 1] = Math.min(255, Math.round((C[i * k + 1] || 0) * f));
					cols[i * 4 + 2] = Math.min(255, Math.round((C[i * k + 2] || 0) * f));
					cols[i * 4 + 3] = k === 4 ? Math.min(255, Math.round((C[i * k + 3] || 0) * f)) : 255;
				}
			}
			prims.push({ positions: pos, normals: nrm, uvs, colors: cols, indices: idx,
				material: materialOf(json, images ? bin : new Uint8Array(0), pr.material, `${mesh}_${pi}`) });
		}
	}
	if (!prims.length) throw new Error("no triangles in this GLB");
	return { rtc, prims, bbox, source: { json, bin } };
}

export const sceneStats = s => ({
	primitives: s.prims.length,
	vertices: s.prims.reduce((a, p) => a + p.positions.length / 3, 0),
	triangles: s.prims.reduce((a, p) => a + p.indices.length / 3, 0),
	textures: new Set(s.prims.map(p => p.material.image?.bytes).filter(Boolean)).size,
	rtc: s.rtc, bbox: s.bbox,
});
