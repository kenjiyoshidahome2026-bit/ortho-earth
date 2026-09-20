// 書き出し口。入力は全部 scene（scene.js の中立形）。戻りは { name, bytes } の配列＝呼び手が 1 本なら保存、複数なら zip。
import { buildGlb } from "./glb.js";
import { zipStore } from "./zip.js";

const enc = new TextEncoder();
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/ktx2": "ktx2" };
const extOf = m => EXT[m] || "bin";
const pad4 = n => (4 - (n % 4)) % 4;

// ── glTF / GLB ──────────────────────────────────────────────────────────────
// Draco も量子化も解いた「素の」glTF を組む＝どの読み手でも開く（配布用）。
// 頂点は scene の座標そのまま＝CESIUM_RTC があれば拡張として書き戻す（3D Tiles 由来の模型が地球上の場所を保つ）。
function buildGltf(scene, { binUri = null, embed = false } = {}) {
	const json = { asset: { version: "2.0", generator: "glbconv" }, scene: 0, scenes: [{ nodes: [] }],
		nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], images: [], textures: [], samplers: [], buffers: [] };
	const chunks = []; let len = 0;
	const push = (bytes, target) => {   // bufferView を 1 本足す（4 byte 境界）
		const p = pad4(len); if (p) { chunks.push(new Uint8Array(p)); len += p; }
		const bv = { buffer: 0, byteOffset: len, byteLength: bytes.length };
		if (target) bv.target = target;
		chunks.push(bytes); len += bytes.length;
		json.bufferViews.push(bv); return json.bufferViews.length - 1;
	};
	const accessor = (arr, type, comp, target, minmax = false) => {
		const bv = push(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), target);
		const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
		const a = { bufferView: bv, componentType: comp, count: arr.length / n, type };
		if (comp === 5121) a.normalized = true;
		if (minmax) { const mn = new Array(n).fill(Infinity), mx = new Array(n).fill(-Infinity);
			for (let i = 0; i < arr.length; i += n) for (let c = 0; c < n; c++) { const v = arr[i + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
			a.min = mn; a.max = mx; }
		json.accessors.push(a); return json.accessors.length - 1;
	};
	const imgIndex = new Map();
	const texOf = img => {
		if (!img) return null;
		if (imgIndex.has(img.bytes)) return imgIndex.get(img.bytes);
		const bv = push(img.bytes);
		json.images.push({ mimeType: img.mime, bufferView: bv });
		if (!json.samplers.length) json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
		json.textures.push({ sampler: 0, source: json.images.length - 1 });
		const t = json.textures.length - 1; imgIndex.set(img.bytes, t); return t;
	};
	for (const p of scene.prims) {
		const tex = texOf(p.material.image);
		const mat = { name: p.material.name, doubleSided: p.material.doubleSided,
			pbrMetallicRoughness: { baseColorFactor: p.material.baseColor, metallicFactor: 0, roughnessFactor: 1 } };
		if (tex != null) mat.pbrMetallicRoughness.baseColorTexture = { index: tex };
		json.materials.push(mat);
		const attributes = { POSITION: accessor(p.positions, "VEC3", 5126, 34962, true) };
		if (p.normals) attributes.NORMAL = accessor(p.normals, "VEC3", 5126, 34962);
		if (p.uvs) attributes.TEXCOORD_0 = accessor(p.uvs, "VEC2", 5126, 34962);
		if (p.colors) attributes.COLOR_0 = accessor(p.colors, "VEC4", 5121, 34962);
		const idx = accessor(p.indices instanceof Uint32Array ? p.indices : Uint32Array.from(p.indices), "SCALAR", 5125, 34963);
		json.meshes.push({ primitives: [{ attributes, indices: idx, material: json.materials.length - 1, mode: 4 }] });
		json.nodes.push({ mesh: json.meshes.length - 1 });
		json.scenes[0].nodes.push(json.nodes.length - 1);
	}
	if (scene.rtc) { json.extensions = { CESIUM_RTC: { center: scene.rtc } }; json.extensionsUsed = ["CESIUM_RTC"]; json.extensionsRequired = ["CESIUM_RTC"]; }
	const bin = new Uint8Array(len); { let o = 0; for (const c of chunks) { bin.set(c, o); o += c.length; } }
	json.buffers = [{ byteLength: bin.length }];
	if (embed) { let s = ""; for (let i = 0; i < bin.length; i += 0x8000) s += String.fromCharCode(...bin.subarray(i, i + 0x8000));
		json.buffers[0].uri = "data:application/octet-stream;base64," + btoa(s); }
	else if (binUri) json.buffers[0].uri = binUri;
	return { json, bin };
}

export function toGlb(scene, { name = "model" } = {}) {
	const { json, bin } = buildGltf(scene);
	return [{ name: `${name}.glb`, bytes: buildGlb(json, bin) }];
}
export function toGltf(scene, { name = "model", embed = false } = {}) {
	if (embed) { const { json } = buildGltf(scene, { embed: true });
		return [{ name: `${name}.gltf`, bytes: enc.encode(JSON.stringify(json, null, "\t")) }]; }
	const { json, bin } = buildGltf(scene, { binUri: `${name}.bin` });
	return [{ name: `${name}.gltf`, bytes: enc.encode(JSON.stringify(json, null, "\t")) }, { name: `${name}.bin`, bytes: bin }];
}

// ── OBJ（+ MTL + テクスチャ画像）─────────────────────────────────────────────
// 位置情報は OBJ に入らない＝CESIUM_RTC を先頭のコメントに書き残す（相手が地球へ戻せるように）。
export function toObj(scene, { name = "model" } = {}) {
	const files = [], used = new Map();
	let obj = `# ${name} — glbconv\n`;
	if (scene.rtc) obj += `# CESIUM_RTC (ECEF origin, metres): ${scene.rtc.join(" ")}\n`;
	obj += `mtllib ${name}.mtl\n`;
	let mtl = `# ${name} — glbconv\n`;
	let base = 1;
	for (const [i, p] of scene.prims.entries()) {
		const nm = used.has(p.material.name) ? `${p.material.name}_${i}` : p.material.name;
		used.set(p.material.name, true);
		const c = p.material.baseColor;
		mtl += `\nnewmtl ${nm}\nKd ${c[0].toFixed(6)} ${c[1].toFixed(6)} ${c[2].toFixed(6)}\nKa 0 0 0\nKs 0 0 0\nd ${(c[3] ?? 1).toFixed(6)}\nillum 1\n`;
		if (p.material.image) {
			const fn = `${nm}.${extOf(p.material.image.mime)}`;
			if (!files.some(f => f.name === fn)) files.push({ name: fn, bytes: p.material.image.bytes });
			mtl += `map_Kd ${fn}\n`;
		}
		const n = p.positions.length / 3;
		const v = [], vn = [], vt = [];
		for (let k = 0; k < n; k++) v.push(`v ${p.positions[k * 3]} ${p.positions[k * 3 + 1]} ${p.positions[k * 3 + 2]}`);
		if (p.normals) for (let k = 0; k < n; k++) vn.push(`vn ${p.normals[k * 3]} ${p.normals[k * 3 + 1]} ${p.normals[k * 3 + 2]}`);
		if (p.uvs) for (let k = 0; k < n; k++) vt.push(`vt ${p.uvs[k * 2]} ${1 - p.uvs[k * 2 + 1]}`);   // OBJ の v は下が 0
		obj += `\no ${nm}\n${v.join("\n")}\n${vt.length ? vt.join("\n") + "\n" : ""}${vn.length ? vn.join("\n") + "\n" : ""}usemtl ${nm}\n`;
		const f = [];
		for (let k = 0; k < p.indices.length; k += 3) {
			const a = p.indices[k] + base, b = p.indices[k + 1] + base, cc = p.indices[k + 2] + base;
			const s = (x) => vt.length && vn.length ? `${x}/${x}/${x}` : vt.length ? `${x}/${x}` : vn.length ? `${x}//${x}` : `${x}`;
			f.push(`f ${s(a)} ${s(b)} ${s(cc)}`);
		}
		obj += f.join("\n") + "\n";
		base += n;
	}
	files.unshift({ name: `${name}.mtl`, bytes: enc.encode(mtl) });
	files.unshift({ name: `${name}.obj`, bytes: enc.encode(obj) });
	return files;
}

// ── PLY（binary little endian・頂点色つき）──────────────────────────────────
export function toPly(scene, { name = "model" } = {}) {
	let nv = 0, nf = 0;
	for (const p of scene.prims) { nv += p.positions.length / 3; nf += p.indices.length / 3; }
	const head = enc.encode(`ply\nformat binary_little_endian 1.0\ncomment glbconv${scene.rtc ? `\ncomment CESIUM_RTC ${scene.rtc.join(" ")}` : ""}\n`
		+ `element vertex ${nv}\nproperty float x\nproperty float y\nproperty float z\n`
		+ `property float nx\nproperty float ny\nproperty float nz\n`
		+ `property uchar red\nproperty uchar green\nproperty uchar blue\n`
		+ `element face ${nf}\nproperty list uchar int vertex_indices\nend_header\n`);
	const body = new Uint8Array(nv * 27 + nf * 13), dv = new DataView(body.buffer);
	let o = 0, base = 0;
	for (const p of scene.prims) {
		const n = p.positions.length / 3, c = p.material.baseColor;
		const R = Math.round((c[0] ?? 1) * 255), G = Math.round((c[1] ?? 1) * 255), B = Math.round((c[2] ?? 1) * 255);
		for (let i = 0; i < n; i++) {
			dv.setFloat32(o, p.positions[i * 3], true); dv.setFloat32(o + 4, p.positions[i * 3 + 1], true); dv.setFloat32(o + 8, p.positions[i * 3 + 2], true);
			dv.setFloat32(o + 12, p.normals ? p.normals[i * 3] : 0, true); dv.setFloat32(o + 16, p.normals ? p.normals[i * 3 + 1] : 0, true); dv.setFloat32(o + 20, p.normals ? p.normals[i * 3 + 2] : 1, true);
			body[o + 24] = p.colors ? p.colors[i * 4] : R; body[o + 25] = p.colors ? p.colors[i * 4 + 1] : G; body[o + 26] = p.colors ? p.colors[i * 4 + 2] : B;
			o += 27;
		}
		base += 0;
	}
	base = 0;
	for (const p of scene.prims) {
		for (let k = 0; k < p.indices.length; k += 3) {
			body[o] = 3;
			dv.setInt32(o + 1, p.indices[k] + base, true); dv.setInt32(o + 5, p.indices[k + 1] + base, true); dv.setInt32(o + 9, p.indices[k + 2] + base, true);
			o += 13;
		}
		base += p.positions.length / 3;
	}
	const out = new Uint8Array(head.length + body.length);
	out.set(head, 0); out.set(body, head.length);
	return [{ name: `${name}.ply`, bytes: out }];
}

// ── STL（binary・形だけ。3D プリント向け）──────────────────────────────────
export function toStl(scene, { name = "model" } = {}) {
	let nf = 0; for (const p of scene.prims) nf += p.indices.length / 3;
	const out = new Uint8Array(84 + nf * 50), dv = new DataView(out.buffer);
	out.set(enc.encode(`glbconv ${name}${scene.rtc ? ` RTC ${scene.rtc.map(v => v.toFixed(1)).join(",")}` : ""}`.slice(0, 79)), 0);
	dv.setUint32(80, nf, true);
	let o = 84;
	for (const p of scene.prims) {
		const P = p.positions;
		for (let k = 0; k < p.indices.length; k += 3) {
			const a = p.indices[k] * 3, b = p.indices[k + 1] * 3, c = p.indices[k + 2] * 3;
			const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
			const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
			let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
			const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
			dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
			for (const [j, s] of [a, b, c].entries()) {
				dv.setFloat32(o + 12 + j * 12, P[s], true); dv.setFloat32(o + 16 + j * 12, P[s + 1], true); dv.setFloat32(o + 20 + j * 12, P[s + 2], true);
			}
			dv.setUint16(o + 48, 0, true);
			o += 50;
		}
	}
	return [{ name: `${name}.stl`, bytes: out }];
}

// ── USDZ（Apple の AR クイックルック）───────────────────────────────────────
// 中身は .usda（テキスト）＋テクスチャ。USDZ の掟＝無圧縮 zip・各ファイルのデータ先頭を 64 byte 境界に揃える・先頭は usd ファイル。
// glTF は Y-up、USD の既定も Y-up＝軸の入れ替えは不要（upAxis = "Y" を明記する）。
export function toUsdz(scene, { name = "model", metersPerUnit = 1 } = {}) {
	const files = [], texName = new Map();
	let usd = `#usda 1.0\n(\n\tdefaultPrim = "root"\n\tmetersPerUnit = ${metersPerUnit}\n\tupAxis = "Y"\n)\n\ndef Xform "root"\n{\n`;
	for (const [i, p] of scene.prims.entries()) {
		const id = `mesh_${i}`, n = p.positions.length / 3;
		const pts = [];
		for (let k = 0; k < n; k++) pts.push(`(${p.positions[k * 3]}, ${p.positions[k * 3 + 1]}, ${p.positions[k * 3 + 2]})`);
		const fvi = Array.from(p.indices).join(", ");
		const fvc = new Array(p.indices.length / 3).fill(3).join(", ");
		usd += `\tdef Mesh "${id}"\n\t{\n`;
		usd += `\t\tint[] faceVertexCounts = [${fvc}]\n\t\tint[] faceVertexIndices = [${fvi}]\n`;
		usd += `\t\tpoint3f[] points = [${pts.join(", ")}]\n`;
		if (p.normals) { const nn = [];
			for (let k = 0; k < n; k++) nn.push(`(${p.normals[k * 3]}, ${p.normals[k * 3 + 1]}, ${p.normals[k * 3 + 2]})`);
			usd += `\t\tnormal3f[] normals = [${nn.join(", ")}] (interpolation = "vertex")\n`; }
		if (p.uvs) { const uu = [];
			for (let k = 0; k < n; k++) uu.push(`(${p.uvs[k * 2]}, ${1 - p.uvs[k * 2 + 1]})`);
			usd += `\t\ttexCoord2f[] primvars:st = [${uu.join(", ")}] (interpolation = "vertex")\n`; }
		usd += `\t\tuniform token subdivisionScheme = "none"\n`;
		usd += `\t\trel material:binding = </root/mat_${i}>\n\t}\n`;
		let tex = null;
		if (p.material.image) {
			tex = texName.get(p.material.image.bytes);
			if (!tex) { tex = `textures/tex_${texName.size}.${extOf(p.material.image.mime)}`; texName.set(p.material.image.bytes, tex);
				files.push({ name: tex, bytes: p.material.image.bytes }); }
		}
		const c = p.material.baseColor;
		usd += `\tdef Material "mat_${i}"\n\t{\n\t\ttoken outputs:surface.connect = </root/mat_${i}/surface.outputs:surface>\n`;
		usd += `\t\tdef Shader "surface"\n\t\t{\n\t\t\tuniform token info:id = "UsdPreviewSurface"\n`;
		if (tex) usd += `\t\t\tcolor3f inputs:diffuseColor.connect = </root/mat_${i}/tex.outputs:rgb>\n`;
		else usd += `\t\t\tcolor3f inputs:diffuseColor = (${c[0]}, ${c[1]}, ${c[2]})\n`;
		usd += `\t\t\tfloat inputs:metallic = 0\n\t\t\tfloat inputs:roughness = 1\n\t\t\ttoken outputs:surface\n\t\t}\n`;
		if (tex) {
			usd += `\t\tdef Shader "uv"\n\t\t{\n\t\t\tuniform token info:id = "UsdPrimvarReader_float2"\n\t\t\ttoken inputs:varname = "st"\n\t\t\tfloat2 outputs:result\n\t\t}\n`;
			usd += `\t\tdef Shader "tex"\n\t\t{\n\t\t\tuniform token info:id = "UsdUVTexture"\n\t\t\tasset inputs:file = @${tex}@\n`;
			usd += `\t\t\tfloat2 inputs:st.connect = </root/mat_${i}/uv.outputs:result>\n\t\t\ttoken inputs:wrapS = "repeat"\n\t\t\ttoken inputs:wrapT = "repeat"\n\t\t\tfloat3 outputs:rgb\n\t\t}\n`;
		}
		usd += `\t}\n`;
	}
	usd += `}\n`;
	files.unshift({ name: `${name}.usda`, bytes: enc.encode(usd) });
	return [{ name: `${name}.usdz`, bytes: zipStore(files, { align: 64 }) }];
}

// ── 3D Tiles（Cesium などへ戻す）────────────────────────────────────────────
// tileset.json ＋ content の glb。位置は glb の CESIUM_RTC が持つ＝tileset に transform は要らない。
// 境界は ECEF の球（sphere）＝region と違って測地の計算が要らず、どの実装でも読める。
export function toTileset(scene, { name = "model", glb = null } = {}) {
	const content = glb || toGlb(scene, { name: "model" })[0].bytes;
	const c = scene.rtc || [0, 0, 0];
	const b = scene.bbox;
	const half = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2 || 1;
	const mid = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
	// glTF は Y-up・ECEF は Z-up＝中心のずれを ECEF の並びへ（(x,y,z)→(x,−z,y)）
	const center = [c[0] + mid[0], c[1] - mid[2], c[2] + mid[1]];
	const tileset = {
		asset: { version: "1.0", generator: "glbconv" },
		geometricError: half * 2,
		root: {
			boundingVolume: { sphere: [...center, half * Math.sqrt(3)] },
			geometricError: 0,
			refine: "REPLACE",
			content: { uri: "model.glb" },
		},
	};
	return [{ name: `${name}/tileset.json`, bytes: enc.encode(JSON.stringify(tileset, null, "\t")) },
		{ name: `${name}/model.glb`, bytes: content }];
}
