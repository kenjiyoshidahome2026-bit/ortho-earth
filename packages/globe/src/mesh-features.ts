// 地物の番号と属性（第 3 波 W7・2026-10-12）＝glTF の EXT_mesh_features（feature ID）と EXT_structural_metadata（property table）、
// 3D Tiles 1.0 の b3dm（_BATCHID＋batch table の JSON）を、模型・タイルの当たり（src/meshpick.js）と feature state の色に使える形へ。
//   番号＝頂点ごとの Uint32（NO_FEATURE＝地物なし・nullFeatureId もこれ）。番号の出どころ＝attribute（_FEATURE_ID_n）か implicit（頂点番号）。
//   texture の番号（featureId.texture）は読まない（capabilities "gltf.featureIds.texture"＝spec）。
//   property table＝列ごとの素の配列（行＝地物の番号）。型＝SCALAR・VECn・MATn（数の並び）・STRING・BOOLEAN・ENUM、固定長／可変長の配列。
//   offset／scale／normalized（数の型）は掛けた値。表に無い列（class の既定値 default）はその値。読めない列は落として理由を warnings に。
export const NO_FEATURE = 0xFFFFFFFF;
/** 数の列（型付き配列・BigInt の配列も） */
type AnyTyped = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array | BigInt64Array | BigUint64Array;
interface TypedCtor { new (buffer: ArrayBufferLike, byteOffset?: number, length?: number): AnyTyped; readonly BYTES_PER_ELEMENT: number }
/** glTF のプリミティブ（postProcessGLTF 後）の読む欄＝attributes の value・EXT_mesh_features の featureIds */
export interface FeaturePrimitive {
	attributes?: Record<string, { value?: ArrayLike<number | bigint> | null } | undefined> | null;
	extensions?: { EXT_mesh_features?: { featureIds?: Array<{ attribute?: number | null; texture?: unknown; featureCount?: number; nullFeatureId?: number | null; propertyTable?: number | null; label?: string | null } | null> } | null; [k: string]: unknown } | null;
}
/** プリミティブの feature ID の組（featureSetOf の戻り） */
export interface FeatureSet { attribute: ArrayLike<number | bigint> | null; implicit: boolean; texture: boolean; featureCount: number; nullFeatureId: number | null; propertyTable: number | null; label: string | null; batchId?: boolean }
/** property table（EXT_structural_metadata）か batch table の 1 枚＝列の名前 → 行ごとの値 */
export interface PropertyTable { name: string | null; class: string | null; count: number; columns: Record<string, unknown[]> }
/** 束の地物の番号（worker の答え）＝ids＝頂点ごとの番号・tblV＝頂点ごとの property table の番号（無ければ table＝束で 1 つ） */
export interface MeshFeatures { ids: Uint32Array; tblV?: ArrayLike<number> | null; table?: number | null; tables?: PropertyTable[] | null }
/** EXT_structural_metadata の class の property（読む欄） */
interface ClassProperty { type?: string; componentType?: string; enumType?: string; array?: boolean; count?: number; normalized?: boolean; offset?: number | number[]; scale?: number | number[]; default?: unknown; noData?: unknown }
/** property table の property（読む欄）＝values 等は bufferView の番号 */
interface TableProperty { values: number; arrayOffsets: number; stringOffsets: number; arrayOffsetType?: string; stringOffsetType?: string; offset?: number | number[]; scale?: number | number[] }
/** EXT_structural_metadata（読む欄） */
export interface StructuralMetadata {
	schema?: { classes?: Record<string, { properties?: Record<string, ClassProperty> }>; enums?: Record<string, { valueType?: string; values?: Array<{ value: number; name: string }> }> } | null;
	propertyTables?: Array<{ name?: string; class?: string; count?: number; properties?: Record<string, TableProperty> }>;
}
type EnumDefs = NonNullable<NonNullable<StructuralMetadata["schema"]>["enums"]>;
// 型名→配列の型。glTF／batch table から来る名は switch で引く（表の object／Map を名で引くと、"constructor" 等が prototype に当たり得る）
function ctorOf(name: string | undefined): TypedCtor | null {   // EXT_structural_metadata の componentType
	switch (name) {
		case "INT8": return Int8Array; case "UINT8": return Uint8Array; case "INT16": return Int16Array; case "UINT16": return Uint16Array;
		case "INT32": return Int32Array; case "UINT32": return Uint32Array; case "INT64": return BigInt64Array; case "UINT64": return BigUint64Array;
		case "FLOAT32": return Float32Array; case "FLOAT64": return Float64Array; default: return null;
	}
}
function batchCtorOf(name: string | undefined): TypedCtor | null {   // b3dm の batch table の componentType
	switch (name) {
		case "BYTE": return Int8Array; case "UNSIGNED_BYTE": return Uint8Array; case "SHORT": return Int16Array; case "UNSIGNED_SHORT": return Uint16Array;
		case "INT": return Int32Array; case "UNSIGNED_INT": return Uint32Array; case "FLOAT": return Float32Array; case "DOUBLE": return Float64Array; default: return null;
	}
}
const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const NORM_MAX: Record<string, number> = { INT8: 127, UINT8: 255, INT16: 32767, UINT16: 65535, INT32: 2147483647, UINT32: 4294967295 };

// プリミティブの feature ID の組 set（既定 0）→ { attribute, implicit, texture, featureCount, nullFeatureId, propertyTable, label } | null
// EXT_mesh_features が無く _BATCHID（3D Tiles 1.0）が在れば、それを attribute とみなす（propertyTable 0＝batch table）
export function featureSetOf(pr: FeaturePrimitive | null | undefined, set = 0): FeatureSet | null {
	const fs = pr?.extensions?.EXT_mesh_features?.featureIds;
	if (Array.isArray(fs) && fs.length) {
		const f = fs[Math.min(Math.max(0, set | 0), fs.length - 1)];
		if (!f) return null;
		const attr = f.attribute != null ? pr!.attributes?.[`_FEATURE_ID_${f.attribute}`]?.value || null : null;
		return { attribute: attr, implicit: f.attribute == null && f.texture == null, texture: f.texture != null, featureCount: f.featureCount! | 0, nullFeatureId: f.nullFeatureId ?? null, propertyTable: f.propertyTable ?? null, label: f.label ?? null };
	}
	const bid = pr?.attributes?._BATCHID?.value || pr?.attributes?.BATCHID?.value || null;   // b3dm（glTF 1.0 系の名も）
	return bid ? { attribute: bid, implicit: false, texture: false, featureCount: 0, nullFeatureId: null, propertyTable: 0, label: "_BATCHID", batchId: true } : null;
}
// 頂点 n 個の番号の列（Uint32・NO_FEATURE＝無し）。texture の番号＝読まない＝全部 NO_FEATURE
export function featureIdsOf(fset: FeatureSet | null | undefined, n: number): Uint32Array {
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
const typed = (u8: Uint8Array, T: TypedCtor, count: number): AnyTyped => {
	const need = count * T.BYTES_PER_ELEMENT;
	if (u8.byteLength < need) throw new Error("buffer view too short");
	return u8.byteOffset % T.BYTES_PER_ELEMENT === 0 ? new T(u8.buffer, u8.byteOffset, count) : new T(u8.slice(0, need).buffer);
};
const num = (v: number | bigint): number | string => typeof v === "bigint" ? (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString()) : v;
const scaled = (v: number | string, p: TableProperty, cp: ClassProperty, i: number) => {   // normalized → offset/scale（表の値が優先・無ければ class）。成分ごとの配列も可
	if (typeof v !== "number") return v;
	if (cp.normalized && NORM_MAX[cp.componentType!]) v = Math.max(v / NORM_MAX[cp.componentType!], -1);
	const sc = p.scale ?? cp.scale, of = p.offset ?? cp.offset;
	if (sc != null) v *= Array.isArray(sc) ? (sc[i] ?? 1) : sc;
	if (of != null) v += Array.isArray(of) ? (of[i] ?? 0) : of;
	return v;
};
// EXT_structural_metadata の property table を素の列へ。bytesOf(bufferView 番号) → Uint8Array
// → [{ name, class, count, columns: { 名: 値の配列（長さ count） } }]・warnings（読めなかった列）
export function decodePropertyTables(meta: StructuralMetadata | null | undefined, bytesOf: (view: number) => Uint8Array, warnings: string[] = []): PropertyTable[] {
	if (!meta?.propertyTables?.length) return [];
	const schema = meta.schema || {}, classes = schema.classes || {}, enums = schema.enums || {};
	return meta.propertyTables.map((t, ti) => {
		const cls = classes[t.class!] || { properties: {} }, count = t.count! | 0, columns: Record<string, unknown[]> = {};
		for (const [name, cp] of Object.entries(cls.properties || {})) {
			const p = t.properties?.[name];
			try {
				if (!p) { if (cp.default !== undefined || cp.noData !== undefined) columns[name] = new Array(count).fill(cp.default ?? null); continue; }
				columns[name] = decodeColumn(cp, p, count, bytesOf, enums);
			} catch (e) { warnings.push(`propertyTable ${ti} ${name}: ${(e as Error | null)?.message || e}`); }
		}
		return { name: t.name ?? null, class: t.class ?? null, count, columns };
	});
}
function decodeColumn(cp: ClassProperty, p: TableProperty, count: number, bytesOf: (view: number) => Uint8Array, enums: EnumDefs): unknown[] {
	const type = cp.type, nc = NCOMP[type!];
	const offsets = (view: number, ot: string | undefined, n: number) => { const T = ctorOf(ot || "UINT32"); if (!T) throw new Error(`offset type ${ot}`); return Array.from(typed(bytesOf(view), T, n + 1), Number); };
	const nd = (v: unknown) => (cp.noData !== undefined && JSON.stringify(v) === JSON.stringify(cp.noData)) ? (cp.default ?? null) : v;
	if (type === "STRING") {
		const u8 = bytesOf(p.values), dec = new TextDecoder();
		if (cp.array) {
			const ao = cp.count ? null : offsets(p.arrayOffsets, p.arrayOffsetType, count), nS = ao ? ao[count] : cp.count! * count;
			const so = offsets(p.stringOffsets, p.stringOffsetType, nS), all = Array.from({ length: nS }, (_, k) => dec.decode(u8.subarray(so[k], so[k + 1])));
			return Array.from({ length: count }, (_, r) => nd(ao ? all.slice(ao[r], ao[r + 1]) : all.slice(r * cp.count!, (r + 1) * cp.count!)));
		}
		const so = offsets(p.stringOffsets, p.stringOffsetType, count);
		return Array.from({ length: count }, (_, r) => nd(dec.decode(u8.subarray(so[r], so[r + 1]))));
	}
	if (type === "BOOLEAN") {
		const u8 = bytesOf(p.values), bit = (k: number) => !!(u8[k >> 3] & (1 << (k & 7)));
		if (cp.array) {
			const ao = cp.count ? null : offsets(p.arrayOffsets, p.arrayOffsetType, count);
			return Array.from({ length: count }, (_, r) => { const a = ao ? ao[r] : r * cp.count!, b = ao ? ao[r + 1] : (r + 1) * cp.count!; return Array.from({ length: b - a }, (_, k) => bit(a + k)); });
		}
		return Array.from({ length: count }, (_, r) => bit(r));
	}
	let ctName = cp.componentType, names: Map<number, string> | null = null;
	if (type === "ENUM") { const e = enums[cp.enumType!]; if (!e) throw new Error(`enum ${cp.enumType}`); ctName = e.valueType || "UINT16"; names = new Map((e.values || []).map(v => [v.value, v.name])); }
	else if (!nc) throw new Error(`type ${type}`);
	const T = ctorOf(ctName); if (!T) throw new Error(`componentType ${ctName}`);
	const per = type === "ENUM" ? 1 : nc, u8 = bytesOf(p.values);
	const isNo = (vals: AnyTyped, k0: number) => cp.noData !== undefined && (per === 1 ? num(vals[k0]) === cp.noData : Array.isArray(cp.noData) && cp.noData.every((v, i) => num(vals[k0 + i]) === v));   // noData＝生の値で比べる（offset/scale の前）
	const one = (vals: AnyTyped, k0: number) => {   // 1 要素（成分 per 個）
		if (names) return names.get(Number(vals[k0])) ?? Number(vals[k0]);
		if (isNo(vals, k0)) return cp.default ?? null;
		if (per === 1) return scaled(num(vals[k0]), p, cp, 0);
		return Array.from({ length: per }, (_, i) => scaled(num(vals[k0 + i]), p, cp, i));
	};
	if (cp.array) {
		const ao = cp.count ? null : offsets(p.arrayOffsets, p.arrayOffsetType, count), nE = ao ? ao[count] : cp.count! * count;
		const vals = typed(u8, T, nE * per);
		return Array.from({ length: count }, (_, r) => { const a = ao ? ao[r] : r * cp.count!, b = ao ? ao[r + 1] : (r + 1) * cp.count!; return nd(Array.from({ length: b - a }, (_, k) => one(vals, (a + k) * per))); });
	}
	const vals = typed(u8, T, count * per);
	return Array.from({ length: count }, (_, r) => one(vals, r * per));
}
// b3dm の batch table（JSON）＝配列の列だけ（binary 参照 { byteOffset, componentType, type } は bin 付きで読む）。→ property table と同じ形
export function batchTableOf(json: Record<string, unknown> | null | undefined, bin: Uint8Array | null | undefined, count: number): PropertyTable | null {
	if (!json || !(count > 0)) return null;
	const columns: Record<string, unknown[]> = {};
	for (const [k, v] of Object.entries(json)) {
		if (k === "extensions" || k === "extras") continue;
		if (Array.isArray(v)) { columns[k] = v.slice(0, count); continue; }
		if (v && typeof v === "object" && (v as { byteOffset?: number }).byteOffset != null && bin) {
			const T = batchCtorOf((v as { componentType?: string }).componentType);
			const nc = NCOMP[(v as { type: string }).type] || 1; if (!T) continue;
			try { const a = typed(bin.subarray((v as { byteOffset: number }).byteOffset), T, count * nc); columns[k] = Array.from({ length: count }, (_, r) => nc === 1 ? a[r] : Array.from(a.subarray(r * nc, r * nc + nc) as ArrayLike<number | bigint>)); } catch { /* 短い＝落とす */ }
		}
	}
	return { name: "batchTable", class: null, count, columns };
}
// 行（地物の番号）→ 属性の素のオブジェクト
export function featureProperties(table: PropertyTable | null | undefined, id: number): Record<string, unknown> {
	if (!table || !(id >= 0) || id >= table.count) return {};
	const o: Record<string, unknown> = {}; for (const [k, col] of Object.entries(table.columns)) o[k] = col[id];
	return o;
}
