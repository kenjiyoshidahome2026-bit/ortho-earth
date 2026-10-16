// 3D Tiles 1.1 の metadata（tileset・group・tile・content）を schema で読む純関数（2026-10-16・DOM なし＝node の検定 tests/tiles3d-implicit.mjs が読む）。
//   JSON の実体（tileset.metadata・groups[]・tile.metadata・content.metadata）＝class の default・noData・normalized・offset／scale を当てる。
//   implicit の subtree＝propertyTables を EXT_structural_metadata と同じ解き方（mesh-features の decodePropertyTables）で列にし、
//   tileMetadata／contentMetadata の行＝そのタイルが available な中で何番目か（tiles3d-implicit の rankOf）。
//   意味（semantic）TILE_BOUNDING_BOX／REGION／SPHERE・TILE_MINIMUM／MAXIMUM_HEIGHT・TILE_GEOMETRIC_ERROR で境界と誤差を上書きする。
import { decodePropertyTables } from "./mesh-features.ts";
import type { PropertyTable, StructuralMetadata } from "./mesh-features.ts";
import type { BoundingVolume, Subtree } from "./tiles3d-implicit.ts";

/** schema の class の property（読む欄） */
interface SchemaProperty { type?: string; componentType?: string; array?: boolean; count?: number; normalized?: boolean; offset?: number | number[]; scale?: number | number[]; default?: unknown; noData?: unknown; semantic?: string }
/** 3D Metadata の schema（読む欄） */
export interface MetadataSchema { id?: string; classes?: Record<string, { name?: string; properties?: Record<string, SchemaProperty> }>; enums?: NonNullable<StructuralMetadata["schema"]>["enums"] }
/** metadata の実体（tileset.metadata・groups[]・tile／content の metadata の JSON） */
export interface MetadataEntityJson { class?: string; properties?: Record<string, unknown> }
/** 読んだ metadata の実体＝class と値（値は default を補い、normalized・offset／scale を当てた物） */
export interface MetadataEntity { class: string | null; properties: Record<string, unknown> }

const NORM_MAX: Record<string, number> = { INT8: 127, UINT8: 255, INT16: 32767, UINT16: 65535, INT32: 2147483647, UINT32: 4294967295, INT64: 9223372036854775807, UINT64: 18446744073709551615 };
const transform = (v: unknown, p: SchemaProperty, i = 0): unknown => {   // 1 成分＝normalized → scale → offset（数でなければそのまま）
	if (typeof v !== "number") return v;
	if (p.normalized && NORM_MAX[p.componentType!]) v = Math.max(v / NORM_MAX[p.componentType!], -1);
	const sc = p.scale, of = p.offset;
	if (sc != null) v = (v as number) * (Array.isArray(sc) ? (sc[i] ?? 1) : sc);
	if (of != null) v = (v as number) + (Array.isArray(of) ? (of[i] ?? 0) : of);
	return v;
};
/** JSON の実体を schema で読む（schema に無い class なら値をそのまま） */
export function entityOf(json: MetadataEntityJson | null | undefined, schema: MetadataSchema | null | undefined): MetadataEntity | null {
	if (!json) return null;
	const cls = json.class != null ? schema?.classes?.[json.class] : undefined, raw = json.properties || {};
	if (!cls) return { class: json.class ?? null, properties: { ...raw } };
	const out: Record<string, unknown> = {};
	for (const [name, p] of Object.entries(cls.properties || {})) {
		let v = Object.prototype.hasOwnProperty.call(raw, name) ? raw[name] : undefined;
		if (v === undefined || (p.noData !== undefined && JSON.stringify(v) === JSON.stringify(p.noData))) { if (p.default !== undefined) out[name] = p.default; continue; }   // default は変換しない（仕様）
		if (p.type !== "ENUM" && p.type !== "STRING" && p.type !== "BOOLEAN") v = Array.isArray(v) ? v.map((x, i) => Array.isArray(x) ? x.map((y, j) => transform(y, p, j)) : transform(x, p, p.array ? 0 : i)) : transform(v, p);
		out[name] = v;
	}
	return { class: json.class!, properties: out };
}

/** subtree の property table（初回に解いて subtree に覚える） */
const tablesOf = new WeakMap<Subtree, PropertyTable[]>();
export function subtreeTables(st: Subtree, schema: MetadataSchema | null | undefined): PropertyTable[] {
	let t = tablesOf.get(st);
	if (!t) {
		const warnings: string[] = [];
		t = st.json.propertyTables?.length && schema ? decodePropertyTables({ schema, propertyTables: st.json.propertyTables } as StructuralMetadata, v => st.bytesOf(v), warnings) : [];
		if (warnings.length) console.warn("[tiles3d] subtree metadata", warnings.join("; "));
		tablesOf.set(st, t);
	}
	return t;
}
/** property table の 1 行 → 実体（範囲外は null） */
export function rowEntity(t: PropertyTable | undefined, row: number): MetadataEntity | null {
	if (!t || row < 0 || row >= t.count) return null;
	const properties: Record<string, unknown> = {};
	for (const [k, col] of Object.entries(t.columns)) properties[k] = col[row];
	return { class: t.class, properties };
}

/** 実体から境界と誤差の意味（semantic）を拾う */
export interface TileSemantics { box?: number[]; region?: number[]; sphere?: number[]; minH?: number; maxH?: number; ge?: number }
export function semanticsOf(e: MetadataEntity | null, schema: MetadataSchema | null | undefined): TileSemantics | null {
	const props = e?.class != null ? schema?.classes?.[e.class]?.properties : undefined;
	if (!e || !props) return null;
	const s: TileSemantics = {};
	const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined, arr = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(x => typeof x === "number") ? v as number[] : undefined;
	for (const [name, p] of Object.entries(props)) {
		const v = e.properties[name];
		switch (p.semantic) {
			case "TILE_BOUNDING_BOX": s.box = arr(v, 12); break;
			case "TILE_BOUNDING_REGION": s.region = arr(v, 6); break;
			case "TILE_BOUNDING_SPHERE": s.sphere = arr(v, 4); break;
			case "TILE_MINIMUM_HEIGHT": s.minH = num(v); break;
			case "TILE_MAXIMUM_HEIGHT": s.maxH = num(v); break;
			case "TILE_GEOMETRIC_ERROR": s.ge = num(v); break;
		}
	}
	return Object.values(s).some(v => v !== undefined) ? s : null;
}
/** 意味で境界と誤差を上書き（box → region → sphere の順で 1 つ・高さは region にだけ効く） */
export function applySemantics(bv: BoundingVolume | null, ge: number, s: TileSemantics | null): { bv: BoundingVolume | null; ge: number } {
	if (!s) return { bv, ge };
	let out: BoundingVolume | null = s.box ? { box: s.box } : s.region ? { region: s.region } : s.sphere ? { sphere: s.sphere } : bv;
	if (out?.region && (s.minH !== undefined || s.maxH !== undefined)) { const r = [...out.region]; if (s.minH !== undefined) r[4] = s.minH; if (s.maxH !== undefined) r[5] = s.maxH; out = { region: r }; }
	return { bv: out, ge: s.ge ?? ge };
}
