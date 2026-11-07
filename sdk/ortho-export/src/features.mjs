// PLATEAU の建物を 1 棟ずつのノードに割り、属性（3D Tiles 1.0 の batch table）を載せる（docs/notes/unity-roundtrip.md §3.2）。
//   PLATEAU（2025・千代田区で確認）＝b3dm 1.0＋Draco＋CESIUM_RTC。頂点ごとの _BATCHID が batch table の行（＝1 棟）を指す。
//   batch table：JSON の配列（gml_id・meshcode・attributes＝CityGML の属性のネスト object…）と、binary（{byteOffset, componentType, type}）の数値列。
//   書き出し：棟ごとに glTF ノード（name＝gml_id・extras.plateau＝その行）。頂点は錨の glTF 座標（E, U, −N）に畳む＝行列のノードは無い。
//   Draco は解く（glTFast は _BATCHID を Unity に渡さない＝棟を分けるにはノードを割るしかない）。出力は無圧縮。
const dec = new TextDecoder();

/** b3dm → { glb, rtc, ft, bt: { json, bin }, batchLength } */
export function readB3dm(buf) {
	const magic = dec.decode(buf.subarray(0, 4));
	if (magic === "glTF") return { glb: buf, rtc: null, ft: {}, bt: { json: {}, bin: new Uint8Array(0) }, batchLength: 0 };
	if (magic !== "b3dm") throw new Error("not b3dm: " + magic);
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const ftJ = dv.getUint32(12, true), ftB = dv.getUint32(16, true), btJ = dv.getUint32(20, true), btB = dv.getUint32(24, true);
	let o = 28;
	const ft = ftJ ? JSON.parse(dec.decode(buf.subarray(o, o + ftJ)).replace(/[\0 ]+$/, "")) : {}; o += ftJ + ftB;
	const btJson = btJ ? JSON.parse(dec.decode(buf.subarray(o, o + btJ)).replace(/[\0 ]+$/, "")) : {}; o += btJ;
	const btBin = buf.subarray(o, o + btB); o += btB;
	return { glb: buf.subarray(o), rtc: ft.RTC_CENTER || null, ft, bt: { json: btJson, bin: btBin }, batchLength: ft.BATCH_LENGTH ?? 0 };
}

const COMP = { BYTE: [1, "getInt8"], UNSIGNED_BYTE: [1, "getUint8"], SHORT: [2, "getInt16"], UNSIGNED_SHORT: [2, "getUint16"],
	INT: [4, "getInt32"], UNSIGNED_INT: [4, "getUint32"], FLOAT: [4, "getFloat32"], DOUBLE: [8, "getFloat64"] };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** batch table → 行の配列（行＝{ キー: 値 }・binary の数値列も行に入る・extensions/extras は落とす） */
export function batchTableRows({ json, bin }, n) {
	const rows = Array.from({ length: n }, () => ({}));
	const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
	for (const [k, v] of Object.entries(json || {})) {
		if (k === "extensions" || k === "extras") continue;
		if (Array.isArray(v)) { for (let i = 0; i < n; i++) rows[i][k] = v[i] ?? null; continue; }
		if (v && typeof v === "object" && v.byteOffset != null && COMP[v.componentType]) {
			const [sz, get] = COMP[v.componentType], c = NC[v.type] || 1;
			for (let i = 0; i < n; i++) {
				const at = v.byteOffset + i * sz * c;
				if (at + sz * c > bin.length) { rows[i][k] = null; continue; }
				const vals = Array.from({ length: c }, (_, j) => dv[get](at + j * sz, true));
				rows[i][k] = c === 1 ? vals[0] : vals;
			}
		}
	}
	return rows;
}

/** 行の識別子（PLATEAU は gml_id・無ければ id 系のキー・それも無ければ null） */
export const featureIdOf = row => row?.gml_id ?? row?.["gml:id"] ?? row?.id ?? row?.["uro:buildingID"] ?? null;

/** Draco の解き手（draco3d・npm）。無ければ理由つきで落ちる */
export async function createDracoDecoder() {
	let draco3d;
	try { draco3d = (await import("draco3d")).default; }
	catch { throw new Error("PLATEAU tiles are Draco-compressed: install draco3d (npm i draco3d), or pass --attributes none to keep the tiles compressed without per-building nodes"); }
	const M = await draco3d.createDecoderModule({});
	const typed = { [M.DT_FLOAT32]: [Float32Array, "HEAPF32"], [M.DT_INT8]: [Int8Array, "HEAP8"], [M.DT_UINT8]: [Uint8Array, "HEAPU8"],
		[M.DT_INT16]: [Int16Array, "HEAP16"], [M.DT_UINT16]: [Uint16Array, "HEAPU16"], [M.DT_INT32]: [Int32Array, "HEAP32"], [M.DT_UINT32]: [Uint32Array, "HEAPU32"] };
	return function decodeDraco(bytes, attrIds) {
		const decoder = new M.Decoder(), buffer = new M.DecoderBuffer(), mesh = new M.Mesh();
		try {
			buffer.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
			const st = decoder.DecodeBufferToMesh(buffer, mesh);
			if (!st.ok() || mesh.ptr === 0) throw new Error("draco: " + st.error_msg());
			const nf = mesh.num_faces(), np = mesh.num_points();
			const ib = nf * 3 * 4, ip = M._malloc(ib);
			decoder.GetTrianglesUInt32Array(mesh, ib, ip);
			const indices = new Uint32Array(M.HEAPU32.buffer, ip, nf * 3).slice();
			M._free(ip);
			const attributes = {};
			for (const [name, id] of Object.entries(attrIds || {})) {
				const att = decoder.GetAttributeByUniqueId(mesh, id);
				if (!att || att.ptr === 0) continue;
				const nc = att.num_components(), dt = att.data_type();
				// 量子化された位置・法線は float で受ける（draco が解く）。整数はそのまま（COLOR の u8・_BATCHID の u16 など）
				const [T, heap] = name === "POSITION" || name === "NORMAL" || name.startsWith("TEXCOORD") || !typed[dt] ? typed[M.DT_FLOAT32] : typed[dt];
				const dtype = T === Float32Array ? M.DT_FLOAT32 : dt;
				const nb = np * nc * T.BYTES_PER_ELEMENT, p = M._malloc(nb);
				decoder.GetAttributeDataArrayForAllPoints(mesh, att, dtype, nb, p);
				let value = new T(M[heap].buffer, p, np * nc).slice();
				M._free(p);
				// 整数の COLOR は 0..1 へ（glbconv は float の色を 0..1 と見る）
				if (name.startsWith("COLOR") && !(value instanceof Float32Array)) { const max = value instanceof Uint8Array ? 255 : value instanceof Uint16Array ? 65535 : 1; value = Float32Array.from(value, v => v / max); }
				attributes[name] = { value, size: nc };
			}
			return { attributes, indices: { value: indices } };
		} finally { M.destroy(mesh); M.destroy(buffer); M.destroy(decoder); }
	};
}

/**
 * 1 タイルの prim（glbToScene の戻り・タイルの glTF 座標）を M で錨の glTF 座標へ畳み、featureIds で棟ごとに割る。
 * @param {import("glbconv").ScenePrim[]} prims
 * @param {number[]} M  列優先 4x4（剛体＝回転＋平行移動）
 * @param {(fid:number)=>object|null} nodeOf  地物番号 → SceneNode（同じ物を返せば 1 ノードにまとまる）
 * @returns {import("glbconv").ScenePrim[]}
 */
export function splitPrims(prims, M, nodeOf) {
	const out = [];
	for (const p of prims) {
		const n = p.positions.length / 3;
		const pos = new Float32Array(n * 3), nrm = p.normals ? new Float32Array(n * 3) : null;
		for (let i = 0; i < n; i++) {
			const x = p.positions[i * 3], y = p.positions[i * 3 + 1], z = p.positions[i * 3 + 2];
			pos[i * 3] = M[0] * x + M[4] * y + M[8] * z + M[12];
			pos[i * 3 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
			pos[i * 3 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
			if (nrm) {
				const a = p.normals[i * 3], b = p.normals[i * 3 + 1], c = p.normals[i * 3 + 2];
				nrm[i * 3] = M[0] * a + M[4] * b + M[8] * c; nrm[i * 3 + 1] = M[1] * a + M[5] * b + M[9] * c; nrm[i * 3 + 2] = M[2] * a + M[6] * b + M[10] * c;
			}
		}
		const fid = p.featureIds;
		if (!fid) { out.push({ ...p, positions: pos, normals: nrm, featureIds: null, node: nodeOf(-1) }); continue; }
		// 三角形を最初の頂点の地物で振り分け、頂点を詰め直す
		const groups = new Map();
		for (let t = 0; t < p.indices.length; t += 3) {
			const f = fid[p.indices[t]];
			let g = groups.get(f); if (!g) groups.set(f, g = []);
			g.push(t);
		}
		for (const [f, tris] of groups) {
			const remap = new Map(), idx = new Uint32Array(tris.length * 3);
			let k = 0;
			for (const t of tris) for (let j = 0; j < 3; j++) {
				const v = p.indices[t + j];
				let w = remap.get(v); if (w == null) { w = remap.size; remap.set(v, w); }
				idx[k++] = w;
			}
			const m = remap.size, P = new Float32Array(m * 3), N = nrm ? new Float32Array(m * 3) : null,
				U = p.uvs ? new Float32Array(m * 2) : null, C = p.colors ? new Uint8Array(m * 4) : null;
			for (const [v, w] of remap) {
				P.set(pos.subarray(v * 3, v * 3 + 3), w * 3);
				if (N) N.set(nrm.subarray(v * 3, v * 3 + 3), w * 3);
				if (U) U.set(p.uvs.subarray(v * 2, v * 2 + 2), w * 2);
				if (C) C.set(p.colors.subarray(v * 4, v * 4 + 4), w * 4);
			}
			out.push({ positions: P, normals: N, uvs: U, colors: C, indices: idx, material: p.material, node: nodeOf(f) });
		}
	}
	return out;
}

/**
 * Unity 向けの属性表（JsonUtility で読める形）：keys＝全棟のキーの和・buildings[i].values は keys と同じ並び（無い＝""）。
 *   入れ子（PLATEAU の attributes＝CityGML の属性）は "/" で平らにする。gen:genericAttribute の {name, value} の列は name をキーに。
 *   "_" で始まるキー（_x・_lod など 3D Tiles 化の時の内部値）は落とす。
 */
export function attributeTable(features) {
	const keys = new Map(), rows = [];
	// 棟は id（gml_id）の順＝同じ範囲を出し直しても表が同じ並びになる（keys も初出の順＝棟の順で決まる）
	for (const { id, row } of [...features].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
		const flat = {};
		flatten(row, "", flat);
		for (const k of Object.keys(flat)) if (!keys.has(k)) keys.set(k, keys.size);
		rows.push({ id, flat });
	}
	const list = [...keys.keys()];
	return { version: 1, keys: list, buildings: rows.map(({ id, flat }) => ({ id, values: list.map(k => flat[k] ?? "") })) };
}
function flatten(v, pre, out) {
	if (v == null || v === "") return;
	if (Array.isArray(v)) {
		if (v.length && v.every(x => x && typeof x === "object" && "name" in x && "value" in x)) { for (const x of v) flatten(x.value, `${pre}/${x.name}`, out); return; }
		if (v.every(x => x == null || typeof x !== "object")) { const s = v.filter(x => x != null).join(", "); if (s && !(pre in out)) out[pre] = s; return; }
		if (v.length === 1) { flatten(v[0], pre, out); return; }
		v.forEach((x, i) => flatten(x, `${pre}[${i}]`, out));
		return;
	}
	if (typeof v === "object") {
		for (const [k, x] of Object.entries(v)) {
			if (!pre && k.startsWith("_")) continue;
			if (k === "type" && pre) continue;   // genericAttribute の型名など
			flatten(x, pre ? (pre === "attributes" ? k : `${pre}/${k}`) : k, out);
		}
		return;
	}
	if (!(pre in out)) out[pre] = typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v);
}

/** 錨から遠すぎる棟（bbox の外）を落とすための判定：行の _x/_y（PLATEAU の 3D Tiles 化が入れる中心の経緯度）が bbox＋margin の中か */
export function rowInside(row, bbox, marginDeg = 0) {
	const x = row?._x, y = row?._y;
	if (typeof x !== "number" || typeof y !== "number") return true;
	return x >= bbox[0] - marginDeg && x <= bbox[2] + marginDeg && y >= bbox[1] - marginDeg && y <= bbox[3] + marginDeg;
}
