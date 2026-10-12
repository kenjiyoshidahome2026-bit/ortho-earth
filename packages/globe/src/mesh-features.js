// 地物の番号と属性（第 3 波 W7・2026-10-12）＝glTF の EXT_mesh_features（feature ID）と EXT_structural_metadata（property table）、
// 3D Tiles 1.0 の b3dm（_BATCHID＋batch table の JSON）を、模型・タイルの当たり（src/meshpick.js）と feature state の色に使える形へ。
//   番号＝頂点ごとの Uint32（NO_FEATURE＝地物なし・nullFeatureId もこれ）。番号の出どころ＝attribute（_FEATURE_ID_n）か implicit（頂点番号）。
//   texture の番号（featureId.texture）は読まない（capabilities "gltf.featureIds.texture"＝spec）。
//   property table＝列ごとの素の配列（行＝地物の番号）。型＝SCALAR・VECn・MATn（数の並び）・STRING・BOOLEAN・ENUM、固定長／可変長の配列。
//   offset／scale／normalized（数の型）は掛けた値。表に無い列（class の既定値 default）はその値。読めない列は落として理由を warnings に。
export const NO_FEATURE = 0xFFFFFFFF;
const CT = { INT8: Int8Array, UINT8: Uint8Array, INT16: Int16Array, UINT16: Uint16Array, INT32: Int32Array, UINT32: Uint32Array, INT64: BigInt64Array, UINT64: BigUint64Array, FLOAT32: Float32Array, FLOAT64: Float64Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const NORM_MAX = { INT8: 127, UINT8: 255, INT16: 32767, UINT16: 65535, INT32: 2147483647, UINT32: 4294967295 };

// プリミティブの feature ID の組 set（既定 0）→ { attribute, implicit, texture, featureCount, nullFeatureId, propertyTable, label } | null
// EXT_mesh_features が無く _BATCHID（3D Tiles 1.0）が在れば、それを attribute とみなす（propertyTable 0＝batch table）
export function featureSetOf(pr, set = 0) {
	const fs = pr?.extensions?.EXT_mesh_features?.featureIds;
	if (Array.isArray(fs) && fs.length) {
		const f = fs[Math.min(Math.max(0, set | 0), fs.length - 1)];
		if (!f) return null;
		const attr = f.attribute != null ? pr.attributes?.[`_FEATURE_ID_${f.attribute}`]?.value || null : null;
		return { attribute: attr, implicit: f.attribute == null && f.texture == null, texture: f.texture != null, featureCount: f.featureCount | 0, nullFeatureId: f.nullFeatureId ?? null, propertyTable: f.propertyTable ?? null, label: f.label ?? null };
	}
	const bid = pr?.attributes?._BATCHID?.value || pr?.attributes?.BATCHID?.value || null;   // b3dm（glTF 1.0 系の名も）
	return bid ? { attribute: bid, implicit: false, texture: false, featureCount: 0, nullFeatureId: null, propertyTable: 0, label: "_BATCHID", batchId: true } : null;
}
// 頂点 n 個の番号の列（Uint32・NO_FEATURE＝無し）。texture の番号＝読まない＝全部 NO_FEATURE
export function featureIdsOf(fset, n) {
	const out = new Uint32Array(n).fill(NO_FEATURE);
	if (!fset || fset.texture) return out;
	const A = fset.attribute, nul = fset.nullFeatureId;
	for (let i = 0; i < n; i++) {
		const v = A ? Math.round(Number(A[i])) : i;
		if (!(v >= 0) || v === nul || v >= NO_FEATURE) continue;
		out[i] = v;
	}
	return out;
}
// バイト列の切り出し（読める型の配列へ・揃っていなければ複写）
const typed = (u8, T, count) => {
	const need = count * T.BYTES_PER_ELEMENT;
	if (u8.byteLength < need) throw new Error("buffer view too short");
	return u8.byteOffset % T.BYTES_PER_ELEMENT === 0 ? new T(u8.buffer, u8.byteOffset, count) : new T(u8.slice(0, need).buffer);
};
const num = v => typeof v === "bigint" ? (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v;
const scaled = (v, p, cp, i) => {   // normalized → offset/scale（表の値が優先・無ければ class）。成分ごとの配列も可
	if (typeof v !== "number") return v;
	if (cp.normalized && NORM_MAX[cp.componentType]) v = Math.max(v / NORM_MAX[cp.componentType], -1);
	const sc = p.scale ?? cp.scale, of = p.offset ?? cp.offset;
	if (sc != null) v *= Array.isArray(sc) ? (sc[i] ?? 1) : sc;
	if (of != null) v += Array.isArray(of) ? (of[i] ?? 0) : of;
	return v;
};
// EXT_structural_metadata の property table を素の列へ。bytesOf(bufferView 番号) → Uint8Array
// → [{ name, class, count, columns: { 名: 値の配列（長さ count） } }]・warnings（読めなかった列）
export function decodePropertyTables(meta, bytesOf, warnings = []) {
	if (!meta?.propertyTables?.length) return [];
	const schema = meta.schema || {}, classes = schema.classes || {}, enums = schema.enums || {};
	return meta.propertyTables.map((t, ti) => {
		const cls = classes[t.class] || { properties: {} }, count = t.count | 0, columns = {};
		for (const [name, cp] of Object.entries(cls.properties || {})) {
			const p = t.properties?.[name];
			try {
				if (!p) { if (cp.default !== undefined || cp.noData !== undefined) columns[name] = new Array(count).fill(cp.default ?? null); continue; }
				columns[name] = decodeColumn(cp, p, count, bytesOf, enums);
			} catch (e) { warnings.push(`propertyTable ${ti} ${name}: ${e?.message || e}`); }
		}
		return { name: t.name ?? null, class: t.class ?? null, count, columns };
	});
}
function decodeColumn(cp, p, count, bytesOf, enums) {
	const type = cp.type, nc = NCOMP[type];
	const offsets = (view, ot, n) => { const T = CT[ot || "UINT32"]; if (!T) throw new Error(`offset type ${ot}`); return Array.from(typed(bytesOf(view), T, n + 1), Number); };
	const nd = v => (cp.noData !== undefined && JSON.stringify(v) === JSON.stringify(cp.noData)) ? (cp.default ?? null) : v;
	if (type === "STRING") {
		const u8 = bytesOf(p.values), dec = new TextDecoder();
		if (cp.array) {
			const ao = cp.count ? null : offsets(p.arrayOffsets, p.arrayOffsetType, count), nS = ao ? ao[count] : cp.count * count;
			const so = offsets(p.stringOffsets, p.stringOffsetType, nS), all = Array.from({ length: nS }, (_, k) => dec.decode(u8.subarray(so[k], so[k + 1])));
			return Array.from({ length: count }, (_, r) => nd(ao ? all.slice(ao[r], ao[r + 1]) : all.slice(r * cp.count, (r + 1) * cp.count)));
		}
		const so = offsets(p.stringOffsets, p.stringOffsetType, count);
		return Array.from({ length: count }, (_, r) => nd(dec.decode(u8.subarray(so[r], so[r + 1]))));
	}
	if (type === "BOOLEAN") {
		const u8 = bytesOf(p.values), bit = k => !!(u8[k >> 3] & (1 << (k & 7)));
		if (cp.array) {
			const ao = cp.count ? null : offsets(p.arrayOffsets, p.arrayOffsetType, count);
			return Array.from({ length: count }, (_, r) => { const a = ao ? ao[r] : r * cp.count, b = ao ? ao[r + 1] : (r + 1) * cp.count; return Array.from({ length: b - a }, (_, k) => bit(a + k)); });
		}
		return Array.from({ length: count }, (_, r) => bit(r));
	}
	let ctName = cp.componentType, names = null;
	if (type === "ENUM") { const e = enums[cp.enumType]; if (!e) throw new Error(`enum ${cp.enumType}`); ctName = e.valueType || "UINT16"; names = new Map((e.values || []).map(v => [v.value, v.name])); }
	else if (!nc) throw new Error(`type ${type}`);
	const T = CT[ctName]; if (!T) throw new Error(`componentType ${ctName}`);
	const per = type === "ENUM" ? 1 : nc, u8 = bytesOf(p.values);
	const isNo = (vals, k0) => cp.noData !== undefined && (per === 1 ? num(vals[k0]) === cp.noData : Array.isArray(cp.noData) && cp.noData.every((v, i) => num(vals[k0 + i]) === v));   // noData＝生の値で比べる（offset/scale の前）
	const one = (vals, k0) => {   // 1 要素（成分 per 個）
		if (names) return names.get(Number(vals[k0])) ?? Number(vals[k0]);
		if (isNo(vals, k0)) return cp.default ?? null;
		if (per === 1) return scaled(num(vals[k0]), p, cp, 0);
		return Array.from({ length: per }, (_, i) => scaled(num(vals[k0 + i]), p, cp, i));
	};
	if (cp.array) {
		const ao = cp.count ? null : offsets(p.arrayOffsets, p.arrayOffsetType, count), nE = ao ? ao[count] : cp.count * count;
		const vals = typed(u8, T, nE * per);
		return Array.from({ length: count }, (_, r) => { const a = ao ? ao[r] : r * cp.count, b = ao ? ao[r + 1] : (r + 1) * cp.count; return nd(Array.from({ length: b - a }, (_, k) => one(vals, (a + k) * per))); });
	}
	const vals = typed(u8, T, count * per);
	return Array.from({ length: count }, (_, r) => one(vals, r * per));
}
// b3dm の batch table（JSON）＝配列の列だけ（binary 参照 { byteOffset, componentType, type } は bin 付きで読む）。→ property table と同じ形
export function batchTableOf(json, bin, count) {
	if (!json || !(count > 0)) return null;
	const columns = {};
	for (const [k, v] of Object.entries(json)) {
		if (k === "extensions" || k === "extras") continue;
		if (Array.isArray(v)) { columns[k] = v.slice(0, count); continue; }
		if (v && typeof v === "object" && v.byteOffset != null && bin) {
			const T = { BYTE: Int8Array, UNSIGNED_BYTE: Uint8Array, SHORT: Int16Array, UNSIGNED_SHORT: Uint16Array, INT: Int32Array, UNSIGNED_INT: Uint32Array, FLOAT: Float32Array, DOUBLE: Float64Array }[v.componentType];
			const nc = NCOMP[v.type] || 1; if (!T) continue;
			try { const a = typed(bin.subarray(v.byteOffset), T, count * nc); columns[k] = Array.from({ length: count }, (_, r) => nc === 1 ? a[r] : Array.from(a.subarray(r * nc, r * nc + nc))); } catch { /* 短い＝落とす */ }
		}
	}
	return { name: "batchTable", class: null, count, columns };
}
// 行（地物の番号）→ 属性の素のオブジェクト
export function featureProperties(table, id) {
	if (!table || !(id >= 0) || id >= table.count) return {};
	const o = {}; for (const [k, col] of Object.entries(table.columns)) o[k] = col[id];
	return o;
}
